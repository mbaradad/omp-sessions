---
name: omp-sessions
description: Start, queue, schedule and supervise oh-my-pi (omp) coding sessions that keep running in the background, using the omp-vs CLI. Use when coding work should run as its own persistent omp session that the user can watch and steer from VS Code or their phone, when queueing or scheduling coding tasks for later, or when checking on, answering or following up on existing omp sessions.
license: MIT
metadata:
  omp-sessions:
    managed-by: omp-vs
  hermes:
    tags: [coding, agents, omp, background, kanban, scheduling]
    category: autonomous-ai-agents
---

# omp Sessions

`omp-vs` drives omp coding sessions that run in their own background process on this machine. A session keeps working after you (the calling agent) exit, after VS Code closes, and across SSH drops. The user sees the same sessions in VS Code (the omp Sessions extension) and in the omp phone app, so anything you start here is visible to them, and they can step in.

Use it to hand coding work to omp instead of doing it inline: one session per task, in the repository it concerns. Then come back for the result.

## Before you start

- Run `omp-vs ls --json`. If the command is missing, ask the user to run *omp: Install omp-vs Command* in VS Code, which puts it in `~/.local/bin`.
- Sessions run on this machine, in the folder you give. Use absolute paths. `omp-vs projects --json` lists the folders sessions ran in (`[{path, name, lastUsed, sessions}]`, newest first), which helps when the user names a project rather than a path.
- Every command that takes `<session>` accepts the id, an id prefix, or words from the title. Ids are the safest choice.
- `--json` output is meant for you; the rest is for people.

## Start a session

```sh
omp-vs new /abs/path/to/repo -p "Fix the flaky checkout test. Run the test suite before you finish." \
  --title "Fix flaky checkout test" --mode auto --tag ticket:ENG-142 --json
```

This prints `{"id": "...", "started": true, "title": "...", "cwd": "..."}` and returns right away. The session keeps working in the background.

- `-p -` reads the prompt from stdin, which is better for long prompts.
- `--mode` sets the permission mode:
  - `auto` approves every tool call;
  - `edits` applies file edits but asks before commands;
  - `ask` asks before every edit and command;
  - `plan` is read-only: edits are refused and the model writes a plan.
  - Without the flag, the session starts in the user's default.
  - Unattended work usually needs `auto` or `edits`, otherwise it stops at the first approval.
- `--tag` (repeatable) labels the session, e.g. with the ticket or card it works on. The user can filter by tag.
- `--group <name>` files the session under a group in VS Code, created if missing. Use it to keep related work together, e.g. one group per board or project.
- `--model provider/model` picks the model. `--priority urgent|high|normal|low` matters for queued work.
- Write the prompt the way you would brief a colleague: the goal, the constraints, how to verify, and what to report at the end. The session can't see your conversation.

## Queue or schedule work

Queued work starts when a global concurrency slot is free. Scheduled work starts at a time you give. Both run with VS Code closed, as long as the `omp-vs` server runs, and it starts on demand.

```sh
# New session holding a queued task with subtasks; starts when a slot frees up
omp-vs new /abs/repo --task "Upgrade dependencies" --sub "bump express to v5" --sub "run the tests" --json
# Same, but not before 02:00 (also +30m, +2h, or an ISO time)
omp-vs new /abs/repo --task "Nightly flaky-test hunt" --at 02:00 --json
# A long brief goes in the task's notes (stdin with -); the title stays short
omp-vs new /abs/repo --task "Migrate the config loader" --notes - --group lightscale --json < brief.md
# Add a task to an existing session's queue and start the queue
omp-vs queue <session> add "Write the changelog entry" --run
omp-vs sched set 2      # at most 2 queued tasks run at once, across all sessions
```

The queue runs its tasks one by one. A failed task pauses the queue: `omp-vs queue <session>` shows it, and `omp-vs queue <session> retry` retries.

## Wait for a session and read the result

```sh
omp-vs wait <session> --timeout 2h --json
```

This blocks until the session has nothing left to do on its own, then prints a session report. The exit code tells you why it stopped waiting:

| Exit | State | Meaning |
| --- | --- | --- |
| 0 | `idle` | The turn finished and nothing is queued. Read `reply`. |
| 3 | `needs_input` | A question or approval is waiting; see `question`. |
| 4 | `stopped` | The omp process is gone; see `exitReason`. Resume with `omp-vs resume <session>`. |
| 124 | – | The timeout passed while the session was still working. Wait again later. |

`omp-vs show <session> --json` prints the same report without waiting. Its fields:

