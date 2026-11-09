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
as `src/ao` does (`AO_RUN_FILE`, `AO_PORT`). Knobs for process tests: `SWITCHYARD_PLANNER_POLL_MS` (periodic
check of running tasks and a scheduling pass; default 10 s), `SWITCHYARD_PLANNER_USAGE_EVERY_MS` (default 5 min),
`SWITCHYARD_PLANNER_CLOCK_FILE` (test clock: the planner's `now` is real time plus the milliseconds in that file,
re-read every 100 ms; the planner sees the jump on its next periodic pass).

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
  mode?: "ask" | "edits" | "plan" | "auto";   // permission mode of a session the planner starts (default auto); enforced by the Switchyard omp extension's gate
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
- **Worktrees** (user decision Q1): every git task runs in an AO worktree, there is no option: `cwd` inside a git
  repo → AO project session for that repo (registered on first use); AO gives every project session its own
  worktree and branch `ao/<slug>/root`, so parallel tasks never share a checkout. Outside git → standalone
  session (AO scratch dir). (`worktree` and `approvalMode` are no longer task options: unknown option fields are ignored.)
- **User defaults** (MAPPING D7): for a session the planner *starts*, a model or mode that neither the task, its lane
  nor `PlannerConfig.defaults` names comes from `<switchyard home>/config.json` (`model`, `mode`; the file
  `switchyard config set` writes), read at every dispatch; else AO's/omp's default model and mode `auto`. A
  continued session keeps its own model and mode.
- **Dispatch of a new session = MAPPING D11, `src/ao/spawn.ts`** (one idempotent call keyed by the task's
  `clientRequestId`/`clientMessageId`, so a replay after a crash finds the same session and turn): spawn in AO's
  `bypass-permissions` with no prompt and no model; the model is checked against the **session's own**
  config-options choices (the omp catalog is inexact: 3768 ids, 32 for the configured providers, 53 offered,
  so the planner has no pre-check of its own), then set, then thinking;
  the permission mode is set (`options.mode`, default `auto`; the mode file is written before the first
  message); the task goes out as a message. A refusal (unknown model or thinking level) fails the task without a retry and
  removes the session before the prompt. On a continued session the model is set directly and AO's error fails the task. A task whose agent then asks (a mode `ask`, or a question) stays `running`, and AO shows
  the session as needing input until a person answers through AO.
- **Continued sessions** (lane or re-run): `resume-agent` first when the session reads `exited`; model and
  thinking are set before the prompt and put back after the turn; `mode` applies to new sessions only. A
  `CHAT_CONTROLLER_NOT_READY` on send resumes the agent and sends once more.
- **Limit replies and dead hosts**: omp reports a provider limit it gave up retrying as a *completed* turn
  whose reply is the error (G35); a short reply that opens like a provider limit error holds the provider
  (until the stated reset, else backoff) and the task goes back to pending without using an attempt. Any other provider error omp ends as a completed reply (`Error: …`, a status code and JSON body, "No API key found", …; heuristic on
  short replies) fails the run and the retry rules apply. A turn still `running` in a session that reads `exited` (host died, G39) ends the
  run as `interrupted`: noticed from AO's events, and by asking AO every 10 s when none came.

## Operations

| op | args | result |
|---|---|---|
| `ping` | – | `{pid, version, root, startedAt, api: 1}` |
| `plan` | `{lane?: string, all?: boolean}` (`all`: include done tasks older than 7 days) | `PlanView` |
| `edit` | `{ops: PlanOp[], rev?: number}` | `{rev, refs: Record<string,string>}` (refs → new ids) |
| `getQueue` | `{id}` (lane id or AO session id) | `TaskQueue` view of the lane (old shape + `after?` per task) |
| `queue` | `{id, ops: QueueOp[]}` (old ops + `after`, `requeue`) | same `TaskQueue` view |
| `sync` | `{id, rerun?}` (task id or AO session id) | `{task, rerun, edges: EdgeView[]}`: propagates now **and answers when done** (commit the worktree, merge into the children); with `rerun` it queues the "re-run with parent changes" run instead (`edges` = the state at that moment) |
| `scheduler` | `{set?: Partial<PlannerConfig>, clearLimits?: true \| string[]}` | `PlannerStatus`. `clearLimits`: forget the provider limits learned from failed turns (`true` = all, or the named providers; others stay); held work starts at once. `set.budget` replaces the whole budget object (read-modify-write to change one window) |
| `status` | – | `PlannerStatus` |
| `shutdown` | – | `{}` |

