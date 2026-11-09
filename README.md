# Switchyard

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/mbaradad.switchyard?label=Marketplace&color=9b4dff)](https://marketplace.visualstudio.com/items?itemName=mbaradad.switchyard)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/mbaradad.switchyard?color=ed4abf)](https://marketplace.visualstudio.com/items?itemName=mbaradad.switchyard)
[![License: MIT](https://img.shields.io/badge/license-MIT-5ad8e6)](LICENSE)

![Switchyard: plans for your coding agents. A VS Code chat with an inline diff next to a plan with running, dependent, waiting and scheduled tasks.](docs/images/hero.png)

Switchyard plans work for coding agents (Claude Code, Codex, [oh-my-pi](https://omp.sh) `omp` and the other harnesses AO runs) and hands it to [Agent Orchestrator](https://github.com/OrchestratorInc/agent-orchestrator) (AO) to run. You write plans: tasks with subtasks and dependencies, queues per session, scheduled starts, priorities and a limit on how many run at once. The Switchyard *planner*, a small service on the machine with your code, sends each task to AO when its dependencies are done, a slot is free and its start time has come. AO runs it as an agent session (the harness AO's configuration picks, see [Harnesses](#harnesses)) in its own git worktree and keeps it alive with no client open. That's the difference from omp in tmux: work keeps moving without you, not just the process. Every client reaches the same sessions: the `switchyard` command, VS Code (any session opens there with the full chat, diffs and undo), AO's phone app, Hermes Agent and other agents. Close everything, sleep the laptop or drop SSH, and come back to what happened meanwhile: answers, diffs, questions waiting for you.

**[Website](https://mbaradad.github.io/omp-sessions/)** · **[Install](https://marketplace.visualstudio.com/items?itemName=mbaradad.switchyard)** · **[Setup guide: workstation, laptop, phone](docs/SETUP.md)** · **[Phone & API access](docs/REMOTE-API.md)** · **[Hermes plugin](docs/HERMES.md)** · **[Changelog](CHANGELOG.md)**

![A day with Switchyard: queue the day at 9:00, walk away at 9:30, approve a command from your phone at 12:40, review and undo in VS Code at 15:00, check the cost at 18:00.](docs/images/a-day.png)

## What people use it for

| Use case | How |
| --- | --- |
| **A queue for the day, or the night** | Tasks with subtasks per session, dependencies between tasks, a global "N at a time" limit, scheduled starts (`02:00`, `+2h`). The planner runs them with no client open; after a reboot it picks up where it was and never runs a task twice. |
| **Long jobs on a remote box** | Start a big refactor over Remote-SSH, close the laptop, reconnect tomorrow to the finished work and the full transcript. |
| **Several attempts at once** | *Best-of-N* runs the same task in N git worktrees; compare the branches and merge the best one. |
| **Careful work on code that matters** | **Ask** or **Plan** mode, every edit in VS Code's diff editor, and undo for any turn — files and conversation together. |
| **Supervising from anywhere** | AO's phone app shows what's working, waiting or done; approve a command, answer a question or start a new session from the couch. |
| **Fixing what's in front of you** | *Fix with Agent* on a squiggle, on a failed terminal command, or on all of a file's problems; commit messages and PR descriptions from Source Control. |
| **Scripts and automation** | `switchyard new --task …`, `switchyard wait … --json`, `switchyard status --json`, or AO's HTTP API from your own tools. |
| **Other agents delegating to omp** | Hermes, Claude Code, Codex or omp itself start, schedule and supervise omp sessions through the `switchyard` skill; Hermes gets a plugin with native tools, notifications, a kanban lane that runs cards as omp sessions, and an Switchyard page in its dashboard and Desktop app. [Setting it all up on one workstation](docs/SETUP.md). |

## Highlights

### A chat that lives in your editor

![Chat in an editor tab: an inline diff, a bash call, a Markdown answer with file links and a table, and the footer with model, thinking level, permission mode, context and cost](docs/images/chat.png)

Streaming answers, tool cards with live durations, syntax-highlighted inline diffs, clickable `file:line` links, `@` file mentions, `/` commands, image and file attachments. The footer holds the model picker (star your favorites), thinking level, permission mode, context use, cost, tokens per second and your provider's usage limit. Open it in an editor tab or the side bar, or continue the same session in omp's own terminal UI.

### You decide what runs: permission modes

![Sessions view with a needs-input session, and a chat asking to approve a bash command in Ask mode](docs/images/sessions.png)

**Ask** approves every edit and command, **Edits** applies file edits and asks before commands, **Plan** is read-only and asks the model for a plan, **Auto** runs everything. Switch any time with **Shift+Tab** — even with an approval already waiting. Switchyard's omp extension enforces the mode inside omp, so it holds while VS Code is closed.

### Undo any turn

![Undoing the last prompt: the two files that go back are listed, the conversation rewinds, redo brings everything back](docs/images/checkpoints.png)

Every prompt is a checkpoint. Undo puts back the files omp changed since then and rewinds the conversation; the prompt returns to the composer so you can rephrase. Redo brings it all back.

### Review every change

![Review Changes: all of a session's edits in VS Code's multi-file diff editor](docs/images/review.png)

Each session snapshots the files it edits. Review them in VS Code's own diff editor, revert per file or per tool call, and see `π` badges and changed-line markers in the Explorer and open editors.

### Many sessions, one overview

![The Sessions Board: columns for needs input, working, queued, idle and completed](docs/images/board.png)

The Sessions view groups sessions by project with working and needs-input counts; the Board shows them as a kanban by status, your own lanes, groups or priority. Groups, colors, priorities, pins, tags and filters keep dozens of sessions manageable. Sessions that finished or asked something while you were away are marked **● new**.

### Task queues that run without you

![The Tasks view: a running task with subtasks and two pending tasks; the chat shows Queued task 1/3](docs/images/tasks.png)

Queue tasks and subtasks per session, or chain them into a graph where a task starts when its parents are done; the planner sends them to AO one by one as the session is idle. One limit across all sessions decides how many run at once, and the planner starts queued and scheduled work when a slot frees up. After a reboot it continues the plan: work that hadn't started is dispatched, and a task that was running is marked **interrupted** and waits for you, so nothing runs twice.

**Dependencies.** A task that waits for others (`switchyard new --task … --after <session>`, `queue <session> after <s>…|off`, *Dependencies…* in the Sessions and Tasks views and the board's card menu) stays blocked until every one of them is done or skipped, or its session is marked completed, and then starts by itself; a failed parent keeps it blocked, and says so, until you retry, skip or complete it. Waiting sessions show *waits for …* in the Sessions view and on the board, and the board's **Graph** toggle (remembered) and *Switchyard: Show Task Graph* draw the dependencies as a left-to-right graph. A task can't wait for itself, for an unknown task or in a cycle: the edit is refused and the error names the cycle.

### Your phone

Install AO's phone app ([iPhone and iPad](https://apps.apple.com/app/ao-mobile/id6792552173), [Android](https://play.google.com/store/apps/details?id=aoagents.dev)), run *Connect Phone…* in VS Code (or `switchyard remote on`) and scan the QR code. The app lists your sessions, follows them live, takes prompts, answers approvals and questions, starts new sessions and sends push notifications. Reach the machine over your Wi-Fi, [Tailscale](https://tailscale.com) (free, encrypted) or AO's tunnel. It doesn't show Switchyard's queues and schedules yet; a Switchyard phone app is planned. The API behind it is AO's, described in [`docs/REMOTE-API.md`](docs/REMOTE-API.md).

### Know what it costs

![Usage dashboard: spend today, this week, this month and all time; cost per day; projects and models](docs/images/dashboard.png)

Spend and tokens per day, project, model and session, today's spend in the status bar, and a search across every transcript. A session's cost is the same number everywhere (`ls`, the phone, Hermes, the dashboard) and includes subagents and side calls.

## Get started

1. **Install omp** on the machine where sessions will run (your computer, a workstation or server) and log in to a model provider: `curl -fsSL https://omp.sh/install | sh`
2. **Install Agent Orchestrator** on that machine: the [AO desktop app](https://orchestrator.inc/download/), or the `ao` binary built from source on a headless machine ([setup guide](docs/SETUP.md#1-omp-ao-and-switchyard)).
3. **Install Switchyard**, either way:
   - **VS Code extension** from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=mbaradad.switchyard) (`code --install-extension mbaradad.switchyard`); over Remote-SSH it installs on the SSH host. *Switchyard: Install switchyard Command* then adds the terminal command.
   - **Command only** (no VS Code on that machine), with Node 22+: `npm install -g <switchyard-<version>.tgz>`, the package attached to each [release](https://github.com/mbaradad/omp-sessions/releases), then `switchyard omp-extension install`.
4. **Start a session**: press `+` in the Switchyard **Sessions** view, or `switchyard new . -p "…"` in a terminal. `switchyard status` shows AO, the planner, omp and your sessions at a glance.
5. Optional: *Connect Phone…* (or `switchyard remote on`) for the phone, `switchyard hermes install` for Hermes Agent.

If no AO daemon is running, the first client that needs one starts `ao daemon` as a systemd user unit (a detached process where there is no systemd). The first time a client starts the planner, it installs it as a login service (systemd user unit on Linux, launchd agent on macOS) so queued and scheduled work comes back after a crash or reboot, and says so once. It doesn't when the only Node is VS Code's own runtime (no Node 22+ on PATH). `switchyard config set service off` (VS Code: `switchyard.server.installService`) turns auto-install off; `switchyard server uninstall` removes the service. `switchyard status` says which applies.

**Coming from omp Sessions?** Switchyard is a new extension and command (`mbaradad.switchyard`, `switchyard`). It does not read the old omp Sessions state by itself. `switchyard migrate` imports the old defaults (model and mode), the concurrency limit and your organization (groups and board lanes): a dry run until `--apply`, it backs up `~/.omp/vscode` first and never writes or deletes there. No session is migrated: the dry run lists each old session with the `omp --resume <id>` command that continues it in omp, and its unfinished queued tasks. Once migrated, the old extension and the `omp-sessions` command can be removed.

## How it works

```
  VS Code ─┐
  switchyard CLI ─┤                         ┌─ AO daemon ── chat host ── omp acp ── your repository
  Hermes plugin ──┼── Switchyard planner ──►│   (HTTP + SSE)   (one per session)    (its own git worktree)
  agent skill ────┘      (plans, queues,    └─ AO phone app, AO desktop app
                          schedules)
  The clients also talk to AO directly: chats, approvals, session lists.
```

- **Agent Orchestrator** (`ao daemon`, one per user) runs the sessions. For each one it creates a git worktree on a branch `ao/<session>/root` (a scratch folder outside git), starts `omp acp` inside a detached *chat host* that outlives the daemon and every client, stores the conversation, and holds omp's approval prompts and questions until someone answers. It serves the HTTP API and an event stream that every Switchyard client uses, and its phone and desktop apps.
- **The planner** (`planner.js`, one per user, a login service where one is installed) holds your plans in `~/.switchyard/planner/`: tasks, subtasks, dependencies, queues per session, schedules, priorities, the global concurrency limit and usage-based holds. It watches AO's events and, when a task is ready (its parents are done, its start time has come, a slot is free, the session is idle), creates or continues an AO session and prompts it. It never runs agents itself. It writes a task as running before it calls AO and reconciles with AO after a restart, so nothing runs twice and an interrupted task is marked, never silently re-run. Sessions never depend on it.
- **The Switchyard omp extension** (`~/.omp/agent/extensions/switchyard/`) runs inside each AO session's omp, only when AO started it. It snapshots every file omp's edit tools change (checkpoints, undo and redo, review, revert), asks before tool calls according to the session's permission mode (a file in `~/.switchyard/sessions/<id>/mode`, so a switch is live and holds while VS Code is closed), mirrors omp's todo list and records the session's omp id.
- **Clients**: the `switchyard` command, the VS Code extension (tree view, board, status bar, chats in editor tabs or the side bar, diffs from the snapshots), AO's phone and desktop apps, and the Hermes plugin. They read and drive sessions through AO's API and edit plans through the planner.
- State: AO keeps sessions in `~/.ao/data/` (conversations, worktrees, chat-host descriptors, the phone password). Switchyard keeps `~/.switchyard/`: `planner/plan.json` (plans), `organize.json` (groups, colors, tags, lanes, archive), `config.json` (default model and mode, service) and `sessions/<id>/` (permission mode, checkpoints, omp id). The omp transcript itself stays in omp's sessions folder (`~/.omp/agent/sessions/`, or the active omp profile's).
- Robustness: AO's chat host keeps omp and the running turn alive across a restart of the daemon, and a session whose host or machine died is resumed from omp's transcript (a turn that was cut short is lost, and a queued task it cut short waits as interrupted). A missing folder or omp binary shows up in `switchyard status` with the reason.

Works on Linux and macOS, locally and over Remote-SSH. On Windows, run it in WSL 2; native Windows is handled but untested.

## Feature reference

### Sessions

- **Sessions view** groups sessions by project (git repository, else folder) with working / needs-input counts; `+` on a project starts a session there. *Group Sessions By…* switches between project, your groups, status, or a flat list; *Sort Sessions By…* picks the order inside each group (including next scheduled start and completed first). The eye button (*Hide Finished Sessions*) hides stopped sessions, except those with queued, scheduled or interrupted work; ones with unseen activity stay until you look, and the view header counts how many are hidden. *Open in Side Bar* / *Open in Editor Tab* choose where a chat opens (`switchyard.chatLocation` sets the default); the **Chat** view can be dragged to the secondary side bar to sit next to your code.
- `+` starts a session in the workspace folder; *New Session with Options…* picks model, thinking level, permission mode, plan-first / advisor / prewalk, an optional **goal**, and any extra omp CLI flags (remembered for resumes). *Set Default omp Model for New Sessions…* and *Set Default Permission Mode for New Sessions…* set the defaults every client uses (`switchyard config set model|mode`).
- **Which sessions show**: by default the Sessions view, Tasks view, Board and status bar list this workspace's sessions (folder inside a workspace folder; worktrees count for their main checkout). *Show All Sessions* in the view title switches to every session on the machine (`switchyard.sessionScope`). Notifications follow the same rule unless `switchyard.notifyAllSessions` is on.
- **Sessions Board** (*Open Sessions Board*): a kanban of every session — columns by status (Needs input / Working / Queued / Idle / Completed / Stopped), by lanes you define (Backlog / To Do / In Progress / Review / Done), by group, or by priority; swimlane mode shows one row per project. Drag cards (or arrow them) to move them; set priority (P to cycle), color, pin, archive, completed and tags per card or in bulk. **Sort** in the header orders every column by rank (your drag & drop order, the default), last activity, created, scheduled start, completed, name or cost, and is remembered with the board; while a column is sorted, drops still change its lane / group / priority but not the order, and Queued always keeps start order. Cards show queue progress, cost, last text, unread and a start-time chip for scheduled queues; *Run now*, *Requeue* (failed, interrupted or finished tasks run again) and *Schedule…* (presets, *Other time…*, *Unschedule*) are on hover and in the card menu, and dropping a card on Queued requeues it; the header carries the global concurrency counter; *Maximize* fills the panel.
- **Completed**: *Mark Completed* (Sessions view context menu, the board's ✓ card button, bulk *Complete*, `switchyard complete <session>`) records that a session's work is done. It is a marker the planner keeps on the session's queue, not a stop: the session keeps running and queued work still starts. Completed sessions show a ✓ in the tree and move to the board's Completed column while nothing runs in them; *Hide Completed Sessions* (view title menu) and the board's **Completed** toggle hide them. A new prompt (not a `/command`) or a queued task starting clears the mark; *Mark Not Completed* (`switchyard uncomplete`) clears it by hand.
- **AO Dashboard** (*Open AO Dashboard*, also in the Sessions view's `…` menu): Agent Orchestrator's own web UI, the one in AO's desktop app (project boards, sessions, conversations, artifacts, automations), in an editor tab. The planner serves it from the machine (`switchyard dashboard install` fetches it once from AO's release) and VS Code forwards the port over Remote-SSH and WSL; the Hermes page shows it too. Setup and limits: [docs/SETUP.md](docs/SETUP.md#aos-own-dashboard-optional).
- **Organization**: nest **groups** (each with a color and an icon) and set **color / priority / pin / archive / tags** per session — from the tree (drag, context menus) or the board. The Sessions view filter box accepts free text, `#tag` and `project:name`; manual ordering and group collapse persist in `organize.json`.
- **Git worktrees**: every session runs in its own AO worktree on a branch `ao/<session>/root`, so parallel sessions never overwrite each other and your checkout stays as it is. *New Session on Branch…* starts one on a branch you pick; *Best-of-N* runs the same task in N parallel sessions; worktrees group under the main repo in the Sessions view. *Compare Branch with Base*, *Merge into Main Checkout…*, *Open in New Window*, *Remove Worktree and Session* (AO keeps a worktree with uncommitted changes, so nothing is lost silently). The editor actions (*Fix with Agent*, *Commit with Agent*, …) tell the session where your working copy is, so they edit your checkout.
- omp questions (`ask`, approvals, selects, inputs) appear as cards above the composer; the session shows **needs input** in the tree/status bar and a notification fires when the chat is not visible. Sessions that finished or asked something while you were away are marked **● new** in the Sessions view and counted on the omp activity-bar badge until you look.
- **Sounds**: when a session finishes its turn, a queued task ends, or a session asks something, Switchyard plays one of Hermes Desktop's cues (default *Two-note comfort* for a finish, *Glass ping* for a question; MIT-licensed ports of Hermes's Web Audio presets). Pick them with `switchyard.sound.completion` / `switchyard.sound.input` (*None* silences one) and `switchyard.sound.volume`, or run **Switchyard: Test Completion Sound** and arrow through them. Sessions are scoped like notifications. **Limitation:** VS Code has no extension API for audio (see [microsoft/vscode#175986](https://github.com/microsoft/vscode/issues/175986)), so the cue is synthesized inside a Switchyard webview: it sounds only while a Switchyard chat (editor tab or side bar) or the Sessions Board is open in a window on your computer. A hidden tab counts (the webviews keep their state); with none open, nothing plays. With several windows open, one plays each cue. The Hermes dashboard's bell plays the same cues in a browser tab.
- Stopped sessions keep their transcript; **Resume** restarts omp on the same transcript (AO's `resume-agent`). Sessions you started in omp's own terminal UI aren't adopted into Switchyard; continue those with `omp --resume`.

### Control and safety

- **Permission modes** — **Ask** (approve every edit and command), **Edits** (file edits apply, commands ask), **Plan** (read-only: edits are refused and prompts ask for a plan), **Auto** (approve everything). Switch live from the footer chip, **Shift+Tab** in the composer, `/mode`, `/plan`, *Set Permission Mode…* in the Sessions view, or `switchyard mode`. AO itself fixes omp's approval policy at launch, so Switchyard starts omp in AO's *bypass* mode and its omp extension asks (as an approval or question that shows up in every client) according to the mode file; the mode also holds with VS Code closed, and switching resolves approvals already waiting. A new session starts in the mode it was given, else the Switchyard default (*Set Default Permission Mode for New Sessions…*, `switchyard config set mode`), else Auto. Edits and Ask wait for a person at the first command, so unattended work wants Auto. Subagents keep omp's own behavior. Sessions started from AO's own apps keep AO's modes.
- **Checkpoints**: every prompt is a checkpoint. The undo button on a prompt (or *Undo last turn* / `/undo` / *Switchyard: Undo Last Prompt*) rewinds the conversation to before it and puts every file omp's edit tools changed since back the way it was; the prompt returns to the composer. *Redo* / `/redo` brings the conversation and the files back. Switchyard's omp extension (installed into `~/.omp/agent/extensions/` at activation) records the edits and runs `/undo` and `/redo` inside omp, so they work the same from Agent Orchestrator's app and omp's own TUI, and survive restarts. AO's timeline keeps undone turns; the chat hides them.
- **Diffs**: edit/write cards show a line diff with old/new line numbers and word-level highlights (click a line to jump there); *Diff* opens VS Code's diff editor for that tool call and *Revert* restores the file to its content before that call; *N files changed* / `/changes` opens a multi-file review of everything the session changed.
- **Change markers**: files changed by a running session (or a stopped one in this workspace) get a purple `π` badge in the Explorer; open editors mark lines that differ from the content before the session touched the file, with a CodeLens to diff, **Revert** (also on file nodes in the Sessions view), or open the chat.

### Chat

- Composer: Enter sends, Shift+Enter newline, Esc interrupts (queued follow-ups stay queued), ↑/↓ recall earlier prompts, drafts survive reloads; while the agent works Enter steers (`switchyard.sendWhileBusy`). `/` completes omp's commands plus the extension's (`/new`, `/btw`, `/tui`, `/changes`, `/mode`, `/plan`, `/undo`, `/redo`, `/copy`, `/cost`, `/login`, `/logout`, `/settings`, `/help`, `/exit`); `@` completes files; `!cmd` runs a shell command in the session folder and adds its output to your next prompt. `/btw` asks a side question in an isolated fork of the session that sees its context but never touches the main conversation. Unsaved editors in the session folder are saved before each prompt so omp reads what you see.
- **Footer**: model picker (star models to pin them on top), thinking level, permission mode, context use, cost and your provider's usage limit when omp reports one.
- **Terminal UI**: `/tui` (or *Continue Session in omp's Terminal UI*) stops the background agent, opens the same session in omp's own terminal UI in an editor tab, and resumes the background agent when you close the terminal.
- Messages: hover a prompt to **edit & resend** (undoes the conversation back to it) or **restore its checkpoint**; hover an answer to copy it. Code blocks and diffs are syntax-highlighted with your theme's colors; images open full size on click; tool cards show live durations and the turn's elapsed time is in the footer.
- **Attachments**: paste or drop images (sent to the model as images) and any other file — PDFs, docs, archives — (stored under the session's `attachments/` on the remote and handed to omp's read tool). 📎 picks files on the remote disk.
- **Links**: web URLs open in the browser; `file:`/relative/absolute paths (with `:line` or `#L12`) open in the editor; `artifact://`, `local://`, `skill://`, `omp://`, … open their content.
- **More**: in-chat find, *Copy / Save as Markdown*, `switchyard.chat.snippets` prompt snippets (`/p:name`, with `{{selection}}` and `{{file}}`), per-message timestamps, and tail-first rendering of long transcripts.

### Queues and scheduling

- **Tasks view**: queue work per session — tasks with subtasks (`Title :: step; step`), drag & drop to reorder (also between sessions), checkboxes to complete, run now / start / pause the queue, edit details, and edit omp's own plan (its todo list). From the chat: `/queue …`, **Alt+Enter** (queue instead of send), and the queue bar above the composer. Queued tasks show up in the transcript as *Queued task i/n*; a failure or an interruption pauses the queue.
- Per-task *Options…* (model, thinking level, fresh context, retries 1–5, timeout), *Duplicate Task*, *Retry Failed Tasks*, and *Schedule Queue Start…* (`HH:MM`, `YYYY-MM-DD HH:MM`, or `+30m/+2h/+3d`). The planner applies each task's model, thinking level and retries; *fresh context* runs the task in a new AO session.
- **Concurrency scheduler**: queues across *all* sessions share a limit, held by the planner, so it holds with VS Code closed. The status bar shows `N/M running · K waiting`; *Set Concurrency…*, *Increase/Decrease*, *Pause/Resume Queued Tasks*. A task waiting for a slot shows its queue position in the tree and the board.
- **Autoschedule by usage** (planner, so it runs with VS Code closed): queued work is *held*, not failed, while its provider's rate or usage limit is in force (the reset time comes from the provider's error: "try again in 2 h", "resets 3pm", `retry-after`; else 5 min doubling up to 2 h) or its usage window from `omp usage` is at the hold threshold (95%), and starts by itself at the reset. A task marked *spare* (`--usage spare`, or *Task Options…* on a task in the Tasks view) starts only while its provider's windows are below 60% (*Set Usage Limits for Queued Tasks…* moves both thresholds). *Set Spend Budget for Queued Tasks…* caps what planner tasks spend per rolling hour, day or week; a task that would start over a cap waits until the oldest spend leaves the window. The tree description, the board card (a *Held* pill and a line with the reason and the time) and `switchyard ls`/`show`/`status`/`sched` say why work waits; `switchyard sched limits clear` forgets a provider limit so held work starts now.

### Agents and Hermes

- **The `switchyard` skill** teaches other agents to use `switchyard`: start a session, queue or schedule it (`--task`, `--at`), wait for it (`switchyard wait --json` exits 0 idle, 3 needs input, 4 stopped or interrupted, 5 scheduled), read its report (`switchyard show --json`: state, waiting question, full last reply), answer its questions (`switchyard answer`), and follow up. *Install Switchyard Skill for Agents…* or `switchyard skill install` puts it in `~/.agents/skills` (omp and other tools), `~/.claude/skills` and `~/.codex/skills`; copies it installed are refreshed when the extension updates.
- **Hermes Agent plugin** (*Install Hermes Plugin…*, `switchyard hermes install`, or `hermes plugins install mbaradad/omp-sessions/integrations/hermes/switchyard --enable`): native tools (start, queue, schedule, status, wait, send, answer, model, planner status, …), a message back in the Hermes chat when a session it started finishes or needs input, and a kanban lane: cards assigned to `switchyard` run as omp sessions in the card's workspace (or the board's folder, grouped by board, with an optional per-board model), with results, questions and failures written back to the card and dependencies chaining as usual. Card comments from trusted authors reach the session; approvals are never answered by comments. A **Switchyard** page in the Hermes dashboard and Hermes Desktop shows every session by state, answers questions, follows up, switches models, opens a session or its project in VS Code, starts new sessions, sets up the lane per board and draws a board's cards as a dependency graph with their omp sessions' state. [Details](docs/HERMES.md).

  ![The Switchyard page in the Hermes dashboard: sessions in columns for needs you, working, queued and scheduled, done and stopped.](docs/images/hermes-dashboard.png)
- **Hermes in VS Code**: copies of the plugin that Switchyard installed are kept current when the extension updates (in every profile, reloaded in the running gateway without a restart). Sessions Hermes started carry a **Hermes** chip in the Sessions view and chat header; kanban-lane sessions show **Hermes · board · card**, with *Open Hermes Card* (the dashboard's Kanban page, `switchyard.hermes.dashboardUrl`) and *Show Hermes Card* (the card as text in an output channel). **omp Doctor** checks the plugin per profile, notifications, where the kanban dispatcher runs against where the lane is on, and whether the plugin finds `switchyard`, with one-click fixes.
- Agent-friendly CLI: `switchyard new … --json` (with `--mode`, `--model`, `--tag`, `--group`, `--notes`, `--at`), `show`, `wait`, `answer`, `projects`, `status --json`, `models --json`, `ls --json` (with filters) and `sched --json`.

### Phone and remote access

- *Connect Phone…* (or `switchyard remote on`) turns on AO's phone pairing (Tailscale and local network, local network only, or AO's Cloudflare tunnel) and shows a QR code of the pairing link. In AO's phone app, scan it: the app lists every session, follows one live, prompts or steers it, answers approvals and questions, stops or resumes it, and starts new sessions. It sends push notifications when a session needs you.
- The app doesn't know Switchyard's queues, schedules or dependencies, and it shows AO's session list and AO's permission mode (*bypass* for sessions Switchyard started: Switchyard's omp extension does the asking). A Switchyard phone app is planned.
- [Tailscale](https://tailscale.com) (free) is recommended: it reaches the machine from anywhere and encrypts the traffic. The local-network option is plain HTTP, readable by anyone on that Wi-Fi. *Disable Remote Access* turns it off; *Rotate Remote Access Token* unpairs every phone. Setup, WSL 2 and the HTTP API: [`docs/REMOTE-API.md`](docs/REMOTE-API.md).

### Editor and Git integration

- Select code → `Cmd+Alt+K` (or editor context menu → *Send Selection to Session*) inserts `path:lines` plus the snippet into the composer.
- **Code actions** (lightbulb): *Fix with Agent* on problems sends the diagnostics plus a snippet; *Explain with Agent* / *Ask Agent about this…* on a selection. *Add to omp Chat* (Explorer, editor tab, editor context menu; multi-select, folders too) inserts `@path` references; *Send Terminal Selection to Session* (terminal context menu) inserts selected terminal output.
- **Editor**: *Edit with Agent* (`Ctrl/Cmd+Alt+E`) prompts with a file (or your selection) preloaded; *Fix File/Workspace Problems with omp*, *Fix Failed Command with Agent* (also offered in the status bar after a terminal error, `switchyard.terminalHints`), *Write Tests with Agent*, *Add Docs with Agent*, *Explain File with Agent*.
- **Source Control** `…` menu: *Commit with Agent* (groups and commits the working tree with good messages), *Review Uncommitted Changes with Agent*, *Write PR Description with Agent*.
- **VS Code bridge**: a session can call *this window's* language features (tools `mcp__vscode_*`): document symbols/definitions, hover and diagnostics of open files; symbol links in the chat resolve to the right file/line here. While `switchyard.vscodeTools` is on, the extension installs them as a module of the Switchyard omp extension package (`~/.omp/agent/extensions/switchyard/`), so every omp session has these tools, including the sessions Agent Orchestrator runs (turning the setting off stops them at the next call); other MCP clients can use the same tools through `out/mcp.js`. *VS Code Bridge: Show Status* reports connected windows and a round-trip probe; *Session Settings…* toggles a session's skills, tools and MCP servers (a tooltip chip appears in the tree when a session is non-default).

### Tools

- **Command Center** (`Ctrl/Cmd+Alt+P`): a searchable, grouped index of every omp command, including omp's own CLI features surfaced as VS Code commands (*Login, Update, Setup, Plugins, Skills, Usage, Stats, Models, Cleanse, Commit in Terminal, Git UI, Continue in Terminal, Import Claude/Codex, Open Docs/Config, Keyboard Shortcuts*).
- **Usage dashboard** (*Usage Dashboard*): cost, tokens and session trends over a range, counting subagents and every transcript a session used; *Show Today's Spend* in the status bar; *Search Session History…* across every transcript, including ones `omp gc` archived (open the session, resume, or read the raw transcript).
- **Doctor** (*Run Doctor*): a health report — AO daemon not running, planner not running, missing omp, auth problems (no API key / not logged in), the Switchyard omp extension missing or out of date — each with one-click fixes. *Copy Diagnostics*, *Clean Up File Snapshots*.
- **Get started**: *Help → Get Started → Switchyard* walks through the features.

## Harnesses

Switchyard runs whichever agent harness AO is set up for: AO's *chat harnesses* (`GET /api/v1/settings` `chatHarnesses`: claude-code, codex, opencode, omp, pi, …) with the readiness AO's agent catalog reports. `switchyard harnesses` lists them with their auth status and says which one a new session gets and why. Every client (CLI, VS Code, Hermes, the planner's queued and scheduled tasks) resolves it the same way:

1. the harness asked for: `switchyard new --harness <id>`, a task's or a lane's `harness` option in the planner, the Hermes tool's `harness` or a kanban board's `harness`, VS Code's pick;
2. Switchyard's default: `switchyard config set harness <id>|none` (VS Code's `switchyard.defaultHarness` writes the same key);
3. the AO project's worker harness (`worker.agent` in AO's project settings);
4. AO's default: the only authorized chat harness; with several, `omp` when it is authorized, else the one with the most sessions (none authorized: the same rule over the installed ones).

A harness that isn't one of AO's chat harnesses, or that AO reports it can't start here, is refused with the list (and is never the default). Switchyard no longer pins `worker.agent: omp` on the projects it registers.

**Permission modes on other harnesses** map to AO's approval modes: Ask → `default` (the harness asks through AO; its own baseline applies, Claude Code e.g. follows its settings.json), Edits → `accept-edits`, Auto → `bypass-permissions`. A harness that can't run a mode (Kimi runs only in `default`) refuses it when asked for; a default mode gives way to the nearest one it can run. **Plan** is omp-only.

**omp-only**: Switchyard's omp extension (the live permission gate behind Ask/Edits/Plan, `/undo` and `/redo` checkpoints with files, the todo mirror, the VS Code language-tools bridge), the `omp` shim's extra flags (`new … -- <flags>`, `switchyard.extraArgs`, `omp.extraArgs`), the default model of `config set model`, and the live model list of a running omp. Other harnesses list their models from AO's catalog (`switchyard models --harness <id>`). Asking for one of these on another harness says so instead of failing.

## Terminal: `switchyard`

*Switchyard: Install switchyard Command* puts `switchyard` in `~/.local/bin` (it runs on Node 22+ from PATH, else on VS Code's own runtime); without VS Code, install the release package with `npm install -g` (see [Get started](#get-started)). The command drives everything without VS Code: over SSH, from scripts, or after a reboot.

```bash
switchyard status                   # server, login service, default harness, omp, default model, sessions by state, queue, remote access
switchyard ls                       # running sessions and those with work ahead (--all: also finished)
switchyard ls --project app --state needs_input --json   # filters: --project --cwd --group --tag --state (a show state)
switchyard new . -p "fix the flaky test"          # start a session with a prompt
switchyard new ~/repo --task "upgrade deps" --sub "bump" --sub "run tests" --priority high
                                      # queue-only: the server starts it when a slot is free
switchyard new ~/repo --task "nightly test sweep" --at 02:00   # scheduled
switchyard attach .                 # chat in the terminal; dialogs answer inline; Ctrl-D detaches
switchyard send fix "also update the docs" --wait  # prompt by title words; after the current turn (--steer: redirect it)
switchyard tail <id> -f             # follow output
switchyard queue <id> add "write the changelog" --notes - --run < brief.md   # task title + full notes
switchyard board                    # waiting / scheduled / working / needs input / interrupted / idle (--all: stopped)
switchyard mode fix plan            # permission mode: ask | edits | plan | auto (no mode: show it)
switchyard harnesses                # AO's chat harnesses, their auth status, and the default for new sessions (and why)
switchyard new . -p "review the diff" --harness claude-code   # a session on another harness than the default
switchyard config set harness codex # default harness of new sessions that name none (none: AO decides)
switchyard models sonnet            # models omp can use; ● marks the default (--harness h: AO's catalog of h)
switchyard model fix anthropic/claude-sonnet-4-5   # switch a session's model (live, or from its next resume)
switchyard config set model anthropic/claude-sonnet-4-5   # default model of new sessions (must be one omp lists; --force)
switchyard config set mode auto     # default permission mode of new sessions that ask for none
switchyard vscode fix               # open a session in VS Code (vscode path/to/dir: that project's checkout)
switchyard sched set 2              # at most 2 queued tasks at once, across all sessions
switchyard sched budget day 20      # stop starting queued work after $20 in a rolling day (hour|day|week; off removes it)
switchyard sched usage hold 90      # hold a provider's work at 90% of its usage window (usage spare 50: where "spare" tasks start)
switchyard sched limits [clear]     # provider limits in force and omp's usage windows; clear lets held work start now
switchyard server status|log -f|install|uninstall      # the planner service (AO: ao status)
switchyard remote on|off|status|qr|rotate # phone pairing (on: --bind tailscale|lan|tunnel|all)
switchyard dashboard install|status|url  # AO's own web UI, served by the planner on 127.0.0.1:3012
switchyard new ~/repo -p "fix the flaky test" --mode auto --tag ENG-142 --json   # for scripts and agents: prints the id
switchyard wait <id> --timeout 2h --json   # idle (0), needs input (3), stopped/interrupted (4), scheduled (5)
switchyard show <id> --json         # state, waiting question, last reply, cost
switchyard answer <id> 1            # answer the waiting question (option number/text, yes/no, text)
switchyard skill install            # teach Claude Code / Codex / omp to drive switchyard (switchyard skill)
switchyard hermes install           # Hermes Agent plugin: tools, notifications, kanban lane
```

Sessions are named by id, id prefix, title words, or `.` (latest in this folder). `switchyard help` lists every command, `switchyard help <command>` (or `<command> --help`) one of them; most take `--json` for scripts. Text that starts with `--` goes after `--` (`switchyard answer . -- --yes`).

- **Planner and AO**: commands start the planner and AO's daemon when needed. Without the planner, queued and scheduled sessions wait; sessions that are running keep going in AO. AO can hibernate a chat nobody watches and wake it for the next message, but only when its chat-hibernation setting is on, and a daemon started without AO's desktop app has it off (see [docs/SETUP.md](docs/SETUP.md#idle-sessions-and-chat-hibernation)).
- **Default model**: a new session uses an explicit `--model` (or the picker's choice), else, for an omp session, `switchyard config set model`, else the harness's own default. The default permission mode follows the same order (`config set mode`, else Auto).
- **Settings shared by every client** live in `~/.switchyard/config.json`: `switchyard config` shows them; `config set harness|model|mode|service` changes them. VS Code's `switchyard.server.installService` writes the same file.
- **After a crash or reboot**: AO restores its sessions, and the planner dispatches work that hadn't started yet. A task that was running is marked interrupted, its queue pauses, and it waits for a person: `switchyard queue <id> run` runs it again, `queue <id> at <when>` reschedules it; it is never rerun unattended.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `switchyard.defaultHarness` | empty | AO harness of new sessions that name none (`claude-code`, `codex`, `omp`, …); empty: the AO project's worker harness, else AO's default (see [Harnesses](#harnesses)). Mirrored into `~/.switchyard/config.json` (`harness`), which every client reads. New Session asks only when several harnesses are authorized and nothing names a default |
| `switchyard.extraArgs` | `[]` | Extra CLI args for omp in new sessions (omp only), e.g. `["--profile","work"]`; user or remote setting only. Applied through Switchyard's `omp` launcher shim, so it needs a daemon that Switchyard started (see [docs/SETUP.md](docs/SETUP.md#extra-omp-arguments)) |
| `switchyard.sendWhileBusy` | `steer` | Enter while working: `steer` or `followUp` |
| `switchyard.panelLocation` | `beside` | Chat column for editor-tab chats |
| `switchyard.chatLocation` | `editor` | Where clicking a session opens its chat: `editor` or `sidebar` |
| `switchyard.groupBy` | `project` | Sessions view: `project`, your custom `group`s, `status`, or flat `none` |
| `switchyard.sortBy` | `auto` | Order within each group: `auto`, `manual`, `activity`, `priority`, `name`, `created`, `cost`, `scheduled` (next scheduled queue start first, unscheduled last), `completed` (marked completed first, latest first, then the most recently finished) |
| `switchyard.sessionScope` | `workspace` | Which sessions the Sessions view, Tasks view, Board and status bar list: `workspace` or `all` (toggle in the view title) |
| `switchyard.notifications` | `true` | Notify on finish / needs input |
| `switchyard.notifyAllSessions` | `false` | Also notify about sessions outside this window's workspace (started from the terminal, phone or Hermes) |
| `switchyard.sound.completion` | `Two-note comfort` | Cue when a session finishes its turn (Hermes Desktop's cues; `None` silences it); plays only while a Switchyard chat or the Sessions Board is open |
| `switchyard.sound.input` | `Glass ping` | Cue when a session needs input or a queued task fails |
| `switchyard.sound.volume` | `1` | Volume of the cues, 0–1 (0: silent) |
| `switchyard.saveBeforePrompt` | `true` | Save unsaved editors in the session folder before sending a prompt |
| `switchyard.showChangeDecorations` | `true` | Explorer badges, changed-line markers and CodeLens for files omp changed |
| `switchyard.showTodayCost` | `true` | Today's omp spend (from transcripts) in the status bar; hidden on days without model calls |
| `switchyard.dashboard.includeTerminalSessions` | `false` | Dashboard + today's spend also count omp sessions started outside VS Code (all transcripts under `~/.omp/agent/sessions`) |
| `switchyard.snapshotRetentionDays` | `14` | Days a stopped session must be unused before *Clean Up File Snapshots* (and the Doctor) offer to delete its blobs |
| `switchyard.chat.snippets` | `[]` | Prompt snippets offered in the chat composer: `/p:name`, with `{{selection}}` / `{{file}}` |
| `switchyard.terminalHints` | `true` | After a command fails in a terminal in a running session's folder, offer *omp: fix failed command?* in the status bar (needs VS Code shell integration) |
| `switchyard.server.autoStart` | `true` | Start the planner (and AO's daemon) when VS Code opens (clients also start them whenever they need them) |
| `switchyard.server.installService` | `true` | Install the planner as a login service the first time it starts (`config.json` `service`; machine setting) |
| `switchyard.hermes.dashboardUrl` | empty | Hermes dashboard that *Open Hermes Card* opens; empty uses the dashboard Hermes reports running on the machine (any port), else `http://localhost:9119` (forwarded from remote windows) |

## Development

```bash
npm install
npm run watch          # esbuild watch → out/
npm run typecheck
npm test               # unit tests (test:unit)
npm run test:integration  # the planner, CLI and extension code against an isolated AO daemon running a scripted fake omp (needs the `ao` binary)
npm run test:hermes:sounds  # the Hermes page's bell and sounds in a headless Chromium (needs SWITCHYARD_BROWSER_DEPS: a dir with node_modules/{react,react-dom,playwright-core}; skips without)
npm run test:e2e:desktop  # real local VS Code (downloaded to .vscode-test/, xvfb if no DISPLAY) against an isolated AO daemon running the real omp (needs `ao` and a logged-in omp)
npm run install-local  # production build → dist/switchyard-<version>.vsix → installed into ~/.vscode-server
```

- **F5** (*Run Extension*) opens an Extension Development Host with this checkout loaded; over Remote-SSH it runs on the remote like the installed copy. *Run Extension (isolated session state)* uses `.dev-state/` instead of `~/.switchyard`, so experiments don't touch your real sessions.
- Layout: `src/ao` (the only module that talks to AO: client, events, daemon, model), `src/planner` (the planner service), `src/omp-extension` (loaded by omp inside AO sessions), `src/ext` (extension), `src/webview` (chat UI), `src/kanban` (Sessions Board), `src/cli` (`switchyard`), `src/bridge` (VS Code bridge), `src/shared` (helpers and wire contracts). `media/icon.svg` is the source of `media/icon.png`.
- Tests: `npm test` bundles the TypeScript tests into `.test-out/` with esbuild and runs them with `node --test`. Unit tests cover `src/shared`, `src/ao`, the planner and pure webview helpers; integration tests start an isolated AO daemon (`test/ao-fixture.mjs`) against `test/fake-omp-acp.mjs`, a scriptable stand-in for `omp acp` that never calls a model; `test:e2e:desktop` drives a real desktop VS Code (local, Electron extension host) through the extension's commands.

## Publishing

1. Bump `version` in `package.json` and add a `## <version>` section to `CHANGELOG.md`.
2. `git tag v<version> && git push origin main v<version>`: the Release workflow runs the tests, packages the VSIX, publishes to the VS Code Marketplace via Trusted Publishing (GitHub OIDC, no stored token) and to Open VSX (`OVSX_PAT` secret), and opens a GitHub release with the VSIX and the standalone CLI package (`switchyard-<version>.tgz`, from `packaging/cli/pack.mjs`) attached.

One-time setup (publisher, Trusted Publishing policy, Open VSX namespace, screenshots) is in [`docs/PUBLISHING.md`](docs/PUBLISHING.md). All of it is free.

## Limits

- File changes made through `bash` (e.g. `sed -i`, codegen) are not snapshotted; only omp's file-editing tools are (subagents' edits included). Checkpoints and *Revert* therefore don't undo them. Sessions started before the omp extension was installed have no checkpoints until they restart.
- Plan mode refuses file edits through Switchyard's omp extension and asks omp for a plan; omp's terminal-only `/plan` workflow isn't available over AO.
- Voice isn't available in this version; AO's phone app has dictation for typing prompts.
- A machine reboot stops omp processes; AO resumes a session from omp's transcript when you next use it. Planned work continues once the planner runs again (the login service starts it at login); tasks that were running wait as interrupted.
- Every session works in its own worktree. Files that aren't tracked by git (a `.env`, build output) aren't in it unless AO's project setup copies them; sessions started from a folder outside git run in an empty scratch folder.
- AO's own timeline and phone app show omp's undone turns and `/undo` messages; the Switchyard chat hides them.
- Not carried over from omp Sessions: Session Settings (per-session skills, tools and MCP servers), `omp.path`, user MCP servers inside AO sessions, tokens per second and per-answer cost, subagent progress, and the *open in VS Code* button of the phone app.
