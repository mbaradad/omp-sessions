# Security

## Reporting a vulnerability

Please report vulnerabilities privately, not in public issues:

- GitHub: **Security → Report a vulnerability** on <https://github.com/mbaradad/omp-sessions/security/advisories/new>, or
- email Manel Baradad at <manelbaradad@gmail.com> with "omp-sessions security" in the subject.

Include the version, OS, how you run it (VS Code local or Remote-SSH, the standalone `omp-sessions` command, the phone app, Hermes) and steps to reproduce. You will get an answer within a week. Fixes ship in the next release, and the reporter is credited unless they prefer otherwise. Only the latest released version is supported.

Vulnerabilities in omp itself (the agent, its tools, providers or credentials) belong to the [oh-my-pi](https://omp.sh) project.

## What runs where

Everything runs on the machine with your code, as your user. With VS Code that is where the extension host runs (the extension is a `workspace` extension): your computer for local folders, the remote machine over Remote-SSH, WSL or dev containers.

- **omp-sessions server** (`server.js`): one per user. It launches queued and scheduled sessions and serves the `omp-sessions` command over a local socket. When remote access is on, it also listens on HTTP for the phone app and the API (see [Remote access](#remote-access)). It may run as a systemd user unit or launchd agent, installed the first time it starts unless you turn that off (`omp-sessions config set service off`).
- **Session host** (`host.js`): one detached Node.js process per session. It outlives every client on purpose and stops when you stop the session (or the machine reboots).
- **omp**: each host runs `omp --mode rpc-ui --cwd <folder>` with the binary from `omp.path` (or `PATH`) plus `omp.extraArgs`, as stored in `~/.omp/vscode/launcher.json`. omp is a coding agent: it reads and edits files and runs shell commands in the session folder with your user's permissions. The session host answers its approval prompts according to the session's permission mode (Ask, Edits, Plan, Auto). There is no sandbox beyond that.
- **Chat webview**: renders the transcript in VS Code's sandboxed webview, under a Content Security Policy that allows only the extension's bundled script (nonce) and styles. Remote images in agent output show a placeholder and load only when you click it. Links, including omp's `open_url`, open only after you click them, and only `http`/`https` for `open_url`. Notifications that show titles, paths or omp output render link syntax as plain text.
- **Hermes plugin** (optional): runs the `omp-sessions` command with an argument list (no shell); free text goes after `--` or on stdin. On Windows it runs `node cli.js` directly and never executes a `.cmd` or `.bat` file. Kanban comments reach omp sessions only from trusted authors (`lane.comment_authors`, default `dashboard`), comments never answer approval dialogs, and the Hermes agent can't answer approvals unless `agent_approvals` is on. omp's text passed into Hermes chats is marked as data, not instructions.

## Local IPC

- Clients, the server and hosts talk newline-delimited JSON over **Unix domain sockets**: `~/.omp/vscode/server.sock` and `~/.omp/vscode/sessions/<id>/s.sock`. Sockets are `chmod 0600` and their directories `0700`, so only your user (and root) can connect. When a path is too long for the OS limit, the socket goes in `$TMPDIR/ompv-<uid>/` instead, which is used only if it is a real directory (not a symlink) owned by you with mode `0700`; otherwise the session refuses to start and says why.
- On **Windows** the transport is named pipes with the default pipe security (full access for your user, administrators and SYSTEM only). Every server and host start listens on a fresh random pipe name (`omp-sessions-<32 hex>`, `omp-vscode-<id>-<32 hex>`), which clients read from a file only your user can read (`~/.omp/vscode/server.pipe`, removed when the server exits; the session's `meta.json` for hosts), so another user can't create a pipe with the expected name first. omp's `.cmd` shims run through `cmd.exe` with every argument escaped, never with `shell: true`.
- Anyone who can connect to a socket can drive the session (send prompts, approve tool calls, stop it), so that permission boundary matters. On shared machines, keep your home directory private.

## Remote access

Off by default. When on (`omp-sessions remote on`, *omp: Connect Phone…*), the server listens on the address you chose (Tailscale, LAN, localhost or an IP), port 7413 by default. Every API call needs a 32-byte random token, sent as a bearer token or as the pairing cookie (`HttpOnly`, `SameSite=Strict`, an HMAC of the token rather than the token, `Secure` behind an HTTPS public URL). Failed attempts lock out the address with growing delays. Cookie-authenticated writes must be same-origin JSON, and no CORS headers are sent. Prefer Tailscale or HTTPS: on `lan` the traffic is plain HTTP. Details: [`docs/REMOTE-API.md`](docs/REMOTE-API.md#security-notes).

## Workspace trust

The extension does not run in Restricted Mode (`capabilities.untrustedWorkspaces.supported: false`): starting a session runs an agent that executes commands and loads project configuration (`AGENTS.md`, `.omp/`) from the folder. Trust a folder only if you would run omp in it from a terminal. `omp.path`, `omp.extraArgs` and `omp.server.installService` are machine-scoped, so a workspace's settings can't change which binary runs or with what arguments; a relative `omp.path` such as `./tools/omp` is refused. Virtual workspaces are not supported, because omp needs a real file system.

## Data on disk

All omp Sessions state lives under `~/.omp/vscode/` (`OMP_VSCODE_HOME` overrides it), with directories created `0700`:

| Path | Contents |
| --- | --- |
| `sessions/<id>/meta.json`, `launch.json` | Session folder, title, status, pids, socket path, omp arguments, cost |
| `sessions/<id>/queue.json` | Task queue |
| `sessions/<id>/changes.jsonl`, `blobs/` | Before/after snapshots of every file omp edited, used for diffs and revert. They can contain secrets that were in those files. |
| `sessions/<id>/attachments/` | Files and images you attached to prompts |
| `sessions/<id>/host.log`, `omp-overlay.yml` | Host diagnostics; the omp config overlay the host passes with `--config` |
| `launcher.json` | `omp.path`, `omp.extraArgs`, the default model and the service setting |
| `remote.json` | Remote access settings and token (mode `0600`) |
| `server.log` | Server diagnostics; never contains the token |

omp keeps its own transcripts, settings and provider credentials under `~/.omp/` (see omp's documentation). VS Code's extension and webview storage holds UI state only: unread markers, the side-bar session and composer drafts. Removing a session (Sessions view or `omp-sessions rm`) deletes its `sessions/<id>/` directory. You can also delete that directory by hand while the session is stopped.

## Telemetry

None. omp Sessions makes no network requests of its own and collects no usage data. Model traffic is between omp and the providers you configured in omp.
