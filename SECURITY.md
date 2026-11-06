# Security

## Reporting a vulnerability

Please report vulnerabilities privately, not in public issues:

- GitHub: **Security → Report a vulnerability** on <https://github.com/mbaradad/omp-vscode/security/advisories/new>, or
- email Manel Baradad at <manelbaradad@gmail.com> with "omp-vscode security" in the subject.

Include the extension version, OS, local or Remote-SSH, and steps to reproduce. You will get an answer within a week. Fixes ship in the next release, and the reporter is credited unless they prefer otherwise. Only the latest released version is supported.

Vulnerabilities in omp itself (the agent, its tools, providers or credentials) belong to the [oh-my-pi](https://omp.sh) project.

## What runs where

The extension is a `workspace` extension: it runs in VS Code's extension host. That is your computer for local folders and the remote machine over Remote-SSH, WSL or dev containers. Everything below happens on that machine, as your user:

- **Session host** (`out/host.js`): one detached Node.js process per session, started with VS Code's own Node runtime. It outlives VS Code on purpose and stops when you stop the session (or the machine reboots).
- **omp**: each host runs `omp --mode rpc-ui --cwd <folder>` with the binary from `omp.path` (or `PATH`) plus `omp.extraArgs`. omp is a coding agent: it reads and edits files and runs shell commands in the session folder with your user's permissions, according to its own approval settings. The extension adds no sandbox of its own.
- **Chat webview**: renders the transcript in VS Code's sandboxed webview. It runs under a Content Security Policy that allows only the extension's bundled script (nonce) and styles. Images from `https:` URLs in agent output are loaded and displayed. Links open only after you click them.

## Local IPC

- Hosts and the extension talk newline-delimited JSON over a per-session **Unix domain socket**, `~/.omp/vscode/sessions/<id>/s.sock`. When that path is too long for the OS limit, the socket lives in `$TMPDIR/ompv-<uid>/<id>.sock` instead. The socket is `chmod 0600` and its directories are created `0700`, so only your user (and root) can connect.
- On **Windows** the transport is a named pipe `\\.\pipe\omp-vscode-<id>` with the default pipe security: full access for your user, administrators and SYSTEM only.
- There is no network listener. Anyone who can connect to the socket can drive the session (send prompts, approve tool calls, stop it), so that permission boundary matters. On shared machines, keep your home directory private.

## Workspace trust

The extension does not run in Restricted Mode (`capabilities.untrustedWorkspaces.supported: false`). The reason: starting a session would run an agent that executes commands and loads project configuration (`AGENTS.md`, `.omp/`) from the folder, and the workspace can override `omp.path` / `omp.extraArgs`. Trust a folder only if you would run omp in it from a terminal. Virtual workspaces are not supported either, because omp needs a real file system.

## Data on disk

All extension state lives under `~/.omp/vscode/` (`OMP_VSCODE_HOME` overrides it), with directories created `0700`:

| Path | Contents |
| --- | --- |
| `sessions/<id>/meta.json`, `launch.json` | Session folder, title, status, pids, socket path, omp arguments, cost |
| `sessions/<id>/queue.json` | Task queue |
| `sessions/<id>/changes.jsonl`, `blobs/` | Before/after snapshots of every file omp edited, used for diffs and revert. They can contain secrets that were in those files. |
| `sessions/<id>/attachments/` | Files and images you attached to prompts |
| `sessions/<id>/host.log`, `omp-overlay.yml` | Host diagnostics; the omp config overlay the host passes with `--config` |

omp keeps its own transcripts, settings and provider credentials under `~/.omp/` (see omp's documentation). VS Code's extension and webview storage holds UI state only: unread markers, the side-bar session and composer drafts. Removing a session in the Sessions view deletes its `sessions/<id>/` directory. You can also delete that directory by hand while the session is stopped.

## Telemetry

None. The extension makes no network requests of its own and collects no usage data. Model traffic is between omp and the providers you configured in omp.
