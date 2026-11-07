# Remote access: phone app and HTTP API

The per-user `omp-vs` server can also listen on HTTP. It serves a phone web app and a small JSON API with live updates (Server-Sent Events). The app is a PWA you can add to your home screen. Through the same API, another app or web server can list your sessions, start new ones, follow them live, prompt them, answer their questions and switch their permission mode.

Remote access is **off** by default. When it is on, it serves the same sessions as VS Code and `omp-vs`, on the machine where they run (the Remote-SSH host, if you use one).

## Setup

### 1. Choose how the phone reaches the machine

| Bind | Listens on | Use it when |
| --- | --- | --- |
| `tailscale` (recommended) | the machine's Tailscale address (first IPv4 in `100.64.0.0/10`) | You want access from anywhere. [Tailscale](https://tailscale.com/download) is free for personal use and encrypts the traffic between your devices. Install it on the machine and the phone, and sign in to the same account. |
| `lan` | all interfaces (`0.0.0.0`) | Phone and machine share a Wi-Fi you trust. **This is plain HTTP**: anyone on that network can read the traffic, including the token, and then control your sessions. Avoid it on public or shared Wi-Fi. |
| `localhost` | `127.0.0.1` | You test in a browser on the same machine, or put your own TLS tunnel or reverse proxy in front. |
| `<ip>` | that address | Any other interface, e.g. a VPN address. |

The default port is `7413`.

### 2. Turn it on and pair the phone

**From VS Code:** run **omp: Connect Phone…** and pick a bind.

- If Tailscale isn't running, it explains how to set it up and offers the local network instead, with a warning.
- It starts the server if needed and shows a QR code of the pairing link. Scan the code with the phone's camera.
- **omp: Disable Remote Access** turns it off.
- **omp: Rotate Remote Access Token** unpairs every phone.

**From a terminal:**

```bash
omp-vs remote on                    # bind tailscale, port 7413
omp-vs remote on --bind lan --port 8080
omp-vs remote qr                    # QR code (Unicode half blocks) + pairing URL
omp-vs remote status                # on/off, listening address, last error
omp-vs remote rotate                # new token: every paired phone has to pair again
omp-vs remote off
```

The pairing URL is `http://<host>:<port>/#pair=<token>`. When the app opens it, it:

1. posts the token to `/api/pair`, which sets an HttpOnly cookie;
2. removes the fragment from the address bar and history;
3. stores nothing else.

Browsers never send fragments to servers or proxies, so the token stays out of logs.

The setting lives in `~/.omp/vscode/remote.json` (mode `0600`):

```json
{ "enabled": true, "bind": "tailscale", "port": 7413, "token": "<43 base64url chars>" }
```

The token is 32 random bytes, created the first time remote access is turned on. The server watches the file and starts, stops or rebinds the listener within seconds. If the bind address doesn't exist yet (for example, Tailscale is still connecting), it retries every 30 s. `omp-vs remote status` shows the reason.

## Authentication

Every `/api/*` request except `GET /api/health` and `POST /api/pair` needs the token, sent one of two ways:

- `Authorization: Bearer <token>`, for scripts, servers and other apps.
- The `omp_vs` cookie (`HttpOnly; SameSite=Strict; Path=/`), set by `POST /api/pair`, for browsers.

Requests authenticated by the cookie that change something must send `Content-Type: application/json`. If they carry an `Origin` header, it must be this server's own. This blocks cross-site form posts.

Rules:

- Tokens are compared in constant time.
- After 5 failed token checks, the client address is locked out for 60 s. The lockout doubles with each further failure, up to about an hour. While locked out, even the right token gets `429` with `Retry-After`. Failures older than 10 minutes are forgotten.
- No CORS headers are sent, so pages on other origins can't read the API.
- Request bodies are capped at 1 MiB.

The static app files (`/`, `/mobile.js`, `/mobile.css`, `/manifest.webmanifest`, `/mobile-icon.*`) are served without authentication. They contain no data.

## Conventions

