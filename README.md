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
- State lives in `~/.omp/vscode/sessions/<id>/` (`meta.json`, `changes.jsonl`, `blobs/`, `host.log`). The omp transcript itself stays in `~/.omp/agent/sessions/`.

## Using it

- **omp** activity-bar view → `+` starts a session in the workspace folder (or right-click a folder in the Explorer → *New Session*). `Cmd+Alt+O` focuses the chat (or starts one).
- Chat: Enter sends, Shift+Enter newline, `/` completes omp slash commands, `@` completes files, Esc / *Stop* interrupts. While the agent works, Enter steers the running turn (`omp.sendWhileBusy` = `followUp` to queue instead).
- Tool cards show inline diffs; **Open diff** opens VS Code's diff editor for that exact tool call. Any existing file path in the transcript is a link (`path:line` jumps to the line).
- Tree: expand a session to see files it changed; click one for a diff from *before the session touched it* to the live file.
- omp questions (`ask`, approvals, selects, inputs) appear as cards above the composer; the session shows **needs input** in the tree/status bar and a notification fires when the chat is not visible.
- Stopped sessions keep their transcript; **Resume** restarts omp on the same transcript. *Resume omp Transcript in Background…* adopts any earlier omp session for the folder (e.g. started in a terminal).
- Select code → `Cmd+Alt+K` (or editor context menu → *Send Selection to omp*) inserts `path:lines` plus the snippet into the composer.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `omp.path` | auto | omp executable (PATH, `~/.local/bin`, `~/.bun/bin`) |
| `omp.extraArgs` | `[]` | Extra CLI args for new sessions, e.g. `["--model","opus"]` |
| `omp.sendWhileBusy` | `steer` | Enter while working: `steer` or `followUp` |
| `omp.panelLocation` | `beside` | Chat column |
| `omp.showAllSessions` | `false` | List stopped sessions from other folders |
| `omp.notifications` | `true` | Notify on finish / needs input |

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
- A machine reboot stops sessions; their transcripts remain resumable.
