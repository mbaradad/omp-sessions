---
name: switchyard
description: Start, queue, schedule and supervise oh-my-pi (omp) coding sessions that keep running in the background, using the switchyard CLI. Use when coding work should run as its own persistent omp session that the user can watch and steer (from VS Code, the terminal, their phone or Hermes), when queueing or scheduling coding tasks for later, or when checking on, answering or following up on existing omp sessions.
license: MIT
metadata:
  switchyard:
    managed-by: switchyard
  hermes:
    tags: [coding, agents, omp, background, kanban, scheduling]
    category: autonomous-ai-agents
---

# Switchyard

`switchyard` drives omp coding sessions that run in the background on this machine. The Agent Orchestrator (AO) daemon runs them (`omp acp` in a host process of its own per session); the switchyard planner starts queued and scheduled work. A session keeps working after you (the calling agent) exit, with no editor open, and across SSH drops. The user sees the same sessions in VS Code (the Switchyard extension), in the terminal, in the AO phone app and in Hermes, so anything you start here is visible to them, and they can step in.

Use it to hand coding work to omp instead of doing it inline: one session per task, in the repository it concerns. Then come back for the result.

## Before you start

- Run `switchyard status --json` once: it says whether the AO daemon (`ao`) and the planner (`server`) run, whether AO can run omp (`omp.readiness`), the default model, sessions by state and any problems (`ok: false` with `problems`). If the command is missing, ask the user to install it: *omp: Install switchyard Command* in VS Code (it goes to `~/.local/bin`, or `%LOCALAPPDATA%\switchyard` on Windows), or the standalone package from the GitHub release.
- Sessions run on this machine, for the folder you give. Use absolute paths. A folder in a git repository runs in that repository's AO project, and AO gives every session **its own git worktree and branch** (`ao/<session>/root`): the session's `cwd` in `--json` output is that worktree, not your checkout, and its changes reach your checkout only when someone merges that branch. A folder outside git runs in a scratch folder AO creates. `switchyard projects --json` lists the AO projects (`[{path, name, id, lastUsed, sessions}]`, newest first), which helps when the user names a project rather than a path.
- Every command that takes `<session>` accepts the id, an id prefix, or words from the title. Ids are the safest choice.
- `--json` output is meant for you; the rest is for people.

## Start a session

```sh
switchyard new /abs/path/to/repo -p "Fix the flaky checkout test. Run the test suite before you finish." \
  --title "Fix flaky checkout test" --tag ticket:ENG-142 --json
```

