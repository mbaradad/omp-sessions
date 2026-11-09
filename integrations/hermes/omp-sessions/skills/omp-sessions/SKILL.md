---
name: omp-sessions
description: Start, queue, schedule and supervise oh-my-pi (omp) coding sessions that keep running in the background, using the omp-sessions CLI. Use when coding work should run as its own persistent omp session that the user can watch and steer (from VS Code, the terminal, their phone or Hermes), when queueing or scheduling coding tasks for later, or when checking on, answering or following up on existing omp sessions.
license: MIT
metadata:
  omp-sessions:
    managed-by: omp-sessions
  hermes:
    tags: [coding, agents, omp, background, kanban, scheduling]
    category: autonomous-ai-agents
---

# omp Sessions

`omp-sessions` drives omp coding sessions that run in the background on this machine. The Agent Orchestrator (AO) daemon runs them (`omp acp` in a host process of its own per session); the omp-sessions planner starts queued and scheduled work. A session keeps working after you (the calling agent) exit, with no editor open, and across SSH drops. The user sees the same sessions in VS Code (the omp Sessions extension), in the terminal, in the AO phone app and in Hermes, so anything you start here is visible to them, and they can step in.

Use it to hand coding work to omp instead of doing it inline: one session per task, in the repository it concerns. Then come back for the result.

## Before you start

- Run `omp-sessions status --json` once: it says whether the AO daemon (`ao`) and the planner (`server`) run, whether AO can run omp (`omp.readiness`), the default model, sessions by state and any problems (`ok: false` with `problems`). If the command is missing, ask the user to install it: *omp: Install omp-sessions Command* in VS Code (it goes to `~/.local/bin`, or `%LOCALAPPDATA%\omp-sessions` on Windows), or the standalone package from the GitHub release.
- Sessions run on this machine, for the folder you give. Use absolute paths. A folder in a git repository runs in that repository's AO project, and AO gives every session **its own git worktree and branch** (`ao/<session>/root`): the session's `cwd` in `--json` output is that worktree, not your checkout, and its changes reach your checkout only when someone merges that branch. A folder outside git runs in a scratch folder AO creates. `omp-sessions projects --json` lists the AO projects (`[{path, name, id, lastUsed, sessions}]`, newest first), which helps when the user names a project rather than a path.
- Every command that takes `<session>` accepts the id, an id prefix, or words from the title. Ids are the safest choice.
- `--json` output is meant for you; the rest is for people.

## Start a session

```sh
omp-sessions new /abs/path/to/repo -p "Fix the flaky checkout test. Run the test suite before you finish." \
  --title "Fix flaky checkout test" --tag ticket:ENG-142 --json
```

This prints `{"id": "...", "started": true, "title": "...", "cwd": "..."}` and returns right away (`cwd`: the session's worktree). The session keeps working in the background. Ids look like `<project>-<n>`, e.g. `myrepo-3`.

- `-p -` reads the prompt from stdin, which is better for long prompts.
- Leave out `--mode` unless the user asked for a specific permission mode: the session then starts in the user's default (`omp-sessions config get mode`), else in `auto`. AO runs every session without its own prompts and the Switchyard omp extension's gate asks instead, so `ask`, `edits` and `plan` work only where that extension is installed (`omp-sessions status --json`: `omp.extension.installed`); `new --mode ask|edits|plan` fails (exit 1, nothing started) without it. `omp-sessions omp-extension [status|install|uninstall] [--json]` manages it (and the shim for omp flags); `new` and `status` install or refresh it by themselves when this build ships it, unless `config set omp-extension off`. The modes:
  - `auto` approves every tool call;
  - `edits` applies file edits but asks before every command (bash included);
  - `ask` asks before every tool call;
  - `plan` is read-only: edits are refused and the model writes a plan.
- Flags after a bare `--` go to omp itself for this session (`new <dir> -p "…" --json -- --advisor plan`, put every Switchyard flag before the `--`); they need Switchyard's omp shim (`omp.shim.installed`). Machine-wide ones: `config set omp.extraArgs -- --profile work`.
Tool approvals are `approval` questions titled with the tool call (e.g. the command), with the options "Allow once", "Always allow", "Reject" and "Always reject" (`Allow tool: <name>` `select` questions with "Approve" and "Deny" also occur). Never approve destructive commands (deleting data, force-pushing, touching production) unless the user explicitly asked for exactly that.

`mode <session> <mode>` switches right away, also mid-turn: the gate reads the session's mode at its next tool call. `show --json` and `ls --json` report it as `mode` (`meta.permissionMode`), `ask` included. Sessions started before the gate existed have no mode file: for those `plan` is live and the other modes restart omp on the same transcript (only while the session isn't working).

