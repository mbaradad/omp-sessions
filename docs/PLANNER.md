# Planner API (Switchyard)

Status: **v1, implemented** on `ao/planner` (see the changelog). Changes get a dated line at the end.
Code: `src/planner/types.ts` (every type below), `src/planner/client.ts` (`PlannerClient`, `ensurePlanner`,
`stopPlanner`), `src/planner/paths.ts` (`socketPath`, `logPath`), `src/planner/service.ts` (service install).
Import only those from clients; never read `plan.json` directly.

## What the planner is

One headless per-user service (`out/planner.js`; systemd user unit `switchyard-planner.service`, launchd
`dev.switchyard.planner`; `node planner.js install|uninstall` sets the unit up). It owns **plans**: tasks, lanes (queues), dependencies, recurring
schedules, priorities, the global concurrency limit and usage gating. It dispatches ready tasks to AO
(through `src/ao`) and follows them through AO's SSE feed. It never runs agents itself.

Clients still read and drive **sessions** (chat, answers, stop, …) through AO via `src/ao`. A task
carries the AO session id it ran in (`task.session`), so a client can open the chat for a task.

## Transport

Same wire as the old server (`src/shared/server-protocol.ts`), so `ServerClient`-style code ports 1:1:

- Unix socket `<switchyard home>/planner/planner.sock` (mode 0600; falls back to `<tmp>/switchyard-<uid>/planner-<hash>.sock`
  for long paths). Windows: random named pipe recorded in `<switchyard home>/planner/planner.pipe`.
  Switchyard home = `$SWITCHYARD_HOME` or `~/.switchyard`; the plan is `planner/plan.json` there.
  `PlannerClient.connect()` resolves this.
- Newline-delimited JSON. Request `{id: number, op: string, args?: object}` →
  response `{id, ok: true, result}` | `{id, ok: false, error: string}`.
- `{op: "subscribe", args: {topic: "plan"}}` keeps streaming events `{id, event, …}` (below).

`ensurePlanner(script)` connects, or starts the planner (installed service for this home, else detached)
and waits for it. Env: `SWITCHYARD_PLANNER_STDERR=1` (log to stderr too), `SWITCHYARD_PLANNER_USAGE=off`
(no `omp usage` poll), `SWITCHYARD_PLANNER_OMP` (omp binary), `SWITCHYARD_PLANNER_RETRY_BASE_MS`; AO is found
as `src/ao` does (`AO_RUN_FILE`, `AO_PORT`).

## Model