This prints `{"id": "...", "started": true, "title": "...", "cwd": "..."}` and returns right away (`cwd`: the session's worktree). The session keeps working in the background. Ids look like `<project>-<n>`, e.g. `myrepo-3`.

- `-p -` reads the prompt from stdin, which is better for long prompts.
- Leave out `--mode` unless the user asked for a specific permission mode: the session then starts in the user's default (`switchyard config get mode`), else in `auto`. AO runs every session without its own prompts and the Switchyard omp extension's gate asks instead, so `ask`, `edits` and `plan` work only where that extension is installed (`switchyard status --json`: `omp.extension.installed`); `new --mode ask|edits|plan` fails (exit 1, nothing started) without it. `switchyard omp-extension [status|install|uninstall] [--json]` manages it (and the shim for omp flags); `new`, `resume`, a `send` that wakes a stopped session, `queue run` and `status` install or refresh it by themselves when this build ships it, unless `config set omp-extension off`. The modes:
  - `auto` approves every tool call;
  - `edits` applies file edits but asks before every command (bash included);
  - `ask` asks before every tool call;
  - `plan` is read-only: edits are refused and the model writes a plan.
  - Never pick `edits` or `ask` for unattended work on your own: it waits at the first command for someone who isn't watching.
- Flags after a bare `--` go to omp itself for this session (`new <dir> -p "…" --json -- --advisor plan`, put every Switchyard flag before the `--`); they need Switchyard's omp shim (`omp.shim.installed`). Machine-wide ones: `config set omp.extraArgs -- --profile work`.
- `--tag` (repeatable) labels the session, e.g. with the ticket or card it works on. The user can filter by tag.
- `--group <name>` files the session under a group in VS Code, created if missing. Use it to keep related work together, e.g. one group per board or project.
- `--model provider/id` picks the model (`switchyard models --json` lists the models a running session's omp offers, `source` says which session; with no session running the list is empty and `note` says so). Without it the session uses the user's default (`switchyard config get model`), then omp's own default. `--priority urgent|high|normal|low` matters for queued work.
- Write the prompt the way you would brief a colleague: the goal, the constraints, how to verify, and what to report at the end. The session can't see your conversation.

## Queue or schedule work

Queued work starts when a global concurrency slot is free. Scheduled work starts at a time you give. Both run with no editor open; the switchyard planner starts them, and it starts on demand (`switchyard server status` shows it).

```sh
# New session holding a queued task with subtasks; starts when a slot frees up
switchyard new /abs/repo --task "Upgrade dependencies" --sub "bump express to v5" --sub "run the tests" --json
# Same, but not before 02:00 (also +30m, +2h, or an ISO time)
switchyard new /abs/repo --task "Nightly flaky-test hunt" --at 02:00 --json
# A long brief goes in the task's notes (stdin with -); the title stays short
switchyard new /abs/repo --task "Migrate the config loader" --notes - --group lightscale --json < brief.md
# Add a task to an existing session's queue and start the queue (--notes - reads the full brief from stdin)
switchyard queue <session> add "Write the changelog entry" --notes - --run < brief.md
switchyard sched set 2      # at most 2 queued tasks run at once, across all sessions
```

The queue runs its tasks one by one. A failed task pauses the queue: `switchyard queue <session>` shows it, and `switchyard queue <session> retry` retries. `switchyard queue <session> at <when|off>` reschedules or cancels a start time; `switchyard stop` on a scheduled session cancels its start.

More planning controls:

- **Dependencies:** `switchyard new /abs/repo --task "Integrate" --after <session> --after <other>` (or `queue <session> after <s>…|off`) holds the queue until those sessions have finished. Self-dependencies and cycles are refused.
- **Requeue:** `switchyard queue <session> requeue` runs it again: failed tasks go back to pending, else a paused or interrupted queue restarts, else the last finished task runs again.
- **Completed:** `switchyard complete <session>` marks a finished session as done (a ✓ in `ls`/`show`; `completed`, `completedAt` in `--json`); `uncomplete` reopens it. It doesn't stop queued work.
- **Graph changes:** in a git repository a session that waits for others starts from their commits, and when a parent's work changes later, it is merged into the children. `switchyard plan status [--json]` lists the edges (`in-sync`, `pending`, `merged`, `upstream-changed`, `resolving`, `conflict`); `show --json` has `upstream` (the edges into that session, as `plan status` prints them) and `upstreamState` (the worst of their states) for a session. `upstream-changed` means a finished child got the new changes but was not re-run: `switchyard plan sync <session> --rerun` runs it again with them. `conflict` needs a person: the child agent was asked to resolve the merge and couldn't.
- **Usage:** queued work is held, not failed, while its provider is rate- or usage-limited (the planner learns the reset from the provider's error, else backs off 5 min doubling to 2 h) or its usage window from `omp usage` is at `sched usage hold <percent>`; it starts by itself at the reset. A task added with `--usage spare` starts only while every usage window of its provider is below `sched usage spare <percent>`. `sched budget <hour|day|week> <usd|off>` caps what queued work may spend in a rolling window (the cost of finished planner-dispatched turns; chats you drive yourself are not counted). A held session shows state `queued` with `waitReason` (e.g. `rate-limit anthropic until 14:05`, `budget day 21.50/20 USD`) and `waitUntil` in `show --json`, and `held:` in `ls`/`show`; `switchyard sched` lists the limits, windows and spend, `switchyard sched limits clear [provider…]` forgets a limit so held work starts now. Tell the user when their work is held instead of retrying it yourself.

If the machine reboots or the planner restarts, queued work that hadn't started yet is started again by the planner. A task that was cut short is marked `interrupted` and its queue pauses: it is never rerun on its own. Tell the user, or run it again deliberately with `switchyard queue <session> run` (or reschedule it with `queue <session> at <when>`).

## Wait for a session and read the result

```sh
switchyard wait <session> --timeout 2h --json
```

This blocks until the session has nothing left to do on its own, then prints a session report. The exit code tells you why it stopped waiting:

| Exit | State | Meaning |
| --- | --- | --- |
| 0 | `idle` | The turn finished and nothing is queued. Read `reply`. |
| 3 | `needs_input` | A question or approval is waiting; see `question`. |
| 4 | `stopped` / `interrupted` | The omp process is gone; see `exitReason`. Resume with `switchyard resume <session>`. `interrupted`: a crash or reboot cut a queued task short. |
| 5 | `scheduled` | It waits for its start time; nothing happens until then. |
| 124 | – | The timeout passed while the session was still working. Wait again later. |

`switchyard show <session> --json` prints the same report without waiting. Its fields:

- `id`, `title`, `cwd` (the session's worktree), `project` (AO project id), `branch`, `tags`, `mode`, `model`, `cost` (USD so far), `changedFiles` (files changed in its worktree, against the project's default branch: for a task that waits for others, `changedFilesIncludeUpstream: true` says the count includes what its parents merged in, so it is not "what this task changed");
- `state`: queued, scheduled, starting, working, needs_input, interrupted, idle or stopped;
- `queue`: pending, running, done and total tasks;
- `question`: the waiting question, as `{id, kind, title, message?, options?, questions?}`; `kind` is `approval` (a tool asks for permission), `select`, `confirm`, `input` or `ask` (omp's ask tool: one entry per question in `questions`);
- `reply`: the last thing the agent said, in full. While AO has not finalized the last turn's reply (it completed but the assistant message is missing or still streaming) `reply` is absent and `replyPending` is true instead: `wait` holds a few seconds for it, and never take the previous turn's text as this turn's result. A turn with no assistant text (tool-only, failed) has no `reply`;
- `exitReason`.

`switchyard ls --json` lists running sessions and sessions with work ahead (`--all` adds finished ones). Narrow it with `--project`, `--cwd`, `--group`, `--tag` or `--state <state>` (matches `state` exactly). `switchyard tail <session> -n 30` shows recent history as text.

Don't call `show` in a tight loop. `wait` already polls cheaply and handles the moment between sending a prompt and the session picking it up.

## Follow up

```sh
switchyard send <session> "Also add a regression test."   # while it works: runs after the current turn
switchyard send <session> "Stop, use the other API." --steer   # redirects the current turn instead
switchyard wait <session> --json
```

`send` resumes a stopped session first. A `send` while the session works waits for the turn to end (AO queues it).

## Questions and approvals

When `state` is `needs_input`, the session waits for an answer. Answer only what you were asked to decide. Otherwise tell the user: they are notified in VS Code, on their phone and in Hermes, and can answer there. Pass `--question <id>` (from `show --json`) so the answer is refused if a different question has come up meanwhile.

```sh
switchyard answer <session> 1            # approval or select: option number or exact option text
switchyard answer <session> yes          # confirm: yes / no
switchyard answer <session> "staging"    # input: the text
switchyard answer <session> "2 | 1,3"    # ask: one answer per question, separated by |
switchyard mode <session> auto           # or switch the permission mode (see below)
```

`question.approval` (boolean) in `show`/`wait --json` says whether the question is a tool approval (true) or a question an agent may answer (false); an approval is never yours to answer unless the user said so. Tool approvals are `approval` questions titled with the tool call (e.g. the command), with the options "Allow once", "Always allow", "Reject" and "Always reject" (`Allow tool: <name>` `select` questions with "Approve" and "Deny" also occur). Never approve destructive commands (deleting data, force-pushing, touching production) unless the user explicitly asked for exactly that.

`mode <session> <mode>` switches right away, also mid-turn: the gate reads the session's mode at its next tool call. `show --json` and `ls --json` report it as `mode` (`meta.permissionMode`), `ask` included. Sessions started before the gate existed have no mode file: for those `plan` is live and the other modes restart omp on the same transcript (only while the session isn't working).

## Stop, resume, clean up

```sh
switchyard abort <session>      # interrupt the current turn; AO discards messages queued behind it: --json has them in `discarded` ([{turnId, text, requestedAt}]), send them again if still wanted
switchyard stop <session>       # end the omp process; the session, its worktree and transcript stay
switchyard resume <session>     # restart it on the same transcript
switchyard rm <session> -y      # delete the session, its worktree and history (only ones you created and no longer need;
                                  # AO refuses while its worktree holds uncommitted changes)
```

Idle sessions cost nothing. Leave finished sessions for the user to review unless they asked you to clean up.

## Working in parallel

- Each session already gets its own AO worktree and branch, so parallel sessions in one repository don't overwrite each other. Their work lands on their branches (`branch` in `show --json`), not in the user's checkout.
- Prefer queueing (`--task`) over starting many sessions at once. The global limit then keeps the machine and the bill in check.

## Hermes Agent

With the switchyard Hermes plugin installed (`switchyard hermes install`), a Hermes agent gets native tools for everything above: `switchyard_session_start`, `switchyard_session_status`, `switchyard_session_wait`, `switchyard_session_send`, `switchyard_session_answer`, `switchyard_session_mode`, `switchyard_session_model`, `switchyard_session_stop`, `switchyard_queue_add`, `switchyard_queue_schedule`, `switchyard_sessions_list`, `switchyard_projects_list`, `switchyard_models_list` and `switchyard_server_status`. Prefer the tools to shelling out. Approval dialogs stay with the user unless the plugin's `agent_approvals` setting is on. Hermes also gets a message in the chat when a session it started finishes or needs input, so there is no need to keep waiting on it.

The plugin can also run kanban cards as omp sessions. With the lane on (`hermes switchyard lane on --board <slug>`), a card assigned to `switchyard` is claimed by the lane. It runs as an omp session in the card's workspace, or in the board's configured folder, and its outcome goes back to the card:

```sh
hermes kanban --board <slug> create "Fix flaky checkout test" --assignee switchyard --workspace dir:/abs/repo --body "..."
hermes kanban --board <slug> assign <card-id> switchyard      # hand an existing card to Switchyard (not while it is running)
```

- On success the card is completed, with the session's final reply as the result. Child cards see it as their parent's result.
- If the session waits for an answer, the card is blocked as `needs_input` until someone answers, in VS Code, on the phone or with `switchyard answer`.
- A session that stops on an error blocks the card as `transient`; a task a crash or reboot interrupted blocks it too, and unblocking the card continues it in the same session.
- `--board` goes before the verb. `hermes switchyard status` shows the lane and its linked cards.

Use cards when the work belongs on a board with dependencies. Use the tools, or `switchyard new`, for one-off and scheduled tasks.

## From another machine

Sessions are AO sessions, so AO's HTTP API reaches them. On this machine it listens on loopback without auth (the port is in `~/.ao/running.json`, usually `http://127.0.0.1:3001`). From another machine, the user turns on AO's phone listener (`switchyard remote on`; `switchyard remote status` lists its addresses; `switchyard remote qr` pairs the AO mobile app) and the client sends AO's pairing password as `Authorization: Bearer <password>`. The main endpoints, under `/api/v1`:

- `GET /sessions`, `GET /sessions/<id>`, `GET /sessions/<id>/conversation` (messages, pending approvals and questions, usage)
- `POST /sessions` with `{projectId, harness: "omp", mode: "chat", kind: "worker", prompt, displayName, approvalMode}`
- `POST /sessions/<id>/conversation/messages` with `{text}`; `.../steer-or-send` with `{text, clientMessageId}` to steer
- `POST /sessions/<id>/conversation/approvals/<requestId>/resolve` with `{decisionId}`; `.../inputs/<requestId>/resolve` with `{action, content}`
- `POST /sessions/<id>/conversation/interrupt`, `/sessions/<id>/exit-agent`, `/sessions/<id>/resume-agent`
- `GET /events`: Server-Sent Events that say which session changed (send `Last-Event-ID` to resume)

Queued and scheduled tasks belong to the planner, which has no HTTP API: use `switchyard` on this machine for those. Reference: AO's `backend/internal/httpd/apispec/openapi.yaml`.