- JSON in, JSON out. Errors are `{"error": "<message>"}` with one of these statuses:

  | Status | Meaning |
  | --- | --- |
  | `400` | bad input |
  | `401` | missing or wrong token |
  | `403` | cross-origin cookie request |
  | `404` | unknown session or route |
  | `405` | wrong method |
  | `409` | the session is in the wrong state |
  | `413` | body too large |
  | `415` | not JSON |
  | `429` | locked out |
  | `502` | session host unreachable |

- Session ids are the ids `omp-vs ls` shows in full (`SessionInfo.meta.id`).
- Responses are `Cache-Control: no-store`.

The examples below assume:

```bash
export OMP=http://100.101.102.103:7413   # omp-vs remote status prints the URL
export TOKEN=$(node -p 'require(require("os").homedir()+"/.omp/vscode/remote.json").token')
alias api='curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json"'
```

## Endpoints

### `GET /api/health`

The server's version. Needs no auth.

```bash
curl -sS $OMP/api/health
# {"version":"0.5.0"}
```

### `POST /api/pair` `{token}`

Checks the token and sets the `omp_vs` cookie for one year. Failed checks count toward the lockout.

```bash
curl -sS -i -X POST -H "Content-Type: application/json" -d "{\"token\":\"$TOKEN\"}" $OMP/api/pair
# HTTP/1.1 200 OK
# set-cookie: omp_vs=…; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000
# {"ok":true}
```

### `GET /api/sessions`

Every session as `SessionInfo[]`, the shape `omp-vs ls --json` prints. Running sessions come first, then most recently active. Archived sessions are included with `archived: true`.

```bash
api $OMP/api/sessions
```

```ts
interface SessionInfo {
	meta: {
		id: string;
		cwd: string;
		title: string;
		status: "starting" | "idle" | "working" | "waiting" | "stopped"; // waiting = needs input
		createdAt: number;
		updatedAt: number;
		cost?: number;
		lastText?: string;
		model?: string;
		permissionMode?: "ask" | "edits" | "plan" | "auto";
		changedFiles: number;
		exitReason?: string;
		// …
	};
	column: "waiting" | "working" | "input" | "idle" | "stopped"; // board column; "waiting" = for a concurrency slot
	queue: { pending: number; running: number; done: number; total: number; autoRun: boolean; startAt?: number };
	priority: "urgent" | "high" | "normal" | "low";
	order: number;
	group?: string;
	color?: string;
	archived?: boolean;
	waiting?: { position: number; since?: number; launch?: boolean };
}
```

### `GET /api/projects`

Recent project folders, for a new-session picker. The list holds the sessions' folders and their project roots (git repositories, with worktrees mapped to the main checkout). Folders that no longer exist are dropped. The 50 most recently used come first.

```bash
api $OMP/api/projects
# [{"path":"/home/me/src/app","name":"app","lastUsed":1794057328092,"sessions":3}, …]
```

### `POST /api/sessions` `{cwd, prompt?, title?, mode?, task?}`

Starts a session in `cwd`: an absolute path, or one starting with `~/`. The server's create operation runs it, the same one `omp-vs new` uses.

| Field | Meaning |
| --- | --- |
| `prompt` | Sent once the host is up. The call returns after omp accepted it. |
| `task` | Queue-only, like `omp-vs new --task`. The session is created stopped, with the task in its queue, and the server starts it when a concurrency slot is free. Give either `prompt` or `task`, not both. |
| `mode` | The starting permission mode (`ask`, `edits`, `plan`, `auto`), passed as the `--approval-mode` launch flag. Without it, the session uses the project's or omp's default. |
| `title` | Defaults to the first line of the prompt or task. |

```bash
api -X POST -d '{"cwd":"~/src/app","prompt":"fix the flaky test","mode":"edits"}' $OMP/api/sessions
# 201 {"id":"mw6fetfd435bb4","started":true}
api -X POST -d '{"cwd":"~/src/app","task":"upgrade dependencies"}' $OMP/api/sessions
# 201 {"id":"mw6fetoqb88702","started":false}
```

### `GET /api/sessions/:id[?limit=N]`

`{info, snapshot}`: the session's `SessionInfo` and a slim snapshot.

- `snapshot.messages` holds the last `N` messages (default 80, at most 1000), and `omitted` counts the ones before them.
- Long tool output is clipped to 4000 characters per block, and file contents are left out of edit details.
- `commands` and the file-change list are not included.
- A stopped session's snapshot is rebuilt from its omp transcript.