`edit` is atomic: every op is validated first; any error (unknown id, cycle, running task) rejects
the whole batch with a message naming the problem (cycles name the path). `rev` (optional) rejects the
batch when the plan changed since (`error: "stale rev N"`).

```ts
interface EdgeView { parent: string; parentSession?: string; child: string; childSession?: string; state: "in-sync"|"pending"|"merged"|"upstream-changed"|"resolving"|"conflict"; files?: string[]; parentHead?: string; childHead?: string; at: number }   // derived from Task.sync
interface PlanView { rev: number; edges: EdgeView[]; tasks: TaskView[]; lanes: LaneView[]; recurring: Recurring[]; status: PlannerStatus }
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

Lane ops (`id` = lane id): `lane.add {id?, title?, session?, priority?, defaults?, autoRun?, ensure?}` (explicit: the lane is armed unless `autoRun:false`; an existing id refuses the whole batch with `lane X exists`, or with `ensure:true` does nothing and the `ref` still names it; a lane made *implicitly*, by a task's or schedule's `lane` naming an unknown id, starts **paused** like an old queue),
`lane.update {id, title?, priority?|null, defaults?}`, `lane.remove {id}` (removes its non-running
tasks), `lane.pause {id}`, `lane.resume {id}` (autoRun on), `lane.startAt {id, at: number|null}`,
`lane.requeue {id}` (old `requeueOps`), `lane.retryFailed {id}`, `lane.clearDone {id}`,
`lane.complete {id, completed: boolean}`: the mark clears itself when a task of the lane starts, and when a person types a prompt (not a `/command`) into the lane's session while no planner task runs there (PARKED §5).

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

0. **Explicit branch, followed by HEAD.** Every git task is spawned with an explicit `branch` (roots included:
   `switchyard/<task id>`, `-2`, `-3`… when an earlier session of the task still has it checked out). Without one
   AO renames the session branch (`ao/<slug-of-prompt>/root`) shortly after start, which races with the agent's
   first commit (test-infra: 3 of 8 runs failed to commit; 24/24 clean with an explicit branch). The planner
   takes the worktree path from AO (`workspacePath`) and reads the branch from the worktree's HEAD whenever it
   works with it, so a rename later on is followed.
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

**Sessions as task refs.** Wherever an op takes a task id (`after`, `sync`, `rerun`, `update`, …) an AO session
id works too: it stands for the task running in that session, else the one that ran in it last. A client
that only knows sessions needs no lookup.

**Sessions that exist before their task** (`new --task` spawns the session first, then `queue {id: session}`):
the branch can't be seeded, so before the prompt goes out the planner records the session's branch as the
task's and *merges* each done git parent's committed head into that worktree (edge `merged`, the upstream
note leads the prompt; a conflict gives the `resolving` edge and the resolve note). Put `after` in the same
`queue` call as the `add` (it applies to tasks added earlier in the call) and arm the lane after it.

**Ops.** `sync {id}`: commit what the task's worktree holds now and propagate to its children (also done
automatically when a finished task's session goes idle after somebody worked in it). `rerun {id}`
("Re-run with parent changes"): the task runs once more in its own session with only the upstream note
(`followUpOnly`); when that run completes its `upstream-changed` edges become `merged`. `requeue`/`run`
instead run the whole task again (and leave edges as they are). On a `conflict` edge `rerun` asks the agent to merge
the parent's branch itself and sets the edge `resolving`; the run's end settles it to `merged` or back to `conflict`.

**Events** (`subscribe {topic:"plan"}`): every edge transition is `{event:"sync", child, parent, from?, to, edge}`
(`from` absent for a new edge); the plan snapshot carries the edges in `TaskView.sync`.

`EdgeSync = { state: "in-sync" | "pending" | "merged" | "upstream-changed" | "resolving" | "conflict"; head?; pendingHead?; prompt?; files?; before?; after?; at }`.

## "What this task changed", and branch cleanup

AO's diff for a child is against the default branch, so it lists the parents' commits too. `Task.git.base` is the
branch head after the parents were merged in and before the task's first run (new session: the seeded tip; existing
session: the worktree head after the parents' merge; absent for a root task in a session the planner created, where
AO's diff is exact). `git diff base..head` = what the task changed (`head`: after its last turn).

AO never deletes the branches of its sessions. When a task is **removed** from the plan, the planner deletes its
`switchyard/*` branch, but only when every commit on it is still reachable from another branch (a parent's,
`main`…) and nothing has it checked out; a branch with work of its own stays (the log says "kept branch").
Branches the planner did not create are never touched.

## Graphs through sessions a client spawned first (the CLI's `new --task`)

A task dispatched into an **existing** session (its lane is the session) is tracked in git like a planner-spawned
one: the planner records the session's repo, branch and worktree before the first run, merges the parents' committed
heads into that worktree first (edges `merged`/`conflict`), and after the turn commits the work and records the head,
so its own children merge it in turn. `after` may name session ids, so a graph made only of `queue {id: <session>}`
calls (`queue {add, after [<session>], autoRun}`) propagates exactly like one the planner spawned. Sessions outside a
git repository are not tracked.

## Chat hibernation (G28)

AO keeps `chatHibernationEnabled` in memory only (false after every daemon boot). When `<switchyard home>/config.json`
has `"hibernation": "on"` (or `"off"`), the planner applies it through `AoClient.applyChatHibernation()` on every
(re)connect to AO's event stream (writing only when AO differs); with the key absent it leaves AO alone. A failure
is logged and never stops the planner. A send to a hibernated session returns `queued` and runs after the wake:
the planner follows the turn as for any other.

## Checkpoints (undo/redo with files)

- `Task.turn`: the AO turn id of the task's latest run, kept after it finishes (key for "this task's changes" and
  "undo this task"); `Task.session` is its session.
- `/undo` and `/redo` are human turns in AO. They are never task turns (the planner finds its own turn by its
  `clientMessageId`), and activity that is just `/undo`/`/redo` does not trigger a branch sync.
- `Task.undone` / `TaskView.undone`: a person undid the finished task's turn, so its work is gone; the task keeps
  its `done` status (no automatic re-run) but stops satisfying `after` for dependents that have not started
  (they show `blocked`). Redoing clears it. Set by the planner when `PlannerOptions.undone(task)` says so; asked
  on activity in the task's session for tasks others still wait on.
- `requeue {id, clean: true}`: before the retry is sent, `PlannerOptions.rewind(task)` undoes the earlier attempt's turn
  (files and context). Refused when a later task of the same session exists (undo would rewind it too), when the
  task has no earlier turn, and failed at dispatch with a clear message when the planner has no `rewind` hook.
- The two hooks are supplied by the process: `main.ts` passes `...checkpointHooks()` (`src/planner/checkpoint-hooks.ts`,
  from ao/checkpoints: `turnStatuses` for `undone`, `planUndo` + `runCheckpointCommand` for `rewind`; an undo that
  would overwrite changes is refused, never forced).
- The permission mode of a session the planner starts is set through checkpoints' `setSessionMode` (G40), never by
  writing the mode file.

## Events (`subscribe {topic: "plan"}`)

**Ordering:** the plan event of a change is sent *before* the response of the request that made it (same connection and every subscriber), so a client's cached plan is never older than the answer it just got (`edit` answers `{rev, refs}`; the event's `plan.rev ≥ rev`).

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
`budget`. The provider of a task is the prefix of its effective `model`; a task without a model (none on the task,
its lane or `PlannerConfig.defaults`) has no known provider and is gated by the budget only: set `defaults.model`
to gate such tasks (and `usage: "spare"` ones) on a provider. A task is `held` while its provider is limited, any of its windows is ≥
`holdAtPercent`, or a budget cap is reached; a `usage: "spare"` task also waits until every window of
its provider is < `spareBelowPercent`. `waitUntil` is the earliest known reset. `OMP_PLANNER_USAGE=off`
disables the omp poll.

## Changelog

- 2026-11-09: `Task.git.base`; removed tasks delete their reachable `switchyard/*` branches.
- 2026-11-09: no planner-side model pre-check (the spawn helper checks the session's own choices).
- 2026-11-09: implicit lanes start paused; `lane.add {ensure}`; the plan event precedes the response.
- 2026-11-09: `scheduler {clearLimits}`; the lane's completed mark clears on new work or a person's prompt.
- 2026-11-09: wire op `sync {id, rerun?}` (answers when propagation is done) and `PlanView.edges` (EdgeView: parent/child tasks and sessions, state, files, heads, at).
- 2026-11-09: user decisions: no `worktree`/`approvalMode` task options (every git task runs in an AO worktree); new sessions start through `src/ao/spawn.ts` (D11) with `options.mode`.
- 2026-11-09: checkpoints: `Task.turn` kept, `undone`, `requeue {clean}`, hooks `undone`/`rewind`; `/undo`/`/redo` ignored for sync.
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
