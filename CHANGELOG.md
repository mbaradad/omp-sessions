# Changelog

## 0.7.0

**omp Sessions is now Switchyard, a planning layer on Agent Orchestrator (AO).** AO's daemon runs the agents (omp through `omp acp`); Switchyard holds the plans and is a set of clients on AO's API. The old server side is gone.

**New names, no aliases.** Extension `mbaradad.switchyard` (a new Marketplace listing; it installs next to the old one), commands and settings `switchyard.*` (were `omp.*`), CLI `switchyard` (was `omp-sessions`), state in `~/.switchyard` (was `~/.omp/vscode`), env `SWITCHYARD_*`, agent skill `switchyard`, Hermes plugin `switchyard` with tools `switchyard_*` and `hermes switchyard …`. `switchyard migrate [--apply]` imports the old defaults, the concurrency settings and the organization (groups, colors, board lanes); it is a dry run without `--apply`. **No session is migrated**: old sessions stay reachable with `omp --resume <id>`, and `migrate` lists each one.

### Architecture

- **AO runs the agents.** Sessions are AO Chat sessions: detached per-session hosts that survive VS Code, the planner and the daemon restarting. Every session works in its own AO worktree and branch; a folder outside git runs in an empty scratch folder.
- **The planner** (a user service that starts on demand and keeps running with no client open) holds the plans: task graphs with dependencies, queues per session, scheduled and recurring starts, usage-based auto-scheduling with spend budgets, priorities, a global concurrency limit and per-task options (model, thinking, fresh context, retries, timeout). It dispatches the next ready task to AO and reconciles with AO after a restart, so nothing runs twice and an interrupted task is marked, never silently rerun. Git tasks start from their parents' branches, and a merge conflict with a parent shows as needs-input.
- **Switchyard's omp extension** (installed into `~/.omp/agent/extensions/switchyard/`) carries what AO lacks: checkpoints (`/undo` and `/redo` rewind the conversation and the files the edit tools changed), live permission modes (Ask, Edits, Plan, Auto), the todo mirror, and the VS Code language-tools bridge. A small `omp` shim passes extra launch flags.
- **The phone uses AO's mobile app.** *Connect Phone* shows AO's pairing link and QR code. The old phone app, its HTTP API and `remote.json` are gone.
- **Clients on `src/ao`:** the VS Code extension (Sessions, Tasks, board, graph, chat, review, dashboard), the `switchyard` CLI with the same commands, `--json` shapes and `wait` exit codes, the MCP bridge, the Hermes plugin with its kanban lane, and the agent skill.

### Removed

- The omp-sessions server, the per-session host, the phone app and the server's login service; the commands that upgraded session hosts.
- Not carried over: Session Settings (per-session skills, tools and MCP servers), `omp.path`, user MCP servers inside AO sessions, voice mode, tokens per second and per-answer cost, subagent progress, *Resume omp Transcript in Background*, and the *open in VS Code* button of the phone app.

### Also in this release