```bash
api "$OMP/api/sessions/mw6fetfd435bb4?limit=20"
```

```ts
interface RemoteSnapshot {
	t: "snapshot";
	meta: SessionMeta;
	messages: Message[]; // omp transcript messages: role "user" | "assistant" | "toolResult" | "notice" | "commandOutput" | …
	omitted: number;
	inflight: { messageId: string; message: Message } | null; // the message being streamed
	runningTools: Array<{ toolCallId: string; toolName: string; args: unknown; partialResult?: unknown }>;
	pendingUi: UiRequest[]; // dialogs waiting for an answer (see /ui)
	state: unknown; // omp's state (model, isStreaming, queued messages, context usage, …); null when stopped
	queue?: TaskQueue;
}
```

### `GET /api/sessions/:id/events[?limit=N]`

A Server-Sent Events stream of the session host's messages. It starts with a snapshot, as above.

- While you watch, the session counts as viewed, so the server won't stop it automatically.
- Each message arrives as `event: host` with JSON `data`.
- `event: end` with `{"reason": …}` closes the stream. The reason is `"stopped"` when the session isn't running (you still get its snapshot first) or `"session host closed"` when it stops while you watch. Reconnect after resuming it.
- The server sends a `: ping` comment every 15 s and `retry: 3000`.

```bash
curl -sS -N -H "Authorization: Bearer $TOKEN" $OMP/api/sessions/mw6fetfd435bb4/events
# retry: 3000
#
# event: host
# data: {"t":"snapshot","meta":{…},"messages":[…],"omitted":0,"inflight":null,…}
#
# event: host
# data: {"t":"event","ev":{"type":"message_update","messageId":"…","message":{"role":"assistant","content":[{"type":"text","text":"Hel"}],…}}}
```

The `host` payloads:

| `t` | Payload | Meaning |
| --- | --- | --- |
| `snapshot` | see above | full state; replace everything |
| `event` | `ev`: an omp RPC frame | see below |
| `meta` | `meta: SessionMeta` | status, title, cost, permission mode, … changed |
| `ui_resolved` | `id` | a pending dialog was answered (by anyone) or cancelled |
| `reset` | `messages`, `state` | the transcript was replaced (new session, fork, rewind) |
| `state` | `state` | omp's state changed |
| `queue` | `queue: TaskQueue` | the task queue changed |

The common `ev.type` values:

- **Streaming:** `message_start`, `message_update` and `message_end` carry `messageId` and the whole message so far. `message_end` is final: append it to the transcript.
- **Tools:** `tool_execution_start` (`toolCallId`, `toolName`, `args`), `tool_execution_update` (`partialResult`) and `tool_execution_end` (`result`, `isError`). Tool calls also appear as `toolCall` blocks in assistant messages, and their results as `toolResult` messages.
- **Turn state:** `agent_start` and `agent_end`, plus `prompt_result` (`sessionSettled: true` means idle).
- **Dialogs:** `extension_ui_request`, with `method` one of `select`, `confirm`, `input`, `editor` or `ask`, waits for an answer. `method: "cancel"` with `targetId` withdraws one.
- **Notes:** `notice` (`level`, `message`) and `command_output` (`text`).

Frames no client renders are dropped, and large ones are slimmed like the snapshot.

### `GET /api/events`

A Server-Sent Events stream of the sessions list. It sends `event: sessions` with the full `SessionInfo[]` right away and again whenever anything changes: status, title, cost, queue, mode, or sessions being created or removed. Changes arrive within about half a second.

```bash
curl -sS -N -H "Authorization: Bearer $TOKEN" $OMP/api/events
```

### `POST /api/sessions/:id/prompt` `{text, steer?}`

Sends a prompt, resuming a stopped session first. If omp is mid-turn, `steer: true` injects the text into the current turn; otherwise it runs as a follow-up after the turn.

```bash
api -X POST -d '{"text":"also update the docs"}' $OMP/api/sessions/mw6fetfd435bb4/prompt
# {"sent":true}
api -X POST -d '{"text":"stop, use the other API","steer":true}' $OMP/api/sessions/mw6fetfd435bb4/prompt
```

