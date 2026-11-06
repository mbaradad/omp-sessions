# omp Sessions for VS Code

Background [oh-my-pi](https://omp.sh) (`omp`) agent sessions per folder, driven from a VS Code chat panel. Sessions run on the machine VS Code's extension host runs on (the SSH remote), so closing the laptop or dropping the connection does not stop them; reconnecting reattaches.

## Architecture

```
VS Code (Mac) ──Remote-SSH──▶ extension host (remote)
                                 │  Unix socket per session (~/.omp/vscode/sessions/<id>/s.sock)
                                 ▼
                           session host  (out/host.js, double-forked, parent = init)
                                 │  stdio JSONL (omp RPC protocol)
                                 ▼
                           omp --mode rpc-ui --cwd <folder>
```

- **Session host** owns the `omp` process, mirrors the transcript, tracks in-flight messages/tools and pending dialogs, and snapshots every file before/after `edit`/`write`/`ast_edit`/`notebook` tool calls into content-addressed blobs. Any number of VS Code windows can attach; late attachers get a full snapshot.
- **Extension** lists sessions (tree view + status bar), opens chat panels, renders diffs from the snapshots, and restores open panels after a reload/reconnect.
- State lives in `~/.omp/vscode/sessions/<id>/` (`meta.json`, `launch.json`, `changes.jsonl`, `blobs/`, `attachments/`, `host.log`). The omp transcript itself stays in `~/.omp/agent/sessions/`.

## Using it

- **Sessions view** groups sessions by project (git repository, else folder) with working / needs-input counts; `+` on a project starts a session there. *Toggle Group by Project* switches to a flat list.
- `+` starts a session in the workspace folder; *New Session with Options…* picks model, thinking level, approval mode, plan-first / advisor / prewalk / auto-approve, an optional **goal**, and any extra omp CLI flags (remembered for resumes). `Cmd+Alt+O` focuses the chat.
- Composer: Enter sends, Shift+Enter newline, Esc interrupts, ↑/↓ recall earlier prompts, drafts survive reloads; while the agent works Enter steers (`omp.sendWhileBusy`). `/` completes omp's commands plus the extension's (`/new`, `/resume`, `/tree`, `/fork`, `/goal`, `/btw`, `/agents`, `/changes`, `/copy`, `/cost`, `/login`, `/logout`, `/settings`, `/help`, `/exit`); `@` completes files; `!cmd` runs a shell command in the session. Unsaved editors in the session folder are saved before each prompt so omp reads what you see.
- Messages: hover a prompt to **edit & resend** (rewinds the conversation to it) or **fork** from it; hover an answer to copy it and see model/tokens/cost. Code blocks and diffs are syntax-highlighted with your theme's colors; images open full size on click; tool cards show live durations and the turn's elapsed time is in the footer.
- **Attachments**: paste or drop images (sent to the model as images) and any other file — PDFs, docs, archives — (stored under the session's `attachments/` on the remote and handed to omp's read tool). 📎 picks files on the remote disk.
- **Links**: web URLs open in the browser; `file:`/relative/absolute paths (with `:line` or `#L12`) open in the editor; `artifact://`, `local://`, `skill://`, `omp://`, … open their content.
- **Diffs**: edit/write cards show a line diff with old/new line numbers and word-level highlights (click a line to jump there); *Diff* opens VS Code's diff editor for that tool call and *Revert* restores the file to its content before that call; *N files changed* / `/changes` opens a multi-file review of everything the session changed.
- omp questions (`ask`, approvals, selects, inputs) appear as cards above the composer; the session shows **needs input** in the tree/status bar and a notification fires when the chat is not visible. Sessions that finished or asked something while you were away are marked **● new** in the Sessions view and counted on the omp activity-bar badge until you look.
- Stopped sessions keep their transcript; **Resume** restarts omp on the same transcript. *Resume omp Transcript in Background…* adopts any earlier omp session for the folder (e.g. started in a terminal).
- Select code → `Cmd+Alt+K` (or editor context menu → *Send Selection to omp*) inserts `path:lines` plus the snippet into the composer.
- **Code actions** (lightbulb): *Fix with omp* on problems sends the diagnostics plus a snippet; *Explain with omp* / *Ask omp about this…* on a selection. *Add to omp Chat* (Explorer, editor tab, editor context menu; multi-select, folders too) inserts `@path` references; *Send Terminal Selection to omp* (terminal context menu) inserts selected terminal output.
- **Change markers**: files changed by a running session (or a stopped one in this workspace) get a purple `π` badge in the Explorer; open editors mark lines that differ from the content before the session touched the file, with a CodeLens to diff, **Revert** (also on file nodes in the Sessions view), or open the chat.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `omp.path` | auto | omp executable (PATH, `~/.local/bin`, `~/.bun/bin`) |
| `omp.extraArgs` | `[]` | Extra CLI args for new sessions, e.g. `["--model","opus"]` |
| `omp.sendWhileBusy` | `steer` | Enter while working: `steer` or `followUp` |
| `omp.panelLocation` | `beside` | Chat column |
| `omp.groupBy` | `project` | Sessions view: `project` groups or flat `none` |
| `omp.showAllSessions` | `false` | List stopped sessions from other projects |
| `omp.notifications` | `true` | Notify on finish / needs input |
| `omp.saveBeforePrompt` | `true` | Save unsaved editors in the session folder before sending a prompt |
| `omp.showChangeDecorations` | `true` | Explorer badges, changed-line markers and CodeLens for files omp changed |

## Development

```bash
npm install
npm run watch          # esbuild watch → out/
npm run typecheck
npm run install-local  # production build → dist/omp-sessions-<version>.vsix → installed into ~/.vscode-server
```

- **F5** (*Run Extension*) opens an Extension Development Host with this checkout loaded; over Remote-SSH it runs on the remote like the installed copy. *Run Extension (isolated session state)* uses `.dev-state/` instead of `~/.omp/vscode`, so experiments don't touch your real sessions.
- Session hosts already running keep the code they started with. After changing `src/host`, stop + resume a session to pick up the new host.
- Layout: `src/host` (detached session host), `src/ext` (extension), `src/webview` (chat UI), `src/shared` (wire contracts). `media/icon.svg` is the source of `media/icon.png`.

## Publishing

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
2. VS Code Marketplace: create publisher `mbaradad` at <https://marketplace.visualstudio.com/manage>, make an Azure DevOps PAT (scope *Marketplace → Manage*), then `npx vsce login mbaradad` and `npm run publish:vsce`.
3. Open VSX (Cursor, VSCodium, …): create a token at <https://open-vsx.org>, then `OVSX_PAT=… npm run publish:ovsx`.

`vscode:prepublish` runs the typecheck and a minified build automatically for `package` and both publish targets.

## Limits

- File changes made through `bash` (e.g. `sed -i`, codegen) are not snapshotted; only omp's file-editing tools are.
- omp's terminal-only plan mode (`/plan`) is not exposed over its RPC protocol; use *New Session with Options… → Plan first* (`--plan-yolo`).
- A machine reboot stops sessions; their transcripts remain resumable.
