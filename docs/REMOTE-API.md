# Phone and API access

Switchyard has no network server of its own. Your sessions run in [Agent Orchestrator](https://github.com/OrchestratorInc/agent-orchestrator) (AO), so the phone app and the HTTP API are AO's:

- **Phone:** AO's mobile app for iPhone, iPad and Android. A Switchyard phone app is planned; until then the AO app shows your sessions, chat, approvals and AO's own session list. It doesn't know Switchyard's queues, schedules or dependency graph, so you edit those in VS Code, with `switchyard`, or from Hermes.
- **API:** AO's HTTP API and its OpenAPI spec (`backend/internal/httpd/apispec/openapi.yaml` in the AO repository). Switchyard's own planner (plans, queues, schedules) listens on a local socket only; reach it with `switchyard` or the extension.

Everything runs on the machine with your code. Over Remote-SSH that is the remote host, so the phone has to reach that host.

## The phone

1. Install the app: [iPhone and iPad](https://apps.apple.com/app/ao-mobile/id6792552173) or [Android](https://play.google.com/store/apps/details?id=aoagents.dev).
2. On the machine, turn pairing on and show the QR code:
   - VS Code: **Switchyard: Connect Phone…**, then pick how the phone reaches the machine;
   - terminal: `switchyard remote on` and `switchyard remote qr`.
3. Scan the code in the app. **Anyone who has the QR code or the password can control your sessions.** Don't share screenshots.

| How the phone reaches the machine | `switchyard remote on` | Notes |
| --- | --- | --- |
| **Local network and Tailscale** (default) | `--bind tailscale` | AO listens on the LAN, port 3011 by default, and adds Tailscale's HTTPS pairing when Tailscale offers a certificate. iOS refuses plain HTTP to Tailscale addresses, so the HTTPS pairing is the working path on an iPhone. |
| **Local network only** | `--bind lan` | Plain HTTP. Anyone on that Wi-Fi can read the traffic, including the password. Use it at home only. |
| **Anywhere** (Cloudflare tunnel) | `--bind tunnel` | AO starts a Cloudflare quick tunnel and gives the phone its address. Traffic passes through Cloudflare. |
| **Both** | `--bind all` | LAN and tunnel. |

- `switchyard remote status` shows whether pairing is on and the addresses the phone will try, in the order AO tries them: LAN, Tailscale, tunnel. `--json` prints the same.
- `switchyard remote rotate` makes a new password, which unpairs every phone. **Switchyard: Rotate Remote Access Token** does the same.
- `switchyard remote off` (or **Disable Remote Access**) closes the listener.
- The old `--port`, `--url` and `--bind localhost|<ip>` options are gone: AO picks its own port and addresses. A custom HTTPS URL or reverse proxy in front of AO isn't supported by AO; use the tunnel or Tailscale pairing.

### Windows with WSL 2

WSL 2 in its default NAT mode isn't reachable from the phone: the LAN address AO advertises (`172.x.x.x`) exists only inside Windows. Pick one:

- **Mirrored networking:** add `networkingMode=mirrored` to `.wslconfig` in your Windows home, then `wsl --shutdown`. WSL then shares the PC's network, and the LAN option works.
- **A port proxy:** in an administrator PowerShell, `netsh interface portproxy add v4tov4 listenport=3011 listenaddress=0.0.0.0 connectport=3011 connectaddress=<WSL address>` and a firewall rule for port 3011. The WSL address changes on restart.
- **Tailscale inside WSL**, with Tailscale's HTTPS certificates turned on for the tailnet: `--bind tailscale`.
- **The tunnel:** `--bind tunnel` needs no inbound route.

### What the phone app can do

Following AO's mobile app: a Workers, Projects and Pull Requests view; chat with approvals, questions and attachments; dictation; a terminal and a preview browser; push notifications when a session needs you. Two Switchyard behaviours aren't visible there:

- a session's **permission mode** is Switchyard's (Ask, Edits, Plan or Auto, see below). The app shows the mode AO launched omp with, which is *bypass* for sessions Switchyard started, because Switchyard's omp extension does the asking. Approvals and questions reach the phone the same way as in VS Code. Change the mode from VS Code, the CLI or Hermes.
- the **queue and schedule** of a session, and the dependencies between tasks.

## The HTTP API

AO's daemon listens on `127.0.0.1` (port 3001 by default; the actual port is in `~/.ao/running.json`). The loopback listener has **no authentication**: any process of yours on the machine can call it. Clients must send no `Origin` header (curl and Node's fetch send none; browsers do, and AO refuses them).

```bash
AO=http://127.0.0.1:$(jq -r .port ~/.ao/running.json)
curl -s $AO/healthz                       # {"status":"ok",…}
curl -s $AO/api/v1/sessions               # every session
```

The phone listener is a second, opt-in listener on `0.0.0.0` (default port 3011). It exists only while pairing is on, requires `Authorization: Bearer <connection password>`, serves the app API only and answers 404 for local control routes. Repeated failed passwords (five in a minute) lock the source address out. `switchyard remote status --json` shows its endpoints. The password is in `~/.ao/data/mobile/config.json` (mode `0600`) and rotates with `switchyard remote rotate`. Don't put the listener on the public internet; use the tunnel or Tailscale pairing.

### What Switchyard uses

All paths are under `/api/v1`. The full list, with request and response shapes, is AO's `openapi.yaml`.

| Task | AO call |
| --- | --- |
| List sessions, one session | `GET /sessions`, `GET /sessions/{id}` |
| Projects (a git repository ↔ an AO project) | `GET /projects`, `POST /projects`, `PUT /projects/{id}/config` |
| Start a session | `POST /sessions` with `{"projectId","harness":"omp","mode":"chat","kind":"worker","displayName","prompt","model","approvalMode"}`. Omit `projectId` for a standalone session in an empty scratch folder |
| Read the chat | `GET /sessions/{id}/conversation` (`afterSequence`, `beforeSequence`, `limit`) |
| Send a prompt | `POST /sessions/{id}/conversation/messages` (queued if the agent is busy); `…/conversation/steer` redirects the current turn |
| Interrupt a turn | `POST /sessions/{id}/conversation/interrupt` |
| Answer an approval | `POST /sessions/{id}/conversation/approvals/{requestId}/resolve` with `{"decisionId"}` |
| Answer a question or a tool-approval dialog | `POST /sessions/{id}/conversation/inputs/{requestId}/resolve` with `{"action":"accept|decline|cancel","content"}` |
| Switch model or thinking | `PATCH /sessions/{id}/conversation/settings` |
| Models | `GET /agents/omp/models` |
| Stop, resume, remove | `POST /sessions/{id}/exit-agent`, `…/resume-agent`; `POST …/kill`, then `DELETE /sessions/{id}` |
| Live changes | `GET /events`, a Server-Sent Events stream |

Things worth knowing:

- **`/events` only says that something changed.** Chat changes arrive as `session_updated` with a `conversationId`; fetch `GET …/conversation?afterSequence=` to get the text. Events carry an `id`; reconnect with `Last-Event-ID` (or `?after=<id>`) to replay what you missed. A heartbeat arrives every 10 seconds.
- **Each session has its own workspace.** In a git project it is a worktree under `~/.ao/data/worktrees/<project>/<session>` on branch `ao/<session>/root`. Your checkout is untouched until you merge.
- **Switchyard's permission modes aren't in AO's API.** Sessions started by `switchyard`, VS Code or Hermes launch omp in AO's *bypass* mode, and Switchyard's omp extension asks (as an AO approval or question) according to a per-session mode file. Use `switchyard mode <session> ask|edits|plan|auto`. A session started from AO's own app keeps AO's modes.
- **Plans live in the planner**, not in AO: queues, subtasks, schedules, dependencies, priorities and the global concurrency limit. They have no HTTP API; `switchyard queue`, `sched` and the Tasks view edit them.

## Security notes

- AO's loopback listener trusts every process of your user. Keep your home directory private on shared machines.
- The phone password and the QR code are secrets. The pairing offer contains the password; rotate it (`switchyard remote rotate`) if a code leaked.
- Plain-HTTP pairing (`lan`) exposes the password and the traffic to the local network. Prefer Tailscale pairing or the tunnel.
- The tunnel makes your machine reachable through Cloudflare, protected only by the password. Turn pairing off (`switchyard remote off`) when you don't use it.
- AO doesn't add CORS headers for other origins and refuses browser requests on the loopback listener.
- Remote access is per machine. Over Remote-SSH it is the remote host's AO that the phone has to reach.