```ts
type Priority = "urgent" | "high" | "normal" | "low";            // same as organize.ts
type TaskStatus = "pending" | "running" | "done" | "failed" | "skipped";   // same as QueueTaskStatus

interface TaskOptions {               // superset of QueueTaskOptions
  model?: string;                     // "provider/modelId"
  thinking?: string;                  // omp's levels: off|auto|low|medium|high|xhigh|max (`minimal` is read as `low`)
  freshContext?: boolean;             // new AO session instead of continuing the lane's session
  retries?: number;                   // automatic retries after failure/timeout (backoff 10s,20s,…≤5m)
  timeoutMinutes?: number;            // interrupt the turn → failed (or retried)
  cwd?: string;                       // folder to work in (planner maps it to an AO project)
  project?: string;                   // AO project id (wins over cwd)
  worktree?: "auto" | "always" | "never";   // see "Worktrees" below
  approvalMode?: "default" | "accept-edits" | "auto" | "bypass-permissions";
}

interface Task {                      // superset of QueueTask: same names, same meaning
  id: string; title: string; notes?: string;
  subtasks: { id: string; title: string; done: boolean }[];
  status: TaskStatus;
  createdAt: number; startedAt?: number; finishedAt?: number;
  summary?: string;                   // final assistant text, or the error
  options?: TaskOptions;
  attempts?: number; durationMs?: number; cost?: number;
  interrupted?: number;               // epoch ms: cut short by a crash/restart/kill; never re-run unattended
  // planner additions
  lane?: string;                      // lane id; absent = free task (own AO session, runs in parallel)
  after?: string[];                   // task ids this task waits for (graph edges parent → this)
  inputs?: "results" | "none";        // default "results": parents' summaries are appended to the prompt
  priority?: Priority;                // default: lane's priority, else normal
  startAt?: number;                   // not before (epoch ms)
  usage?: "normal" | "spare";         // "spare": only starts while provider usage leaves room (auto-scheduling)
  paused?: boolean;                   // held by a person
  session?: string;                   // AO session id it runs/ran in
  turn?: string;                      // AO turn id of the latest run (link task → chat)
  recur?: string;                     // id of the recurring schedule that created it
  git?: { repo: string; branch: string; worktree?: string; head?: string };   // its branch in AO's worktree (project sessions)
  sync?: Record<string, EdgeSync>;    // parent task id → propagation state (see "Graph propagation")
  followUp?: string;                  // note the next run starts with (upstream change merged / merge to resolve)
  followUpOnly?: boolean;             // the next run is only that note, not the whole task again
}

interface Lane {                      // a queue: its tasks run one at a time, in order
  id: string;                         // "l_…", or an AO session id for a session queue (see below)
  title?: string;
  session?: string;                   // AO session the lane continues (set by the first task, or given)
  autoRun: boolean;                   // false = paused (old TaskQueue.autoRun)
  startAt?: number;                   // arms autoRun at that time (old TaskQueue.startAt)
  priority?: Priority;
  defaults?: TaskOptions;             // options its tasks inherit (cwd, model, …)
  completed?: boolean; completedAt?: number;   // the "Completed" marker (PARKED §5)
  createdAt: number;
}

interface Recurring {                 // recurring starts
  id: string; title?: string; enabled: boolean;
  rule: { every?: number /* minutes ≥ 5 */; at?: string[] /* "HH:MM" local */; days?: number[] /* 0=Sun…6, with at */ };
  task: TaskInput;                    // template; each firing adds a copy (recur = this id)
  lane?: string;
  nextAt: number; lastAt?: number;
  skipIfRunning?: boolean;            // default true: no new copy while the previous one is pending/running
}

interface PlannerConfig {
  maxConcurrent: number;              // 0 = unlimited (old scheduler.json)
  paused: boolean;                    // global pause: nothing new is dispatched
  usage: { holdAtPercent: number /* 95 */; spareBelowPercent: number /* 60 */ };
  budget?: { hour?: number; day?: number; week?: number };     // USD caps on planner-dispatched spend
  defaults?: TaskOptions;
}
```

### Derived state (in every view, never stored)

`TaskView = Task & { state, blockedBy?, waitReason?, waitUntil?, position? }`, with `state`:

| state | meaning |
|---|---|
| `blocked` | pending; some `after` task is not done/skipped (`blockedBy` lists them; a missing id stays blocking) |
| `scheduled` | pending; `startAt` (task or lane) in the future (`waitUntil`) |
| `paused` | pending; task paused, lane `autoRun` off, or planner paused |
| `held` | pending; usage gate: provider limit, usage window, spend budget, or retry backoff (`waitReason`, `waitUntil`) |
| `waiting` | ready, waiting for a concurrency slot or for its lane/session (`position` 1-based in start order) |
| `interrupted` | pending with `interrupted` set: needs a person (`run`/`requeue`) |
| `running` / `done` / `failed` / `skipped` | as stored |

### Rules

- **Readiness**: pending, not paused, not interrupted, every `after` task `done` or `skipped`, `startAt`
  passed, lane armed and the task is the lane's first unfinished task, its session idle, usage gate open.
- **Order**: priority (urgent→low), then plan order (array order; `move` changes it), then creation.
- **Concurrency**: at most `maxConcurrent` running tasks overall; one per lane; one per AO session.
- **Results**: with `inputs: "results"` (default) the prompt gets each parent's title + summary.
- **Failure**: retried `options.retries` times with backoff; then `failed`, and its lane pauses
  (dependents stay `blocked` until the parent is requeued and succeeds, or the edge is removed).
- **Limits**: a turn that ends on a provider rate/usage-limit error puts the task back to pending
  (no attempt used) and holds that provider until the stated reset (else 5 min doubling ≤ 2 h).
- **Crash safety**: `running` is written to disk before the AO call (with an idempotency key). After a
  planner restart, running tasks are reconciled with AO: still running → followed; finished → recorded;
  unknown whether it was sent, or cut short → `interrupted` (lane paused). Nothing is dispatched twice.
- **Session lanes**: a lane whose id is an AO session id (`queue` op on a session) continues that
  session; tasks dispatch only while it has no turn running. A free task that runs again (requeue, `run`)
  continues its own session unless `freshContext` is set or AO no longer has it (then a new session starts).
