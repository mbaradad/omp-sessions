# Changelog

## 0.6.0

- **Permission modes**: Ask / Edits / Plan / Auto, switchable live from the chat footer, **Shift+Tab**, `/mode`, `/plan`, *Set Permission Mode…* and `omp-vs mode`. omp now always runs with `--approval-mode always-ask` and the session host answers its approval prompts by mode, so the mode holds with VS Code closed and switching resolves approvals already waiting. Plan mode refuses file edits and asks the model for a plan. The mode is remembered across resumes; new sessions start in omp's `tools.approvalMode`, else Auto. Replaces the wizard's *Auto-approve* flag and the approval-mode restart setting.
- **Checkpoints**: undo any turn from the prompt's undo button, *Undo last turn* or `/undo` — the conversation rewinds to before that prompt and the files omp's edit tools changed go back; *Redo* / `/redo` restores both.
- **Voice** (`/voice`, mic button): omp's realtime voice with a live transcript, level meter, mute and end; `omp.voice.name` picks the voice.
- **Terminal UI**: *Continue Session in omp's Terminal UI* (chat header button, `/tui`) opens the session in omp's own TUI beside the chat and hands it back to the background host when the terminal closes.
- **Chat footer**: starred models pinned on top of the model picker, tokens per second, and the provider usage limit when omp reports it.
- **Phone app and HTTP API**: *Connect Phone…* turns on remote access in the `omp-vs` server (Tailscale, local network or localhost) and shows a QR code. The phone web app (installable to the home screen) lists every session by status, follows one live, prompts or steers it, answers approvals and questions, switches its permission mode, stops or resumes it, and starts or queues new sessions in recent folders. The token-authenticated JSON + Server-Sent Events API behind it is documented in `docs/REMOTE-API.md` for other apps and servers. *Disable Remote Access*, *Rotate Remote Access Token*, and `omp-vs remote on|off|status|qr|rotate`.
- **Hermes Agent plugin** (*Install Hermes Plugin…*, `omp-vs hermes install`): native `omp_session_*` tools for Hermes agents, including start, queue, schedule (`at`), status, wait, answer, steer and stop, picking a folder by path, known project or board. Hermes gets a message in the chat when a session it started finishes or needs input. A kanban lane runs cards assigned to `omp` as omp sessions, in the card's workspace or the board's folder, with one omp group per board. Results, questions (`needs_input` blocks) and failures go back to the card, and dependent cards chain as usual. Docs: `docs/HERMES.md`.
- **omp-sessions skill for other agents** (*Install omp Sessions Skill for Agents…*, `omp-vs skill install`): teaches omp, Claude Code, Codex and anything reading `~/.agents/skills` to start, schedule and supervise omp sessions through `omp-vs`. Copies it installed are refreshed when the extension updates.
- `omp-vs` for scripts and agents:
  - `new` gains `--json`, `--mode`, `--tag`, `--group`, `--notes` and `--at` (schedule a queued task);
  - `show [--json]` reports the state, waiting question and full last reply;
  - `wait [--timeout] [--json]` exits 0 when idle, 3 on needs input, 4 when stopped;
  - `answer` replies to a waiting question;
  - `projects [--json]`, `sched --json`;
  - `ls --json` includes session tags.
- Sessions Board: columns lay out as a grid again (cards no longer collapse into one row), and card excerpts drop Markdown markup (also in the phone app).
- README rewritten around use cases, with screenshots and graphics; website at <https://mbaradad.github.io/omp-vscode/>.

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
