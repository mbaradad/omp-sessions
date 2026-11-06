# Changelog

## 0.1.0

Initial release.

- Background omp sessions per folder, hosted by a detached per-session process that survives VS Code / SSH disconnects; panels reattach after reload or reconnect.
- Chat panel: streaming markdown, collapsible thinking, tool cards with inline diffs, clickable file paths, omp dialogs (`ask`, select, confirm, input, editor), slash-command and `@file` completion, model/thinking picker, todos, queued messages.
- Native diffs per tool call and per session (baseline → live file) from host-side file snapshots.
- Sessions tree, status bar counts, notifications on finish / needs input.
- Stop, resume, rename, remove sessions; resume any earlier omp transcript for the folder in the background.
- Send editor selection to the chat.