- **Worktrees**: `cwd` inside a git repo → AO project session for that repo (registered on first use);
  AO gives every project session its own worktree and branch `ao/<slug>/root`, so parallel tasks never
  share a checkout (`auto` and `always` behave the same). `always` outside git fails the dispatch;
  `never` in a git folder fails it too (AO can't run in the checkout itself). Outside git → standalone
  session (AO scratch dir).
- **Approvals**: sessions the planner spawns start in `bypass-permissions` (MAPPING D11: an unattended
  task can't wait for an approval) unless `approvalMode` says otherwise (task, lane `defaults` or planner
  `defaults`). A task whose agent does ask (approval or question) stays `running`, and AO shows the session
  as needing input until a person answers through AO.
- **Dispatch sequence** (MAPPING D11, idempotent step by step; each step is written to the plan first):
  check the model against AO's list (unknown → the task fails at once, no session is left behind), spawn
  with no prompt (`clientRequestId`), set `thinking` through the session's config options, send the task
  as a message (`clientMessageId`). A continued session first gets `resume-agent` when it reads `exited`,
  and model/thinking are put back after the turn. A `CHAT_CONTROLLER_NOT_READY` on send resumes the agent
  and sends once more.
- **Limit replies and dead hosts**: omp reports a provider limit it gave up retrying as a *completed* turn
  whose reply is the error (G35); a short reply that opens like a provider limit error holds the provider
  (until the stated reset, else backoff) and the task goes back to pending without using an attempt. A turn
  still `running` in a session that reads `exited` (host died, G39) ends the run as `interrupted`.

## Operations

| op | args | result |
|---|---|---|
| `ping` | – | `{pid, version, root, startedAt, api: 1}` |
| `plan` | `{lane?: string, all?: boolean}` (`all`: include done tasks older than 7 days) | `PlanView` |
| `edit` | `{ops: PlanOp[], rev?: number}` | `{rev, refs: Record<string,string>}` (refs → new ids) |
| `getQueue` | `{id}` (lane id or AO session id) | `TaskQueue` view of the lane (old shape + `after?` per task) |
| `queue` | `{id, ops: QueueOp[]}` (old ops + `after`, `requeue`) | same `TaskQueue` view |
| `scheduler` | `{set?: Partial<PlannerConfig>}` | `PlannerStatus` |
| `status` | – | `PlannerStatus` |
| `shutdown` | – | `{}` |

`edit` is atomic: every op is validated first; any error (unknown id, cycle, running task) rejects
the whole batch with a message naming the problem (cycles name the path). `rev` (optional) rejects the
batch when the plan changed since (`error: "stale rev N"`).

```ts
interface PlanView { rev: number; tasks: TaskView[]; lanes: LaneView[]; recurring: Recurring[]; status: PlannerStatus }
interface LaneView extends Lane { pending: number; running: number; done: number; failed: number; total: number }
interface PlannerStatus extends PlannerConfig {
  running: number; waiting: number; scheduled: number; held: number; blocked: number; interrupted: number;
  limits: ProviderLimit[];                                              // provider holds in force
  usageWindows: { provider: string; window: string; usedPercent: number; resetsAt?: number }[];   // omp usage
  spend: { window: "hour" | "day" | "week"; cap: number; spent: number; over: boolean; freesAt?: number }[];
  ao: { url?: string; connected: boolean; lastEventAt?: number; error?: string };
  version: string; startedAt: number;
}
```

### PlanOp

Task ops (`id` = task id):

| op | fields | notes |
|---|---|---|
| `add` | `task: TaskInput, ref?, index?` | `TaskInput` = Task fields a client may set: `title, notes?, subtasks?: (string\|{title,done?})[], lane?, after?, inputs?, priority?, startAt?, usage?, paused?, options?, done?`. `after` may name earlier refs of the batch as `"@ref"`. `index`: position within the lane (or among free tasks). A lane id that does not exist is created (session lane when it looks like an AO session id). |
| `update` | `id, title?, notes?, priority?\|null, startAt?\|null, usage?, inputs?, options?, lane?\|null` | `options` replaces; not allowed while running except title/notes/priority |
| `remove` | `id` | refused while running |
| `move` | `id, index` | position within its lane (or among free tasks) |
| `after` | `id, ids: string[]` | replaces dependencies; refuses self, unknown ids and cycles |
| `run` | `id` | run now: clears `paused`/`interrupted`/`startAt`, resets a finished task to pending, puts it first in its lane, arms the lane |
| `requeue` | `id` | failed/done/skipped/interrupted → pending (fresh run), keeps schedule |
| `pause` / `resume` | `id` | person hold on one task |
| `abort` | `id` | interrupts the running turn in AO → pending, paused (lane: paused), never `interrupted` |
| `done` / `skip` | `id` | mark without running (`done` satisfies dependents; so does `skip`) |
| `duplicate` | `id` | pending copy right after it |
| `sync` | `id` | re-check the task's git branch now (commit leftovers) and propagate to its children |
| `addSubtask` / `updateSubtask` / `removeSubtask` / `moveSubtask` | as `QueueOp` | |

Lane ops (`id` = lane id): `lane.add {id?, title?, session?, priority?, defaults?, autoRun?}`,
`lane.update {id, title?, priority?|null, defaults?}`, `lane.remove {id}` (removes its non-running
tasks), `lane.pause {id}`, `lane.resume {id}` (autoRun on), `lane.startAt {id, at: number|null}`,
`lane.requeue {id}` (old `requeueOps`), `lane.retryFailed {id}`, `lane.clearDone {id}`,
`lane.complete {id, completed: boolean}`.

Recurring ops: `recur.add {recurring: {title?, rule, task, lane?, skipIfRunning?, enabled?}, ref?}`,
`recur.update {id, …}`, `recur.remove {id}`, `recur.fire {id}` (add a copy now).

### Compatibility (`queue` / `getQueue`)

A lane is addressed by its id **or by its AO session id** (`getQueue`, `queue`, `plan {lane}`): the lane's
`session` is set when its first task is *dispatched* (the spawn answers), not when it ends. `QueueView`
and `LaneView` carry `state` / `waitReason` / `waitUntil` of the lane's next open task (first pending or
running): `running`, `waiting`, `scheduled` (start time in the future, `waitUntil`), `paused`, `held`,
`blocked`, `interrupted`; absent when nothing is left. `new --task` = `lane.add` + `add` (returns the lane
id); until `session` is set the lane's `state` is what a client reports for it. `stopWhenQueueDone` is
dropped (AO hibernates idle chats, G28); `PlannerStatus` has no such field.

