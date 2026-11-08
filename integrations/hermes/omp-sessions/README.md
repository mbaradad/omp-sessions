# omp-sessions: omp coding sessions for Hermes

Hermes hands coding work to [oh-my-pi](https://omp.sh) (`omp`) sessions instead of doing it itself. Every session is an ordinary omp session run by the [omp Sessions](https://mbaradad.github.io/omp-vscode/) `omp-vs` server, so you can watch and steer it from VS Code, a terminal (`omp-vs attach`), the omp phone app, or the plugin's page in Hermes.

![The omp Sessions page in the Hermes dashboard](https://raw.githubusercontent.com/mbaradad/omp-vscode/main/docs/images/hermes-dashboard.png)

- **Tools** (toolset `omp_sessions`): list sessions and projects; start a session now, queue it, or schedule it for later in a folder, a known project or a board's folder; check, wait on, answer, steer, switch the permission mode of, and stop a session.
- **Notifications**: when a session a Hermes chat started finishes or needs input, that chat gets a message.
- **Kanban lane**: cards assigned to `omp` run as omp sessions (one omp group per board); the reply becomes the card's result, a question blocks the card until answered, and dependent cards chain as usual. Comments on a card answer omp or reach its session, and `@omp` in a comment hands a card to omp, so kanban-only clients such as Hermes Console can drive it.
- **Dashboard and Desktop page**: a live board of omp sessions (needs you, working, queued and scheduled, done, stopped) with answers, follow-ups, mode switches and new sessions, plus the lane's boards and linked cards. In the web dashboard it's the **omp Sessions** tab; in Hermes Desktop, turn it on under Capabilities → Plugins (Desktop in remote mode: add it there with *Install from Git* first).
- **Skill** `omp-sessions:omp-sessions`, `/omp` in chats (`/omp take <card>` hands a kanban card to omp, also from Hermes Console on Android) and `hermes omp …` in a terminal.

## Requirements

- Hermes Agent 0.23.0 or later.
- `omp-vs` on `PATH`, in `~/.local/bin`, or in `%LOCALAPPDATA%\omp-vs` on Windows: install the omp Sessions extension in VS Code and run **omp: Install omp-vs Command**. omp itself must be installed and signed in. A gateway started by systemd or launchd may have a minimal `PATH`; the installed command works there because it records the absolute path of its runtime.

## Install

```sh
hermes plugins install mbaradad/omp-vscode/integrations/hermes/omp-sessions --enable
hermes config set plugins.entries.omp-sessions.allow_gateway_injection true   # lets notifications reach chats
```

Or from VS Code: **omp: Install Hermes Plugin…** (or `omp-vs hermes install --all-profiles`). Turn the kanban lane on in one profile: `hermes omp lane on`. Full guide: [docs/HERMES.md](https://github.com/mbaradad/omp-vscode/blob/main/docs/HERMES.md).

## What it does on your machine

- **Runs a local command.** Every tool call, page refresh and lane tick runs `omp-vs` (`--json` subcommands) as your user. omp-vs talks to its local server over a Unix socket; the plugin makes no network calls of its own.
- **Starts coding agents.** Sessions run omp, which reads and edits files in the session's folder and runs commands there according to its permission mode (`ask`, `edits`, `plan` or `auto`). Lane cards use the board's mode, else omp's default. omp uses your own model provider sign-in and bills it.
- **Keeps state** in the profile's plugin data (which chat to notify about which session) and, for the lane, in `<kanban home>/plugin-data/omp-sessions-lane/` (card ↔ session links and a lock), next to Hermes's shared kanban boards.
- **Reads** Hermes's kanban boards through `hermes_cli.kanban_db` to claim, comment on, complete and block cards assigned to `omp`, and the skill files a card names so their paths can be passed to omp.
- No credentials are read or stored, nothing is downloaded, no telemetry.

## License

MIT
