# Security

## Reporting a vulnerability

Please report vulnerabilities privately, not in public issues:

- GitHub: **Security → Report a vulnerability** on <https://github.com/mbaradad/omp-sessions/security/advisories/new>, or
- email Manel Baradad at <manelbaradad@gmail.com> with "switchyard security" in the subject.

Include the version, OS, how you run it (VS Code local or Remote-SSH, the standalone `switchyard` command, AO's phone app, Hermes) and steps to reproduce. You will get an answer within a week. Fixes ship in the next release, and the reporter is credited unless they prefer otherwise. Only the latest released version is supported.

Vulnerabilities in omp itself (the agent, its tools, providers or credentials) belong to the [oh-my-pi](https://omp.sh) project. Vulnerabilities in Agent Orchestrator (the daemon, its API, its mobile app, its tunnel) belong to [its project](https://github.com/OrchestratorInc/agent-orchestrator).

## What runs where

Everything runs on the machine with your code, as your user. With VS Code that is where the extension host runs (the extension is a `workspace` extension): your computer for local folders, the remote machine over Remote-SSH, WSL or dev containers.

- **Agent Orchestrator daemon** (`ao daemon`), not part of Switchyard: it runs your sessions, stores their conversations in `~/.ao/data`, and serves the HTTP API that every Switchyard client uses. It may run as a systemd user unit that Switchyard installs the first time it finds no daemon (`ao-daemon.service`), or under AO's desktop app.
- **Chat hosts** (`ao chat-host`): one detached process per session that keeps omp alive across restarts of the daemon. It listens on an ephemeral loopback port and requires a capability from a descriptor file of mode `0600` under the daemon's data directory.
- **omp**: each chat host runs `omp acp` in the session's workspace, a git worktree that AO creates (or a scratch folder outside git). omp is a coding agent: it reads and edits files and runs shell commands with your user's permissions; it is not confined to the worktree. Which tool calls need your approval is decided by the session's permission mode (Ask, Edits, Plan, Auto) as enforced by the Switchyard omp extension, described below. There is no sandbox beyond that.
- **Switchyard planner** (`planner.js`): one per user. It holds your plans and sends tasks to AO's API; it doesn't run agents. It may run as a systemd user unit or launchd agent, installed the first time it starts unless you turn that off (`switchyard config set service off`).
- **Switchyard omp extension** (`~/.omp/agent/extensions/switchyard/`): code that runs inside every omp session AO starts, with omp's permissions. Its checkpoint, permission-mode and omp-id modules do nothing when the `AO_SESSION_ID` variable is missing, so omp sessions you start in a terminal are unaffected by them. It takes before and after snapshots of the files omp's editing tools change, gates tool calls by the session's permission mode, and records the session's omp id. Treat the folder like any other omp extension: it is loaded and run by omp. **The VS Code bridge** is the exception, and it is **on by default**: while the setting `switchyard.vscodeTools` is on, its read-only tools load in any omp session on the machine, terminal sessions included, and let the agent read language-server data of your open VS Code windows (symbols, hover, diagnostics, and the open files and selection). Turn the setting off to stop that: new omp processes then get no bridge tools, and running ones refuse the call.
- **Chat webview**: renders the transcript in VS Code's sandboxed webview, under a Content Security Policy that allows only the extension's bundled script (nonce) and styles. Remote images in agent output show a placeholder and load only when you click it. Links, including omp's `open_url`, open only after you click them, and only `http`/`https` for `open_url`. Notifications that show titles, paths or omp output render link syntax as plain text.
- **Hermes plugin** (optional): runs the `switchyard` command with an argument list (no shell); free text goes after `--` or on stdin. On Windows it runs `node cli.js` directly and never executes a `.cmd` or `.bat` file. Kanban comments reach omp sessions only from trusted authors (`lane.comment_authors`, default `dashboard`), comments never answer approval dialogs, and the Hermes agent can't answer approvals unless `agent_approvals` is on. omp's text passed into Hermes chats is marked as data, not instructions.

## The AO API and its listeners

- AO's primary listener is **loopback only** (`127.0.0.1`, port 3001 by default, the port is in `~/.ao/running.json`) and has **no authentication**. Any process running as any user on the machine can connect to a loopback port, so any local user can read your sessions and drive them (send prompts, approve tool calls). It rejects browser requests (a request with an `Origin` header unless it is AO's own app) and limits CORS to an allow-list. On a shared machine, treat everyone with a login as able to control your sessions: run Switchyard only on a machine you don't share, or in a container or VM of your own.
- The **phone listener** is a second listener, off by default. While pairing is on (`switchyard remote on`, *Switchyard: Connect Phone…*) AO listens on `0.0.0.0` (port 3011 by default) and on its tunnel or Tailscale address. Every request needs the pairing password as `Authorization: Bearer …`; repeated failures lock out the source address; and routes that control the daemon itself return 404 on this listener. The password lives in `~/.ao/data/mobile/config.json` (mode `0600`) and is part of the pairing QR code, which is a secret. `switchyard remote rotate` replaces it and unpairs every phone.
  - The local-network option is plain HTTP: anyone on that network can read the traffic, including the password, and then control your sessions. Use it only on a network you trust.
  - Tailscale pairing uses HTTPS with your tailnet's certificate. The Cloudflare tunnel exposes the listener to the internet through Cloudflare, protected only by the password.
  - Turn pairing off when you don't use it (`switchyard remote off`).
- The **planner** listens on a Unix domain socket `~/.switchyard/planner/planner.sock` (`chmod 0600`, in a `0700` directory). When the path is too long for the OS limit, the socket goes in `$TMPDIR/switchyard-<uid>/`, which is used only if it is a real directory (not a symlink) owned by you with mode `0700`; otherwise the planner refuses to start and says why. On Windows it listens on a named pipe with a random name that only your user can read from a file. Anyone who can connect can change your plans, which start sessions.

## Permission modes

AO fixes omp's approval policy when omp starts. Sessions that Switchyard starts launch omp in AO's *bypass* mode and let the Switchyard omp extension decide, per call, from a per-session mode file (`~/.switchyard/sessions/<AO session id>/mode`):

| Mode | The extension |
| --- | --- |
| **Ask** | asks before every edit and every command |
| **Edits** | lets file edits through and asks before commands |
| **Plan** | refuses file edits (read-only) |
| **Auto** | lets everything through |

- Questions reach you as AO approvals or questions, so they show up in VS Code, the CLI, Hermes and AO's apps.
- **If the extension isn't loaded, nothing asks.** It isn't loaded when it isn't installed in omp's agent folder (`switchyard status` reports it), when `AO_SESSION_ID` is missing, or when the session was started by something other than Switchyard (AO's own app, the AO CLI). Sessions started from AO's own app keep AO's modes. A mode file that is missing or unreadable means no gate.
- The mode file belongs to your user (directories `0700`), like everything under `~/.switchyard/`. Anything running as you can change it, the way anything running as you can edit your code.
- omp itself, and a task's model, can run any command that the mode allows. Prefer Ask or Edits for code you care about, and don't turn Auto on for sessions that read untrusted input.

## Workspace trust

The extension does not run in Restricted Mode (`capabilities.untrustedWorkspaces.supported: false`): starting a session runs an agent that executes commands and loads project configuration (`AGENTS.md`, `.omp/`) from the repository, which AO copies into the session's worktree. Trust a folder only if you would run omp in it from a terminal. `switchyard.server.installService` is machine-scoped, so a workspace's settings can't change which service gets installed. Virtual workspaces are not supported, because omp needs a real file system.

## Data on disk

Switchyard keeps its own state under `~/.switchyard/` (`SWITCHYARD_HOME` overrides it), with directories created `0700`:

| Path | Contents |
| --- | --- |
| `planner/plan.json` | Your plans: tasks, notes, dependencies, schedules, results and the AO session each task ran in |
| `planner/planner.log` | Planner diagnostics; never contains a pairing password |
| `organize.json` | Groups, colors, tags, lanes, order and archive flags, keyed by AO session id |
| `config.json` | Default model, default permission mode and the service setting |
| `sessions/<AO id>/mode` | The session's permission mode |
| `sessions/<AO id>/omp.json` | The session's omp id and transcript path |
| `sessions/<AO id>/checkpoints/` | Before/after snapshots of every file omp edited, used for diffs, undo and revert. **They can contain secrets that were in those files.** |
| `backups/` | The copy of `~/.omp/vscode` that `switchyard migrate` makes before it writes |

AO keeps its own data under `~/.ao/` (`~/.ao/data/ao.db`, the worktrees of your sessions, chat-host descriptors, the phone password); see AO's documentation. A worktree is a full checkout of your repository, so it holds everything the repository holds. omp keeps its own transcripts, settings and provider credentials under `~/.omp/`. VS Code's extension and webview storage holds UI state only: unread markers, the side-bar session and composer drafts.

Removing a session deletes it in AO (`switchyard rm`, or *Remove Session*); AO keeps a worktree that has uncommitted changes, and the session then stays as a terminated session, so no work is lost silently. `~/.switchyard/sessions/<AO id>/` stays until you delete it by hand.

## Telemetry

Switchyard makes no network requests of its own and collects no usage data. AO has telemetry settings of its own; a daemon started by Switchyard, not by AO's desktop app, sends none by default. Model traffic is between omp and the providers you configured in omp.