- `id`, `title`, `cwd`, `tags`, `mode`, `model`, `cost` (USD so far), `changedFiles`;
- `state`: queued, starting, working, needs_input, idle or stopped;
- `queue`: pending, running, done and total tasks;
- `question`: the waiting dialog, as `{id, kind, title, message?, options?, questions?}`;
- `reply`: the last thing the agent said, in full;
- `exitReason`.

`omp-vs ls --json` lists all running sessions (`--all` adds stopped ones). `omp-vs tail <session> -n 30` shows recent history as text.

Don't call `show` in a tight loop. `wait` already polls cheaply and handles the moment between sending a prompt and the session picking it up.

## Follow up

```sh
omp-vs send <session> "Also add a regression test."   # steers the current turn if it is working
omp-vs send <session> "Next: update the docs." --follow-up   # waits for the current turn to end
omp-vs wait <session> --json
```

`send` resumes a stopped session first.

## Questions and approvals

When `state` is `needs_input`, the session waits for an answer. Answer only what you were asked to decide. Otherwise tell the user: they get a notification in VS Code and on their phone and can answer there.

```sh
omp-vs answer <session> 1            # select: option number or exact option text
omp-vs answer <session> yes          # confirm: yes / no
omp-vs answer <session> "staging"    # input: the text
omp-vs answer <session> "2 | 1,3"    # ask: one answer per question, separated by |
omp-vs mode <session> auto           # or switch the permission mode; waiting approvals resolve by the new mode
```

Tool approvals are `select` dialogs titled `Allow tool: <name>`. Their options include "Approve" and "Deny". Never approve destructive commands (deleting data, force-pushing, touching production) unless the user explicitly asked for exactly that.

## Stop, resume, clean up

```sh
omp-vs abort <session>      # interrupt the current turn
omp-vs stop <session>       # end the omp process; the transcript stays
omp-vs resume <session>     # restart it on the same transcript
omp-vs rm <session> -y      # delete the session and its history (only ones you created and no longer need)
```

Idle sessions cost nothing. Leave finished sessions for the user to review unless they asked you to clean up.

## Working in parallel

- Give parallel sessions in the same repository separate git worktrees (`git worktree add ../repo.worktrees/<task> -b omp/<task>`). Two sessions editing one checkout overwrite each other.
- Prefer queueing (`--task`) over starting many sessions at once. The global limit then keeps the machine and the bill in check.

## Hermes Agent

With the omp-sessions Hermes plugin installed (`omp-vs hermes install`), a Hermes agent gets native tools for everything above: `omp_session_start`, `omp_session_status`, `omp_session_wait`, `omp_session_send`, `omp_session_answer`, `omp_session_mode`, `omp_session_stop`, `omp_sessions_list` and `omp_projects_list`. Prefer the tools to shelling out. Hermes also gets a message in the chat when a session it started finishes or needs input, so there is no need to keep waiting on it.

The plugin can also run kanban cards as omp sessions. With the lane on (`hermes omp lane on --board <slug>`), a card assigned to `omp` is claimed by the lane. It runs as an omp session in the card's workspace, or in the board's configured folder, and its outcome goes back to the card:

```sh
hermes kanban --board <slug> create "Fix flaky checkout test" --assignee omp --workspace dir:/abs/repo --body "..."
hermes kanban --board <slug> assign <card-id> omp      # hand an existing card to omp (not while it is running)
```

- On success the card is completed, with the session's final reply as the result. Child cards see it as their parent's result.
- If the session waits for an answer, the card is blocked as `needs_input` until someone answers, in VS Code, on the phone or with `omp-vs answer`.
- A session that stops on an error blocks the card as `transient`.
- `--board` goes before the verb. `hermes omp status` shows the lane and its linked cards.

Use cards when the work belongs on a board with dependencies. Use the tools, or `omp-vs new`, for one-off and scheduled tasks.

## From another machine

The same sessions are reachable over HTTP when the user has turned on remote access (`omp-vs remote on`). Find the URL with `omp-vs remote status` and the token in `~/.omp/vscode/remote.json`. Send it as `Authorization: Bearer <token>`. Endpoints:

- `GET /api/sessions`
- `POST /api/sessions` with `{cwd, prompt | task, title, mode}`
- `GET /api/sessions/<id>`
- `POST /api/sessions/<id>/prompt` with `{text}`
- `POST /api/sessions/<id>/ui` to answer a dialog
- `GET /api/sessions/<id>/events` for live Server-Sent Events

Reference: https://github.com/mbaradad/omp-vscode/blob/main/docs/REMOTE-API.md