### `POST /api/sessions/:id/abort`

Aborts the current turn.

```bash
api -X POST $OMP/api/sessions/mw6fetfd435bb4/abort
# {"sent":true}
```

### `POST /api/sessions/:id/stop`

Stops the session. The transcript stays, and the session can be resumed.

```bash
api -X POST $OMP/api/sessions/mw6fetfd435bb4/stop
# {"stopped":true}
```

### `POST /api/sessions/:id/resume`

Restarts omp on the same transcript.

```bash
api -X POST $OMP/api/sessions/mw6fetfd435bb4/resume
# {"started":true}
```

### `POST /api/sessions/:id/mode` `{mode}`

Switches the permission mode (`ask`, `edits`, `plan`, `auto`) live. The switch also applies to approval prompts already waiting. For a stopped session, the mode applies when it resumes. Returns `409` when the session's host predates permission modes.

```bash
api -X POST -d '{"mode":"plan"}' $OMP/api/sessions/mw6fetfd435bb4/mode
# {"mode":"plan"}
```

### `POST /api/sessions/:id/ui` `{id, …answer}`

Answers a pending dialog (`snapshot.pendingUi`, or an `extension_ui_request` event). `id` is the dialog's id. The rest of the body is the answer, as the session host's `ui_response` expects it:

| `method` | Answer |
| --- | --- |
| `select` | `{"value": "<one of options>"}` |
| `confirm` | `{"confirmed": true\|false}` |
| `input` / `editor` | `{"value": "<text>"}` |
| `ask` | `{"answers": [{"id": "<question id>", "selectedOptions": ["<label>"], "customInput": "<text>"}]}` |
| any | `{"cancelled": true}` dismisses it |

Tool approvals are `select` dialogs titled `Allow tool: <name>\n<detail>`, with options such as `Approve`, `Approve <name> for this session` and `Deny`.

```bash
api -X POST -d '{"id":"approve-k3j2","value":"Approve"}' $OMP/api/sessions/mw6fetfd435bb4/ui
# {"sent":true}
```

## The phone app

The app is built from `src/mobile/` into `out/mobile.{html,js,css}`, `out/manifest.webmanifest` and `out/mobile-icon.{png,svg}`. The extension copies these files into `~/.omp/vscode/runtime/` next to `server.js`. The app uses no framework and makes no external requests, and it has no service worker, so nothing is cached. It has three screens:

- **Sessions:** grouped as *Needs input*, *Working*, *Idle* and *Stopped*. Each row shows the title, project, status, queue progress, cost and last text. The list updates live, and pulling down refreshes it.
- **Session:**
  - The transcript renders text as markdown and tool calls as compact rows; edits show the file and `+n −m`. Replies stream in live.
  - The composer sends a message. While omp works, it offers *Steer* (into the current turn) or *Queue* (after it).
  - Dialogs and approvals appear as cards you can answer.
  - A permission mode switcher (Ask / Edits / Plan / Auto) and Abort / Stop / Resume sit in the toolbar.
- **New session:** a recent-folder picker or a typed path, a prompt, a permission mode, and *Queue only*.

## Security notes

- **The token is a password for your sessions.** Anyone who has it can run commands on the machine through omp. Don't share the pairing link or screenshots of the QR code. `omp-vs remote rotate` (or *Rotate Remote Access Token*) unpairs every device at once.
- **Prefer Tailscale.** Its traffic is end-to-end encrypted, and only your own devices can reach the address. On `lan`, everything, including the token and the cookie, crosses the network in clear text. Plain HTTP is also why the cookie can't be marked `Secure`.
- **`localhost` + your own TLS** (Caddy, nginx, `tailscale serve`, an SSH tunnel) is the way to expose it further. Keep the proxy on the same origin and pass `Authorization` and cookies through.
- The server only runs as your user and serves your sessions. It never adds CORS headers, refuses cross-origin cookie writes, caps bodies at 1 MiB and locks out addresses that guess tokens.
- `remote.json` is written with mode `0600`. The server logs pairings and rejected tokens, but never a token, to `~/.omp/vscode/server.log`.
- Remote access is per machine. Over Remote-SSH it runs on the remote host, so the phone needs to reach that host, for example with Tailscale installed there.
