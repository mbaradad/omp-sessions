# Changelog

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
