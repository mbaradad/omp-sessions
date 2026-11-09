# Setting up Switchyard, Hermes and your phone

Switchyard works the same whether everything runs on the computer in front of you or on a workstation or server you reach over SSH. This guide covers both, with Hermes Agent and the phone app as optional extras. The steps are the same; only *where* they run changes.

| Arrangement | The machine with the code runs | You work from |
| --- | --- | --- |
| **Local**: one computer (Linux or macOS) | everything below | the same computer, plus your phone |
| **Remote**: a workstation or server | everything below | a laptop (the `switchyard` command over SSH, VS Code Remote-SSH, Hermes Desktop in remote mode) and your phone |

**Windows**: run omp, AO, the planner and Hermes in WSL 2 and use VS Code through a *WSL* window. For the phone, see [WSL 2 and the phone](REMOTE-API.md#windows-with-wsl-2). Native Windows is handled but untested.

"The machine" below means the computer with your repositories: your own computer in the local arrangement, the workstation or server in the remote one. omp, Agent Orchestrator, the planner, every session, Hermes and the plugin run there, so closing the laptop or losing signal never stops work.

## What runs where

| Piece | What it does | Runs as |
| --- | --- | --- |
| **omp** | the coding agent | one `omp acp` process per session, started by AO |
| **Agent Orchestrator (AO)** | runs the sessions: per-session hosts that outlive every client, the chat history, approvals, worktrees, the phone listener, notifications | `ao daemon`, a user service |
| **The Switchyard planner** | holds your plans (task graphs, queues, schedules, priorities, the concurrency limit) and sends each ready task to AO | `switchyard-planner`, a user service |
| **Switchyard omp extension** | per-session checkpoints (undo and redo of a turn, files included), permission modes, the todo list, the link from an AO session to its omp transcript | loaded by omp inside each AO session |
| **Clients** | VS Code, the `switchyard` command, the MCP bridge, the Hermes plugin, the agent skill | where you use them |

Sessions never depend on the planner or on a client. If the planner is down, running sessions keep working; queued and scheduled work waits until it is back.

## 1. omp, AO and Switchyard

1. **omp** on the machine: `curl -fsSL https://omp.sh/install | sh`, then sign in to a model provider (run `omp`, then `/login`). AO needs omp 15.0.0 or newer.
2. **Agent Orchestrator** on the machine, one of:
   - **The AO desktop app** from [orchestrator.inc](https://orchestrator.inc/download/) (macOS, Windows, Linux). It owns the daemon and starts it for you; Switchyard finds it. Use this on a computer with a screen.
   - **Headless** (a server or a WSL 2 distribution): AO publishes no bare binary yet, so build it. You need Git and Go 1.27 or newer (`GOTOOLCHAIN=auto` downloads the right toolchain):
     ```sh
     git clone https://github.com/OrchestratorInc/agent-orchestrator
     cd agent-orchestrator/backend
     GOTOOLCHAIN=auto go build -o ~/.local/bin/ao ./cmd/ao
     ```
     AO's own installer for a fresh Ubuntu VM (`scripts/bootstrap-self-hosted.sh`, see AO's [self-hosted guide](https://github.com/OrchestratorInc/agent-orchestrator/blob/main/docs/self-hosted-remote.md)) also works; it signs the VM in to an AO account and sets up a tunnel, which you may not want.
   
   With the binary on `PATH` (or `~/.local/bin`, or `AO_BIN`), you don't start anything by hand: the first `switchyard` command or VS Code window that finds no daemon starts `ao daemon` as a systemd user unit (`ao-daemon.service`, enabled, with `KillMode=process` so that running sessions survive a restart of the daemon), or as a detached process where there is no systemd.
3. **Switchyard**, one of:
   - **The VS Code extension**: install **Switchyard**. Remote: connect VS Code to the machine with Remote-SSH (or WSL, or a dev container) first; the Extensions view installs it on that side, which is where it runs. Then run **Switchyard: Install switchyard Command** for the terminal command. The extension also installs the Switchyard omp extension into omp's agent folder (`~/.omp/agent/extensions/switchyard/`).
   - **Only the command** (a headless server, or no VS Code): with Node 22+, `npm install -g <the switchyard package>` and `switchyard omp-extension install`.
4. **Check it**, in a terminal on the machine:
   ```sh
   switchyard status          # AO daemon, omp, the planner, default model, sessions, problems (exit 1 if any)
   switchyard config set model anthropic/claude-sonnet-4-5   # optional: default model of new sessions (one `switchyard models` lists)
   ```
   `switchyard status` says what is missing. The planner is started on demand and installed as a login service the first time (a systemd user unit `switchyard-planner.service` on Linux, a launchd agent `dev.switchyard.planner` on macOS), so queued and scheduled work keeps running after a crash or reboot. It needs Node 22+ on PATH; with only VS Code's own runtime (as over Remote-SSH without Node installed), the planner still starts on demand but isn't installed as a service, and `switchyard status` says why. `switchyard server install` does it by hand, `switchyard config set service off` stops it from happening by itself, `switchyard server uninstall` removes it. On a Linux server, run `loginctl enable-linger $USER` so user services keep running when nobody is logged in.

That is all Switchyard needs. The rest is optional.

### Every session gets its own worktree

AO runs each session in its own git worktree, on a branch `ao/<session>/root` made from the repository's default branch, under `~/.ao/data/worktrees/<project>/<session>`. Two sessions never overwrite each other, and your checkout stays as it is until you merge (*Merge into Main Checkout…* in VS Code, or `git merge ao/<session>/root`). A folder outside git gets an empty scratch folder instead, so start sessions that need your files from a git repository.

The editor actions that work on what you are looking at (*Fix with omp*, *Commit with omp*, *Review Uncommitted Changes*, …) tell the session where your working copy is, so they edit your checkout, not the worktree.

A repository without a remote needs a default branch for AO: `git remote set-head origin main`, or Switchyard sets `defaultBranch` on the AO project for you.

### Idle sessions and chat hibernation

A finished session keeps its omp process (and its memory) until AO hibernates it. AO does that only when its chat-hibernation setting is on, and a daemon started without AO's desktop app starts with it **off**, so idle omp processes stay up. To turn it on:

```sh
curl -X PATCH http://127.0.0.1:$(jq -r .port ~/.ao/running.json)/api/v1/settings/chat-hibernation -H 'content-type: application/json' -d '{"enabled":true}'
```

About 100 seconds after a turn settles, an unwatched chat then stops its omp process and keeps its transcript; the next message wakes it (the first turn after a wake takes about 10 seconds). It is a daemon-wide AO setting that also affects your other AO sessions, so Switchyard does not change it for you; `switchyard status` tells you when it is off. Whether the setting survives a restart of the daemon is not verified: check `GET /api/v1/settings` (`chatHibernationEnabled`) after one.

### Extra omp arguments

AO starts omp as `omp acp` with a fixed set of flags and has no setting for more. Switchyard adds a small `omp` launcher in `~/.switchyard/bin/` and puts that folder first on the PATH of the AO daemon it starts. For `omp acp` inside an AO session the launcher appends your extra arguments and runs the real omp; for everything else it just runs omp. Set them with `switchyard config set omp.extraArgs --profile work` (machine-wide), in VS Code with *New Session with Options…* or `switchyard new … -- <flags>` (one session; applied by a restart before the first prompt), or per project through the AO project's environment variable `SWITCHYARD_OMP_ARGS`.

If the daemon is not one that Switchyard started (the AO desktop app owns it), put `~/.switchyard/bin` first on that daemon's PATH yourself, or the arguments are ignored. `switchyard status` says whether the launcher is in effect.

### Coming from omp Sessions

`switchyard migrate` moves your settings: default model, permission mode, the concurrency limit, and the group and board-lane definitions. It is a dry run until you add `--apply`, copies `~/.omp/vscode` to `~/.switchyard/backups/` before it writes anything, and never deletes old data. **Sessions are not carried over**: the dry run lists each old session with the command that continues it in omp's terminal (`omp --resume <id>`), and each unfinished queued task, so you can queue it again with `switchyard new <dir> --task …`.

The old server (`omp-sessions server`) and its phone app are gone; uninstall the old login service with `omp-sessions server uninstall` before you remove the old extension.

## 2. Hermes Agent (optional)

1. **Hermes** on the same machine, with its gateway running as a service (`hermes gateway install`). Run the web dashboard too (`hermes dashboard`) if you want the browser page or Hermes Desktop in remote mode.
2. **The plugin**, in every profile you chat with: **Switchyard: Install Hermes Plugin…** in VS Code, or
   ```sh
   switchyard hermes install --all-profiles
   switchyard hermes status --all-profiles
   ```
   `HERMES_HOME` is respected. The gateway loads the plugin without a restart; restart the dashboard once so it mounts the page's backend. When the extension updates, it refreshes the plugin and reloads it in the running gateway. Without VS Code, install it from Git instead: `hermes plugins install mbaradad/omp-sessions/integrations/hermes/switchyard --enable` (it still needs `switchyard` on the machine). Comments on kanban cards reach omp only from trusted authors (`lane.comment_authors`, default `dashboard`, which covers the dashboard and Hermes Console).
3. **The kanban lane**, in one profile: the one whose gateway runs the machine's kanban dispatcher. With a single multiplexed gateway that is `default`; with one gateway per profile, it is whichever gateway took the dispatcher lock. `hermes switchyard status` tells you which (`kanban dispatcher: last tick … in profile …`) and warns when the lane is on elsewhere.
   ```sh
   hermes -p default switchyard lane on --board <board>
   hermes -p default switchyard board <board> --folder ~/projects/<project> --mode auto
   hermes -p default switchyard status
   ```
4. **The skill for other agents**: **Switchyard: Install Skill for Agents…** or `switchyard skill install`, so omp, Claude Code and Codex on the machine can hand work to background sessions too.

### The Switchyard page in Hermes

| Where you open Hermes | How the page gets there |
| --- | --- |
| **Web dashboard** (any browser) | Automatic once the plugin is enabled and the dashboard restarted: **Switchyard** appears under *Plugins* in the sidebar. |
| **Hermes Desktop, local mode** (Hermes on this computer) | Desktop copies the page from the installed plugin. Turn **Switchyard** on in *Capabilities → Plugins* (use **Rescan** if it isn't listed). |
| **Hermes Desktop, remote mode** (an SSH gateway or a remote URL) | Desktop plugins live on the computer running Desktop, so add the page there once: *Capabilities → Plugins → Install from Git*, repository `mbaradad/omp-sessions/integrations/hermes/switchyard`. The agent part is already on the machine, so Desktop reports that it exists and installs only the page. Then turn it on. |

The page always talks to the plugin on the machine Hermes runs on, so it shows that machine's sessions. After a plugin update, Desktop keeps its copy of the page until you **Rescan** (local) or **Install from Git** again with **Force reinstall** (remote); the page tells you when it is older than the plugin.

## 3. Your phone (optional)

The phone uses **AO's mobile app** ([iPhone and iPad](https://apps.apple.com/app/ao-mobile/id6792552173), [Android](https://play.google.com/store/apps/details?id=aoagents.dev)). A Switchyard phone app is planned; for now the AO app shows your sessions, chat, approvals and questions, and sends push notifications, but not Switchyard's queues or schedules.

1. **Switchyard: Connect Phone…** in VS Code (or `switchyard remote on` and `switchyard remote qr`), and scan the QR code in the app.
2. How the phone reaches the machine:
   - **Local network and Tailscale** (default): Tailscale on the machine and the phone, same account. AO adds Tailscale's HTTPS pairing when your tailnet has certificates turned on, which iPhones need for Tailscale addresses.
   - **Local network only** (plain HTTP, only on a Wi-Fi you trust).
   - **Anywhere**: a Cloudflare quick tunnel that AO starts (`--bind tunnel`).
   - **Tailscale on Windows, omp in WSL 2**, and other setups where the phone can't see the machine: [WSL 2 and the phone](REMOTE-API.md#windows-with-wsl-2).

   Details and limits: [Phone and API access](REMOTE-API.md).
3. **Hermes**: talk to it from its messaging channels, Hermes Desktop, or [Hermes Console](https://github.com/xP3ta/hermes-console) on Android. Asking for coding work starts omp sessions, and the chat hears back when they finish or need you. In any chat, `/omp` says what needs you and `/omp take <card>` hands a kanban card to omp ([details](HERMES.md#hermes-console-android)).

## 4. The laptop, in the remote arrangement

- **Terminal**: `ssh` to the machine and use `switchyard` (`status`, `ls`, `attach`, …). `switchyard vscode <session>` prints a link that opens the session's worktree in VS Code on the laptop.
- **VS Code**: Remote-SSH to the machine. Every window attaches to the same sessions; close it whenever you like. A window lists this workspace's sessions by default; *Show All Sessions* in the Sessions view title lists every session on the machine.
- **Hermes Desktop**: connect it to the machine's Hermes, as an **SSH** gateway (*Settings → Gateways → Add → SSH*) or a **Remote gateway** URL (with Tailscale, or an SSH tunnel: `ssh -N -L 9119:localhost:9119 <machine>`). Then add the page as in the table above.
- **AO's own app** (optional): the AO desktop app can connect to the machine's AO as a remote host and shows the same sessions. Session modes it shows are AO's, not Switchyard's (see [Phone and API access](REMOTE-API.md#the-phone)).

Voice isn't available in this version.

## A day with this setup

1. **Plan in Hermes.** Talk the work through, from Desktop, the dashboard or a chat. Hermes files kanban cards with dependencies, assigned to `omp`, or starts and schedules sessions directly (`switchyard_session_start`, with `at` for later).
2. **omp does the coding.** The planner sends ready cards and tasks to AO, which gives each session its own worktree and branch, within the planner's concurrency limit (`switchyard sched set <n>`).
3. **Answer questions anywhere.** A session that needs you shows up on the Switchyard page in Hermes, on the phone, in VS Code, in `switchyard ls`, and as a message in the chat that started it. Answering in one place answers it everywhere. Approvals are yours: comments and the Hermes agent can't answer them (unless you turn on `agent_approvals`).
4. **Review in VS Code.** *Open project in VS Code* on the Hermes page (or `switchyard vscode <session>`) opens the worktree; diffs, checkpoints and undo per turn. Merge the branch when you are happy. The card gets the session's final reply, and dependent cards start.

If the machine reboots overnight, the omp processes are gone: a turn that was running is lost, and AO shows the session as exited until it is resumed (sending to it fails until then). The AO daemon and the planner start with the login (where they are services), and the planner continues the plan: a task that was running is marked *interrupted* and waits for you (its card is blocked until you unblock it), work that hadn't started is dispatched, and nothing runs twice. A restart of the AO daemon alone, with the machine up, does not stop sessions: their hosts keep omp and the running turn alive.

## Check that it all works

| Check | Command (on the machine) | Healthy |
| --- | --- | --- |
| Machine | `switchyard status` | exit 0: AO runs, omp is found, the planner runs, no problems listed |
| AO supervised | `systemctl --user is-active ao-daemon` (or the AO desktop app is open) | `active` |
| Planner supervised | `systemctl --user is-active switchyard-planner` or `launchctl print gui/$UID/dev.switchyard.planner` | active / running |
| omp extension | **Switchyard: Run Doctor** | no problems in the omp extension line |
| Plugin everywhere | `switchyard hermes status --all-profiles` | every profile `current, enabled`, the lane on in one |
| Lane reachable | `hermes -p <profile> switchyard status` | a dispatcher tick in the last minute, no `!` lines |
| Hermes page | the dashboard or Desktop sidebar | **Switchyard** listed and showing your sessions |
| Phone | `switchyard remote status` | `on`, with the addresses the phone will try |

When something is off, start with `switchyard status`, `hermes switchyard status` and **Switchyard: Run Doctor**; [the Hermes guide](HERMES.md#troubleshooting) lists the usual causes. AO's own logs: `journalctl --user -u ao-daemon`.
