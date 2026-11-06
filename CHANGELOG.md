# Changelog

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