`queue {id, ops}` accepts the old `QueueOp`s on lane `id` and maps them: `add/update/remove/move/
subtask ops/setOptions/duplicate` → task ops; `run {id?}` → `run` (or `lane.resume`); `autoRun {value}`
→ `lane.pause`/`lane.resume`; `schedule {at}` → `lane.startAt`; `retryFailed`, `clearDone` → lane ops;
plus `after {ids}` (PARKED §1, lane-level: every task of the lane waits for the given **tasks or
lanes**; a lane counts as finished when all its tasks are done/skipped) and `requeue` (PARKED §3).
`update {status}` maps to `done`/`skip`/`requeue`.

## Graph propagation (GRAPH-PROPAGATION.md)

**AO check (done).** Stock AO has no base-ref field and cannot run a session in a given worktree, but its spawn
field `branch` checks out an existing local branch (`gitworktree.addWorktree`; a branch checked out in another
worktree is refused). So the planner creates `switchyard/<task id>` at the parent's head and spawns on it
(GAPS G43, verified live with real omp). No fork. Git operations are `src/planner/git.ts`; the generic
helpers of `omp/worktrees` `worktree-git.ts` (`parseNameStatus`, `ChangedFile`, `conflictedFiles`) are ported
there; its worktree creation and `omp/` branches are superseded by AO's worktrees.

Applies to tasks that run in a git project (AO gives each such session its own worktree). A task with
other `cwd`/standalone sessions only receives its parents' results.

1. **One worktree per task.** A first-time task is spawned by AO on a branch the planner seeds: its first
   parent's committed head (`switchyard/<task id>`), further parents merged in a temporary worktree. AO
   checks that existing branch out for the session (`spawn.branch`). Roots use AO's own `ao/<slug>/root`.
2. **Committed before it propagates.** When a turn ends the planner commits what it left in the worktree
   (`switchyard: <title>` + `Switchyard-Task: <id>` trailer) and records `git.head`. A `done` git task
   unblocks its children only once that head exists.