- **AO's own dashboard, from VS Code and Hermes.** `switchyard dashboard install` takes the web UI of AO's desktop app (project boards, sessions, conversations, artifacts, automations) out of AO's official release (`--release <tag>`, or `--from` a local `.deb`, `app.asar` or built frontend) into `~/.switchyard/ao-dashboard/`, and the planner serves it on `http://127.0.0.1:3012/` (`config set dashboard.port <n>`, `config set dashboard off`) with AO's API, event streams and terminal socket behind it on the same address, so any browser that reaches that address works. AO itself is unchanged: a small script gives the UI the daemon's status and keeps its requests on that address, and the server stands in for the daemon's browser check (loopback names only, no other site's pages). Switchyard keeps owning AO's chat hibernation; the UI's Developer Mode doesn't change it. `switchyard dashboard status|url|uninstall`; `switchyard status` and the Doctor report it.
  - **VS Code**: *Open AO Dashboard* (Sessions view `…` menu, Command Center) shows it in an editor tab, through VS Code's port forwarding over Remote-SSH and WSL; it starts the planner when needed and offers *Install AO Dashboard* when the UI is missing.
  - **Hermes**: an **AO dashboard** tab on the Switchyard page embeds it through the plugin (`/api/plugins/switchyard/ao/`, behind the dashboard's sign-in). Hermes Desktop opens it in the browser instead (its sign-in token can't reach an embedded page), the legacy token mode can't embed it, and AO's terminal panes don't connect through Hermes.
  - Not available outside AO's desktop app: its built-in browser panel, opening folders and editors on your computer, desktop notifications and cloud sign-in. Over plain HTTP a browser keeps about one dashboard tab live at a time (each holds several event streams).
- **Hermes: dependency graph of a board's cards.** The Switchyard page in the Hermes dashboard and Desktop has a **Graph** view: a board's kanban cards laid out left to right from parent to child (a child waits for its parents), coloured by card status, with the state of the omp session working on each card (the lane's, or a session tagged with the card). Edges from finished parents are solid, the rest dashed. By default it shows only cards linked to another card; **Linked cards only** switches to every card. Clicking a card shows what it waits for and unblocks, and opens its omp session's detail when it has one. The page's backend reports `parents` and `children` for every card it returns (`/boards` cards, linked and ready lists, and a session's `card`), read in one batch per board; a Hermes without card links reports none.

## 0.6.2

- Queued tasks' durations and retry backoff, and `omp-sessions wait`'s timeout and settle time, use the monotonic clock: a wall clock that steps (NTP, WSL2) no longer gives negative durations or stretches and cuts waits. Sessions waiting for a concurrency slot are served in arrival order, so a clock stepping back no longer lets a later one cut in, and a finished queued task is saved as done before its slot is freed, so under a limit of 1 no one sees two queued tasks running at once.
- A reply to a prompt sent while its session was still starting (`omp-sessions new` with a prompt, the HTTP API) could be missing from the session's history for anyone opening it later: the host's startup read of the transcript no longer overwrites messages that arrived with it.
- Following a session (`omp-sessions attach`/`tail`, the phone app's live stream, server subscriptions) no longer misses what the host sends right after its snapshot, such as an approval question asked at that moment.

## 0.6.1

- **Default permission mode for new sessions**: `omp-sessions config set mode auto|edits|ask|plan` (or *Set Default Permission Mode for New Sessions…* in VS Code) sets the mode every client's new sessions start in when they ask for none; `omp-sessions status`, `config` and the Doctor show it. Order: the session's own mode, then this default, then omp's `tools.approvalMode`, then Auto.
- Agents no longer pick a stopping mode on their own: the omp-sessions skill and the Hermes tools tell them to leave the mode unset (the user's default, normally Auto) unless the user asks, since Edits and Ask wait for a person at the first command.
- `hermes omp status` and the Hermes page list only boards that still exist; a service unit's `PATH` no longer repeats entries.
- Resuming a session right after it stopped could still leave it unreachable when the file system reused the old socket's inode: the stopping host now closes its socket before anything else can bind there.
- The HTTP API reads the body of a request it refuses (wrong content type, origin or auth) before answering, so clients get the error instead of a reset connection.

## 0.6.0

omp Sessions is now a task server for omp coding agents: the `omp-sessions` server keeps sessions running in the background, organized by project folder, with a task queue per session, scheduled starts and a global concurrency limit. The `omp-sessions` command, VS Code, the phone app, the HTTP API and Hermes Agent are clients of the same sessions, and any session opens in VS Code with the full chat.

**Upgrading from 0.5.0:** the terminal command is now `omp-sessions` (was `omp-vs`), with environment variables `OMP_SESSIONS_*` and the Hermes plugin setting `omp_sessions`. The extension (or `omp-sessions server install`) replaces the old launcher and login service on its own and running sessions keep going. On Windows, add `%LOCALAPPDATA%\omp-sessions` to PATH. The repository moved to <https://github.com/mbaradad/omp-sessions> and the website to <https://mbaradad.github.io/omp-sessions/>; old GitHub URLs redirect.

### Server and CLI

- **The server stays up.** Any client starts it when needed, and the first start installs it as a login service (systemd user unit, launchd agent) so it comes back after a crash or reboot; you're told once. It isn't installed when the only Node is VS Code's own runtime, and a service whose Node or `server.js` has moved is rewritten on the next start. Turn auto-install off with `omp-sessions config set service off` or `omp.server.installService` (VS Code's *Turn Off* also removes the service); `omp-sessions server uninstall` removes an installed service. Service restarts go through systemd/launchd, and reinstalling on macOS replaces the loaded agent.
- **Standalone install:** each GitHub release carries `omp-sessions-<version>.tgz`; `npm install -g <its URL>` installs the command, server, phone app, skill and Hermes plugin on a machine without VS Code (Node 22+).
- **`omp-sessions status [--json]`**: server (pid, version, uptime), login service, omp path, default model, sessions by state, pending and running tasks, scheduler and remote access, with a list of problems; exits 1 when something is wrong and never starts the server.
- **`omp-sessions config`** shows and sets the settings every client shares (`launcher.json`): `omp.path`, `omp.extraArgs`, `model`, `service`.
- **Models:** `omp-sessions models [search]` lists the models omp can use and marks the default; `omp-sessions model <session> [provider/id]` shows or switches a session's model (live, or from its next resume). New sessions use an explicit model, else the project's defaults / `omp.extraArgs`, else the omp Sessions default (`config set model`, which refuses a model omp doesn't list unless `--force`, or *Set Default Model for New Sessions…* in VS Code), else omp's own.
- **`ls`** shows sessions with work ahead (queued, scheduled, interrupted) with their state, and filters by `--project` (project roots, as `projects` lists them), `--cwd`, `--group`, `--tag` and `--state`. `board` has an Interrupted column.
- **`--json`** on `board`, `queue`, `server status`, `remote`, `version`, `stop`, `resume`, `send`, `answer`, `abort`, `config`, `models` and `model`, besides `new`, `show`, `wait`, `projects`, `sched` and `ls`.
- **For scripts and agents:** `new` gains `--mode`, `--model`, `--tag`, `--group`, `--notes`, `--at` and `--json`, and returns once the host is up. `show` reports state, waiting question and full last reply. `wait` exits 0 idle, 3 needs input, 4 stopped or interrupted, 5 scheduled, 124 on timeout. `answer --question <id>` refuses if another question came first. `send --wait` exits like `wait`.
- `send` now waits for the current turn to end (a follow-up); `--steer` redirects the turn instead.
- `omp-sessions vscode [session | path] [--folder dir] [--authority a]` opens a session, a project's checkout or exactly a folder in VS Code on this machine, and prints the link for a Remote-SSH window (`--authority ssh-remote+box` builds it even before that window has been used).
- `help <command>` and `<command> --help` print one command; `--version`/`-v`; every command rejects flags it doesn't take (exit 2); text starting with `--` goes after `--`; impossible start times (`25:99`, a past ISO time) are rejected. `queue <session> add` takes `--notes` (or `-`: the first stdin line is the title, the rest the notes).

### Sessions and queue

- **New states:** `scheduled` (waiting for its start time; no longer counted as finished) and `interrupted` (a crash or reboot cut a queued task short), in `ls`, the board, the phone, Hermes and `show`.
- **Reboots and crashes:** queued work that hadn't started is relaunched by the server. A task that was running goes back to pending, marked interrupted, and its queue pauses: it never reruns without a person (run it again with `queue <session> run` or the phone's *Continue*, or reschedule it with `queue <session> at …`).
- **Resume after a crash** continues the turn the session was in (one follow-up prompt, with a notice in the chat). `--restore` is no longer used.
- `stop` on a scheduled session cancels its start; on a running session it pauses the queue first, so the server doesn't start it again.
- When omp exits with an error, the stop reason includes its last error line.
- Only one server and one host per session run at a time, also across reboots (pid files record boot and process start time).
- Titles: omp's own session name is adopted; only an explicit `--title` or a rename is sent to omp.
- **omp data:** history, adopt, search and the usage dashboard follow omp profiles, XDG folders and `--session-dir`, and include transcripts `omp gc` archived; resuming an archived session restores it, and a deleted transcript starts a new conversation with a warning.
- **One cost number:** a session's cost is the same in `ls`, the phone, Hermes, the skill and the dashboard, and counts subagents, side calls and every transcript the session used. Task cost includes subagents. Sessions that switched transcripts before this version may show less cost.
- Opening a session to look at it no longer counts as activity, so lists don't reorder.
- *Hide Finished Sessions* in VS Code keeps sessions with queued, scheduled or interrupted work.

### VS Code

- **Permission modes:** Ask / Edits / Plan / Auto, switchable live from the chat footer, **Shift+Tab**, `/mode`, `/plan`, *Set Permission Mode…*, the phone or `omp-sessions mode`. The session host answers omp's approval prompts by mode, so it holds with VS Code closed; switching resolves approvals already waiting. Plan refuses edits and asks for a plan. New sessions start in omp's `tools.approvalMode`, else Auto.
- **Checkpoints:** undo any turn (prompt's undo button, *Undo last turn*, `/undo`): the conversation rewinds and the files omp's edit tools changed go back; *Redo* / `/redo` restores both.
- **Voice** (`/voice`, mic button): omp's realtime voice with live transcript; `omp.voice.name` picks the voice.
- **Terminal UI:** *Continue Session in omp's Terminal UI* (`/tui`) opens the session in omp's TUI beside the chat and hands it back when the terminal closes.
- **Chat footer:** starred models on top of the model picker, tokens per second, and the provider's usage limit.
- **This workspace or all sessions:** `omp.sessionScope` (toggle in the Sessions view title) chooses whether the Sessions view, Tasks view, Board and status bar list this workspace's sessions or every session on the machine; it replaces `omp.showAllSessions` (migrated once). `omp.notifyAllSessions` extends notifications to sessions outside the workspace.
- **Open in VS Code** from the terminal, the phone and Hermes picks the right window: the caller's Remote-SSH authority, then a window that has the session's folder, then the last used one; remote links open that window's workspace or the git checkout. `vscode://mbaradad.omp-sessions/open?session=<id>` is handled.
- *Show Hermes Card* shows the card in a read-only output channel instead of typing into a terminal.
- **omp Doctor's server section**, from `omp-sessions status --json`: the server (pid, version against the extension's, uptime), the login service (installed, serving this data home, its Node and `server.js` still there), the omp sessions start with and the last launch error, the default model, the scheduler and remote access, with fixes: *Start omp-sessions Server*, *Install omp-sessions Login Service* (also repairs one), *Restart*, *Show omp-sessions Status in Terminal*.
- Sessions Board columns lay out as a grid again; card excerpts drop Markdown markup.

### Phone and HTTP API

- **Phone app:** *Connect Phone…* or `omp-sessions remote on|off|status|qr|rotate` turns on remote access in the server (Tailscale, local network or localhost) and shows a QR code. The installable web app shows a status line, groups sessions by state (needs input, interrupted, working, queued & scheduled, idle, stopped), follows one live, prompts it (*Steer* or *After turn* while it works), answers approvals and questions, switches mode and model, stops, resumes, unqueues, cancels a schedule or continues an interrupted session, opens it in VS Code, and starts or queues new sessions in recent folders.
- **HTTP API** (token-protected JSON + Server-Sent Events, `docs/REMOTE-API.md`), now with `GET /api/status`, `GET /api/models`, `POST /api/sessions/:id/model`, `POST /api/sessions/:id/vscode` and `POST /api/sessions/:id/continue`.
- **Behind Tailscale Serve or an HTTPS proxy:** `remote on --bind localhost --url https://…` puts that URL in the pairing link, so the phone uses HTTPS with a real certificate; *Connect Phone…* recommends it in WSL with Tailscale on Windows. The pairing page has **Open in Browser**.

### Hermes Agent

- **Plugin** (*Install Hermes Plugin…*, `omp-sessions hermes install`, or `hermes plugins install mbaradad/omp-sessions/integrations/hermes/omp-sessions --enable`) with **14 tools**: list sessions, projects and models; start (now, queued or scheduled, with priority and model); add a task (title plus full notes) to a queue or schedule it; status, wait, send, answer, mode, model, stop; and server status.
- **Notifications:** the Hermes chat that started a session hears when it finishes or needs input.
- **Kanban lane:** cards assigned to `omp` run as omp sessions in the card's workspace or the board's folder, one omp group per board, with an optional per-board `model`; results, questions and failures go back to the card and dependent cards chain. Scheduled sessions keep the card claimed; an interrupted one blocks it until you unblock it, which continues the same session.
- **Comments:** comments from trusted authors (`lane.comment_authors`, default `dashboard`, which covers the dashboard and Hermes Console) answer omp's questions or reach the session as a follow-up, and `@omp` assigns the card to omp. Approvals are never answered by comments. Failed deliveries are retried and reported.
- **Approvals stay with people:** unless `agent_approvals: true`, the Hermes agent can't answer approval dialogs, switch the mode while one waits, or switch a session to a less restrictive mode (plan < ask < edits < auto). Answers from tools and the page carry the question's id, so a stale answer fails instead of answering a different dialog.
- **omp Sessions page** in the Hermes dashboard and Hermes Desktop: sessions in columns (needs you, working, queued and scheduled, done, stopped), a detail panel to answer, follow up, switch mode or model and stop, **VS Code** and **Open project in VS Code** buttons, *New session* with a model picker, and a Boards view with each board's lane settings (folder, group, mode, model, comment authors).
- `/omp` in a chat is a short summary counting sessions in every state; `/omp take <card>` (or `hermes omp take`) hands an existing card to omp, also from Hermes Console.
- `hermes omp status` and the page show the kanban dispatcher's last tick, warn when the lane is on in the wrong profile, and report whether the last notification was delivered.
- The plugin updates itself when the extension updates, in every profile, reloading it in the running gateway; omp Doctor checks plugin, notifications, dispatcher, lane and whether `omp-sessions` is found, with one-click fixes.
- The page's New session dialog and the model switcher show why the model list failed, with *Retry*.
- **omp-sessions skill** (*Install omp Sessions Skill for Agents…*, `omp-sessions skill install`) teaches omp, Claude Code, Codex and Hermes to start, schedule and supervise sessions through `omp-sessions`.

### Security

- `omp.path` and `omp.extraArgs` are machine-scoped (a workspace can't set them) and a relative `omp.path` is refused.
- The phone's pairing cookie holds an HMAC of the token, is `__Host-` and `Secure` behind HTTPS, and is replaced for phones paired by 0.5.0. After `remote rotate`, old cookies are told to pair again without counting toward the lockout. Lockouts are capped and survive a flood of failures; `X-Forwarded-For` is trusted only behind a local proxy.
- Windows: every server and host start listens on a fresh random pipe name that clients read from a user-only file; `.cmd` shims run through `cmd.exe` with escaped arguments; the Hermes plugin never runs `.cmd`/`.bat` files.
- The fallback socket folder in `/tmp` is used only if it is a real folder owned by you with mode 0700.
- The chat loads remote images only on click and opens omp's `open_url` only for http/https links after you click. Notifications render link syntax in untrusted text as plain text, and the URI handler validates session ids.
- The Hermes plugin passes free text after `--` or on stdin, ignores skill names with path separators, wraps comments and omp output as data, and its VS Code redirect page follows only VS Code links.

### Fixes

- Resuming a session right after stopping it no longer leaves it unreachable.
- `omp-sessions server install` no longer leaves the server stopped.
- `hermes omp board … --remove`, clearing a board setting and `hermes omp project --remove` take effect.
- `omp-sessions hermes` acts on the default Hermes home without a profile flag, not on the sticky `hermes profile use` profile.
- Hermes on more setups: the dashboard at any port, Windows homes and launchers, `HERMES_HOME` with `~`.

## 0.5.0

- **`omp-vs` terminal command** (*omp: Install omp-vs Command*): `ls`, `board`, `new` (prompt, or `--task` to queue), `attach` (streaming chat with inline dialogs, Ctrl-C aborts, Ctrl-D detaches), `send [--wait]`, `tail [-f]`, `stop`/`resume`/`rm`/`abort`, `queue …` (add/run/start/pause/retry/done/skip/`at +30m`), `prio`/`color`/`group`/`move`/`archive`, `sched …`, `server …`. Sessions are named by id prefix, title words or `.`; `ls` hides finished sessions unless `--all`.
- **omp-vs server**: a per-user daemon that starts stopped sessions whose queue has runnable work when a concurrency slot frees up (priority + manual order, ranked together with hosts already waiting), so queued work also resumes after a reboot. It stops the sessions it launched once their queue is done and no chat/`attach` is open, backs off exponentially from sessions that die right after launch, and never reruns a task a crash interrupted. The extension installs a stable runtime copy and keeps the server at its version (`omp.server.autoStart`); `omp-vs server install` adds a systemd user unit / launchd agent. *Restart omp-vs Server*, *Show omp-vs Server Log*.
- **Hide Finished Sessions** (eye button in the Sessions view): hides stopped sessions; unread ones stay until seen, and the view header shows how many are hidden.
- Sessions view: *Group Sessions By…* now offers custom groups and status, the new `omp.sortBy` setting backs *Sort Sessions By…*, and the organize/scheduler commands (filter, groups, color, priority, tags, lanes, pin, archive, move, bulk stop/resume/remove, concurrency) appear in the view and context menus.
- Session hosts publish how many people are attached (`viewers`) and when someone last typed (`userActiveAt`).

## 0.4.0

- **Command Center** (`Ctrl/Cmd+Alt+P`): a searchable, grouped index of every omp command — session, task, worktree, queue, git, dashboard, session — plus omp's own CLI features surfaced as VS Code commands (*login, update, setup, plugins, skills, usage, stats, models, cleanse, commit in terminal, git UI, continue in terminal, import Claude/Codex, open docs/config, keyboard shortcuts*). *Fix with omp / Explain / Ask about…* code actions join the existing editor integration; new *Edit with omp* (`Ctrl/Cmd+Alt+E`), *Fix File/Workspace Problems*, *Fix Failed Command*, *Write Tests*, *Add Docs*.
- **Git worktrees**: *New Session in Git Worktree…* (sibling `<repo>.worktrees`, `omp/<task>` branch, any base branch/tag/commit) and *Best-of-N* — the same task in N parallel worktree sessions. Worktrees group under the main repo in the Sessions view; *Compare Worktree Branch with Base*, *Merge into Main Checkout…*, *Open in New Window*, *Remove Worktree and Session*.
- **Sessions Board** (*Open Sessions Board*): a kanban of every session with drag & drop and keyboard moves. Columns by status, swimlane, group, or priority; lanes (Backlog / To Do / In Progress / Review / Done) are editable; one row per project in swimlane mode. Per-card and bulk: priority (P to cycle), color, pin, archive, tags, stop/resume/open, queue progress, cost, last text, unread. A global concurrency counter sits in the header (see below).
- **Organization**: groups (nested, colored, iconed), colors, priorities, pins, archive, and tags on sessions — in the tree (drag & drop, context menus) and the board. Sessions view filters (text, `#tag`, `project:name`), manual sort, and group collapse persist in `organize.json`.
- **Global concurrency scheduler**: queue tasks across all sessions now respect a shared limit (`scheduler.json`, honored by the session host with VS Code closed). Status-bar counter "2/3 running · 5 waiting"; *Set Concurrency…*, *Increase/Decrease*, *Pause/Resume Queued Tasks*. A queued task waiting for a slot shows its position in the tree and on the board.
- **Task queue extensions**: per-task *Options…* (model, thinking, fresh context, retries, timeout), *Duplicate Task*, *Retry Failed Tasks*, and *Schedule Queue Start…* (`HH:MM`, a date, or `+30m/+2h`). The host applies each task's model/thinking/retries.
- **Usage dashboard** (*Usage Dashboard*): sessions, cost, and token trends over a chosen range; *Show Today's Spend* in the status bar; *Search Session History…* across every transcript (open the session, resume, or read the transcript).
- **VS Code bridge**: omp sessions can call this window's language features through a per-session MCP server (`out/mcp.js` → JSONL socket → extension). Symbol links in chat resolve to the right file/line; hover docs and diagnostics are exposed to the model. *VS Code Bridge: Show Status* reports connected windows, the MCP script, and a round-trip probe. Per-session *Session Settings…* toggles skills, tools, and MCP servers (with a tooltip chip when non-default).
- **Doctor** (*Run Doctor*): a report of omp/session health — missing omp, auth problems (no API key / not logged in), outdated hosts, and hosts that died mid-turn — with one-click fixes (*mark stopped*, *resume*, *upgrade host*). *Copy Diagnostics*, *Upgrade Session Host(s)*, *Clean Up File Snapshots*. Crashed sessions offer *--restore* on resume.
- **Chat**: `@`-mention completion, in-chat find, *Copy/Save as Markdown* and *Export as HTML*, `omp.snippets` prompt snippets, per-message timestamps, and tail-first rendering of long transcripts (last turns first, *Show earlier messages*).
- **Robustness / packaging**: shared launch/host-version code, session discovery for worktrees and Claude/Codex, `.vscodeignore` allowlist, CI + release workflows, `docs/` (publishing guide, security, contributing). Tests: unit + session-host + desktop end-to-end suites (all green).

## 0.3.0

- Task queue owned by the background session host: tasks with subtasks run one after another even with VS Code closed. **Tasks** view with drag & drop (also across sessions), checkboxes, run now / start / pause, details editing and omp's own plan; `/queue`, Alt+Enter and a queue bar in the chat.
- **Chat** view in the omp side bar (movable to the secondary side bar); *Open in Side Bar* / *Open in Editor Tab*, `omp.chatLocation`.
- Source Control menu: *Commit with omp*, *Review Uncommitted Changes with omp*, *Write PR Description with omp*.
- Getting-started walkthrough.
- Local desktop VS Code (macOS/Linux) supported alongside Remote-SSH; Windows named pipes and `.cmd` shims handled.
- Robustness: duplicate-host guard, missing folder / omp binary reported as the stop reason, stale sockets replaced, readline/socket error handling, snapshots taken before omp's edit lands; a host whose session folder was deleted still shuts down cleanly.
- Long transcripts render their last turns first with *Show earlier messages* (a 1000-message session attaches in under 100 ms); chat messages stay centered with the composer on wide panels.
- Tests: unit + session-host suites against a scripted fake omp, desktop VS Code end-to-end suite.

## 0.2.0

- Editor integration: *Fix with omp* / *Explain with omp* / *Ask omp about this…* code actions, *Add to omp Chat* (Explorer, editor tab, editor menu), *Send Terminal Selection to omp*.
- Change awareness: Explorer `π` badges on files a session changed, changed-line markers in open editors, CodeLens with session diff / Revert / Open chat; Revert from the Sessions view and per tool call in the chat.
- Background awareness: sessions that finished or asked something while unattended are marked **● new** and counted on the activity-bar badge; session cost in tooltips.
- Composer: ↑/↓ prompt history, drafts persist across reloads, unsaved editors in the session folder are saved before prompting (`omp.saveBeforePrompt`).
- Messages: edit & resend / fork from any of your prompts; per-answer model, tokens and cost; syntax-highlighted code blocks and diffs; image lightbox; live tool durations and turn timer; collapse/expand all tool cards.
- Shell commands, command output, notices and side questions now persist across window reloads.
- Fixes: async `task` cards no longer flip back to running; subagent rows deduplicated with readable descriptions; fork notices survive the transcript switch.
- New omp-brand icon; version bump refreshes cached activity-bar icons.

## 0.1.0

Initial release.

- Background omp sessions per folder, hosted by a detached per-session process that survives VS Code / SSH disconnects; panels reattach after reload or reconnect.
- Sessions view grouped by project (git repository or folder) with live working / needs-input counts; flat mode via *Toggle Group by Project*.
- *New Session with Options…*: model, thinking, approval mode, plan-first / advisor / prewalk / auto-approve, goal, extra CLI flags; options persist across resumes. Goals auto-continue as in the TUI.
- Chat panel: streaming markdown with copyable code blocks, collapsible thinking, tool cards, subagent progress, omp dialogs (`ask`, select, confirm, input, editor), side questions, ANSI-colored command output, slash-command and `@file` completion, model/thinking picker, todos, queued messages.
- Extension-side commands for TUI features omp's RPC lacks: `/new`, `/resume`, `/tree`, `/fork`, `/goal`, `/btw`, `/agents`, `/changes`, `/copy`, `/cost`, `/login`, `/logout`, `/settings`, `/help`, `/exit`; `!cmd` shell commands.
- Attachments: paste/drop/pick images (sent as model images) and any other file (staged on the remote for omp's read tool).
- Links everywhere: web URLs, files with line numbers, and omp internal URLs (`artifact://`, `local://`, `skill://`, `omp://`, …).
- Diffs: line diffs with old/new numbers and word highlights in the chat, per-tool-call VS Code diffs, and a multi-file review of all session changes.
- Status bar counts, notifications on finish / needs input; stop, resume, rename, remove sessions; send editor selection to the chat.