## Stop, resume, clean up

```sh
omp-sessions abort <session>      # interrupt the current turn
omp-sessions stop <session>       # end the omp process; the session, its worktree and transcript stay
omp-sessions resume <session>     # restart it on the same transcript
omp-sessions rm <session> -y      # delete the session, its worktree and history (only ones you created and no longer need;
                                  # AO refuses while its worktree holds uncommitted changes)
```

Idle sessions cost nothing. Leave finished sessions for the user to review unless they asked you to clean up.

## Working in parallel

- Each session already gets its own AO worktree and branch, so parallel sessions in one repository don't overwrite each other. Their work lands on their branches (`branch` in `show --json`), not in the user's checkout.
- Prefer queueing (`--task`) over starting many sessions at once. The global limit then keeps the machine and the bill in check.

## Hermes Agent

With the omp-sessions Hermes plugin installed (`omp-sessions hermes install`), a Hermes agent gets native tools for everything above: `omp_session_start`, `omp_session_status`, `omp_session_wait`, `omp_session_send`, `omp_session_answer`, `omp_session_mode`, `omp_session_model`, `omp_session_stop`, `omp_queue_add`, `omp_queue_schedule`, `omp_sessions_list`, `omp_projects_list`, `omp_models_list` and `omp_server_status`. Prefer the tools to shelling out. Approval dialogs stay with the user unless the plugin's `agent_approvals` setting is on. Hermes also gets a message in the chat when a session it started finishes or needs input, so there is no need to keep waiting on it.

The plugin can also run kanban cards as omp sessions. With the lane on (`hermes omp lane on --board <slug>`), a card assigned to `omp` is claimed by the lane. It runs as an omp session in the card's workspace, or in the board's configured folder, and its outcome goes back to the card:

```sh
hermes kanban --board <slug> create "Fix flaky checkout test" --assignee omp --workspace dir:/abs/repo --body "..."
hermes kanban --board <slug> assign <card-id> omp      # hand an existing card to omp (not while it is running)
```

- On success the card is completed, with the session's final reply as the result. Child cards see it as their parent's result.
- If the session waits for an answer, the card is blocked as `needs_input` until someone answers, in VS Code, on the phone or with `omp-sessions answer`.
- A session that stops on an error blocks the card as `transient`; a task a crash or reboot interrupted blocks it too, and unblocking the card continues it in the same session.
- `--board` goes before the verb. `hermes omp status` shows the lane and its linked cards.

Use cards when the work belongs on a board with dependencies. Use the tools, or `omp-sessions new`, for one-off and scheduled tasks.

## From another machine

Sessions are AO sessions, so AO's HTTP API reaches them. On this machine it listens on loopback without auth (the port is in `~/.ao/running.json`, usually `http://127.0.0.1:3001`). From another machine, the user turns on AO's phone listener (`omp-sessions remote on`; `omp-sessions remote status` lists its addresses) and the client sends AO's pairing password as `Authorization: Bearer <password>`. The main endpoints, under `/api/v1`:

- `GET /sessions`, `GET /sessions/<id>`, `GET /sessions/<id>/conversation` (messages, pending approvals and questions, usage)
- `POST /sessions` with `{projectId, harness: "omp", mode: "chat", kind: "worker", prompt, displayName, approvalMode}`
- `POST /sessions/<id>/conversation/messages` with `{text}`; `.../steer-or-send` with `{text, clientMessageId}` to steer
- `POST /sessions/<id>/conversation/approvals/<requestId>/resolve` with `{decisionId}`; `.../inputs/<requestId>/resolve` with `{action, content}`
- `POST /sessions/<id>/conversation/interrupt`, `/sessions/<id>/exit-agent`, `/sessions/<id>/resume-agent`
- `GET /events`: Server-Sent Events that say which session changed (send `Last-Event-ID` to resume)

Queued and scheduled tasks belong to the planner, which has no HTTP API: use `omp-sessions` on this machine for those. Reference: AO's `backend/internal/httpd/apispec/openapi.yaml`.