3. **Any later change flows on.** When a parent's head changes (it re-ran, was requeued, or somebody worked
   in its session and it went idle; or `sync`), every child's edge `sync[parent]` becomes `pending`:
   - child **running**: untouched; when its turn ends the merge is applied, then it gets a follow-up run
     in its own session (`followUp`/`followUpOnly`: the upstream commits and files, "re-check your work");
   - child **idle/pending** (not started its next run): merged now, the note leads its next prompt;
   - child **done/failed**: merged, edge `upstream-changed`, **not** re-run (a person requeues it);
   - the child's own new head flows on to its children, transitively.
4. **Conflicts** abort the merge (no `MERGE_HEAD` left) and the child gets a run whose prompt says to run
   `git merge <parent branch>`, resolve and commit (edge `resolving`). After that run: merged → `merged`,
   else `conflict` (with `files`) and a person decides. Never `-X ours/theirs`, never a rebase or force.
5. **Safety.** One git operation per repo at a time; propagation steps are serialized; every step is
   idempotent (a merge whose target is already an ancestor is done), so a restart finishes a pending
   propagation exactly once; edges record `before`/`after` SHAs (undo by hand with `git reset`).

**Ops.** `sync {id}`: commit what the task's worktree holds now and propagate to its children (also done
automatically when a finished task's session goes idle after somebody worked in it). `rerun {id}`
("Re-run with parent changes"): the task runs once more in its own session with only the upstream note
(`followUpOnly`); when that run completes its `upstream-changed` edges become `merged`. `requeue`/`run`
instead run the whole task again.

**Events** (`subscribe {topic:"plan"}`): every edge transition is `{event:"sync", child, parent, from?, to, edge}`
(`from` absent for a new edge); the plan snapshot carries the edges in `TaskView.sync`.

`EdgeSync = { state: "in-sync" | "pending" | "merged" | "upstream-changed" | "resolving" | "conflict"; head?; pendingHead?; prompt?; files?; before?; after?; at }`.

## Events (`subscribe {topic: "plan"}`)

- `{id, event: "plan", plan: PlanView}`: first right after subscribing, then after every change
  (coalesced, ≤ 5/s).
- `{id, event: "task", task: TaskView, from: TaskStatus}`: each status transition (for sounds/notifications).
- `{id, event: "sync", child, parent, from?, to, edge}`: each graph propagation step (see "Graph propagation").

## Usage gating (auto-scheduling)

Sources: (1) limit errors from finished turns (AO turn `errorMessage`, plus `usageLimit.resetsAt` when AO
recognizes the message), recorded per provider until the stated reset, else 5 min doubling ≤ 2 h (ported
from `omp/autosched` `limits.ts`); (2) usage windows from `omp usage --json`, polled every 5 min (AO
reports account windows only for Claude/Codex accounts, never for omp sessions; with several accounts on
one provider the one with most room counts; tier-scoped windows are ignored); (3) spend of
planner-dispatched tasks (difference of AO's conversation `usage.cost` before/after the turn) against
`budget`. The provider of a task is the prefix of its effective `model`; a task without a model is gated
by the budget only. A task is `held` while its provider is limited, any of its windows is ≥
`holdAtPercent`, or a budget cap is reached; a `usage: "spare"` task also waits until every window of
its provider is < `spareBelowPercent`. `waitUntil` is the earliest known reset. `OMP_PLANNER_USAGE=off`
disables the omp poll.

## Changelog

- 2026-11-09: `rerun` op and `sync` events; AO check recorded; `worktree-git.ts` helpers ported.
- 2026-11-09: lanes resolve by session id; `lane.session` set at dispatch; `state`/`waitUntil` on `LaneView` and `QueueView`.
- 2026-11-09: draft v1.
- 2026-11-09: implemented on `ao/planner`. `status.usage` is `usageWindows`; worktree and approval
  rules spelled out; usage windows come from `omp usage`, not AO.
- 2026-11-09: dispatch follows MAPPING D11 (spawn without prompt, bypass-permissions default, model checked
  first); thinking levels are omp's (G42); limit replies (G35) and dead hosts (G39) handled.
- 2026-11-09: Switchyard identity (state in `$SWITCHYARD_HOME/planner`, `switchyard-planner.service`,
  `SWITCHYARD_PLANNER_*` env). New: Graph propagation (`sync` op, `Task.git/sync/followUp/turn`), a free
  task that runs again continues its own session.
