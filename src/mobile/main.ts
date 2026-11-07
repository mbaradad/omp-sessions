// omp Sessions phone app (served by the omp-vs server, see docs/REMOTE-API.md): the sessions list,
// one session's live transcript with composer, dialogs and controls, and a new-session form.
// Hash routes: #/ (list), #/s/<id> (session), #/new. `#pair=<token>` pairs this browser once.
import { plainExcerpt } from "../shared/excerpt";
import { PERMISSION_MODES, PERMISSION_MODE_INFO, type PermissionMode, isPermissionMode } from "../shared/permissions";
import type { SessionMeta, UiRequest } from "../shared/protocol";
import type { SessionInfo } from "../shared/server-protocol";
import { AuthError, action, createSession, isSessionMeta, listProjects, listSessions, pair, sessionList } from "./api";
import { ago, basename, h, isRecord, money, num, str } from "./dom";
import { Transcript, dialogCard } from "./transcript";

/** protocol.ts's DIALOG_METHODS (that module is Node-only): UI requests that wait for an answer. */
const DIALOG_METHODS: Record<string, true> = { select: true, confirm: true, input: true, editor: true, ask: true };

const app = document.getElementById("app") ?? document.body;

// ---------- shared state ----------

let sessions: SessionInfo[] = [];
let listStream: EventSource | undefined;
let live = false;
const listListeners = new Set<() => void>();
/** Teardown of the current screen. */
let leave: (() => void) | undefined;
/** The pairing screen is up: nothing else may call the API until it succeeds. */
let pairing = false;

function toast(text: string, error = true): void {
	const el = h("div", { class: `toast${error ? " error" : ""}`, role: "status" }, text);
	document.body.append(el);
	setTimeout(() => el.classList.add("gone"), 3200);
	setTimeout(() => el.remove(), 3800);
}

function failed(err: unknown): void {
	if (err instanceof AuthError) {
		showPair(err.message === "invalid token" ? "This phone's pairing is no longer valid (the token changed). Pair it again." : undefined);
		return;
	}
	toast(err instanceof Error ? err.message : String(err));
}

function setSessions(list: SessionInfo[]): void {
	sessions = list;
	for (const l of [...listListeners]) l();
}

function connectList(): void {
	listStream?.close();
	const es = new EventSource("/api/events");
	listStream = es;
	es.addEventListener("sessions", e => {
		live = true;
		if (e instanceof MessageEvent) setSessions(sessionList(JSON.parse(String(e.data))));
	});
	es.onerror = () => {
		live = false;
		for (const l of [...listListeners]) l();
		// CLOSED: refused (e.g. 401); the next refresh finds out why.
		if (es.readyState === EventSource.CLOSED && listStream === es) listStream = undefined;
	};
}

async function refresh(): Promise<void> {
	setSessions(await listSessions());
	if (!listStream) connectList();
}

function infoOf(id: string): SessionInfo | undefined {
	return sessions.find(s => s.meta.id === id);
}

function project(meta: SessionMeta): string {
	return basename(meta.cwd);
}

type Group = "input" | "working" | "idle" | "stopped";
const GROUPS: Array<{ id: Group; label: string }> = [
	{ id: "input", label: "Needs input" },
	{ id: "working", label: "Working" },
	{ id: "idle", label: "Idle" },
	{ id: "stopped", label: "Stopped" },
];

function groupOf(info: SessionInfo): Group {
	if (info.column === "input" || info.meta.status === "waiting") return "input";
	if (info.column === "working" || info.column === "waiting" || info.meta.status === "starting" || info.meta.status === "working") return "working";
	return info.meta.status === "stopped" ? "stopped" : "idle";
}

function statusLabel(meta: SessionMeta, info?: SessionInfo): string {
	if (info?.waiting) return info.waiting.launch ? "queued" : `waiting #${info.waiting.position}`;
	switch (meta.status) {
		case "waiting":
			return "needs input";
		case "starting":
			return "starting";
		default:
			return meta.status;
	}
}

function queueText(q: SessionInfo["queue"]): string {
	return q.total ? `${q.done}/${q.total} tasks` : "";
}

// ---------- router ----------

function route(): void {
	leave?.();
	leave = undefined;
	pairing = false;
	const hash = location.hash;
	const session = /^#\/s\/([\w-]+)/.exec(hash);
	if (session) showSession(session[1]);
	else if (hash === "#/new") void showNew();
	else showList();
}

function go(hash: string): void {
	if (location.hash === hash) route();
	else location.hash = hash;
}

function header(title: string, opts: { back?: boolean; right?: Node | null; sub?: Node | string | null } = {}): HTMLElement {
	return h(
		"header",
		{ class: "bar" },
		opts.back ? h("button", { class: "icon back", "aria-label": "Back", onclick: () => (history.length > 1 ? history.back() : go("#/")) }, "‹") : h("img", { class: "logo", src: "mobile-icon.svg", alt: "" }),
		h("div", { class: "titles" }, h("div", { class: "title" }, title), opts.sub ? h("div", { class: "sub" }, opts.sub) : null),
		opts.right ?? null,
	);
}

// ---------- pairing ----------

function showPair(problem?: string): void {
	leave?.();
	leave = undefined;
	pairing = true;
	listStream?.close();
	listStream = undefined;
	const field = h("input", { type: "password", placeholder: "Paste the token", autocomplete: "off", autocapitalize: "off", spellcheck: "false" });
	const submit = async () => {
		try {
			await pair(field.value.trim());
			go("#/");
		} catch (err) {
			toast(err instanceof Error ? err.message : String(err));
		}
	};
	app.replaceChildren(
		header("Pair this phone"),
		h(
			"main",
			{ class: "pair" },
			problem ? h("p", { class: "note warning" }, problem) : null,
			h("p", {}, "Scan the pairing QR code with this phone's camera:"),
			h("ul", {}, h("li", {}, "VS Code: ", h("b", {}, "omp: Connect Phone…")), h("li", {}, "Terminal: ", h("code", {}, "omp-vs remote qr"))),
			h("p", { class: "dim" }, "Or paste the token from ~/.omp/vscode/remote.json:"),
			h("form", { class: "row", onsubmit: (e: Event) => (e.preventDefault(), void submit()) }, field, h("button", { class: "primary", type: "submit" }, "Pair")),
		),
	);
}

// ---------- sessions list ----------

function sessionRow(info: SessionInfo): HTMLElement {
	const m = info.meta;
	const meta = [project(m), queueText(info.queue), money(m.cost), ago(m.updatedAt)].filter(Boolean).join(" · ");
	return h(
		"a",
		{ class: `srow ${groupOf(info)}`, href: `#/s/${m.id}` },
		h("div", { class: "srow-top" }, h("span", { class: "stitle" }, m.title || "New session"), h("span", { class: `chip ${m.status}` }, statusLabel(m, info))),
		h("div", { class: "smeta" }, meta),
		m.lastText ? h("div", { class: "slast" }, plainExcerpt(m.lastText)) : null,
	);
}

function showList(): void {
	const list = h("main", { class: "list" });
	const dot = h("span", { class: "live-dot", title: "Live updates" });
	const pull = h("div", { class: "pull" }, "Release to refresh");
	const render = () => {
		dot.classList.toggle("on", live);
		const visible = sessions.filter(s => !s.archived);
		const groups = GROUPS.map(g => ({ ...g, items: visible.filter(s => groupOf(s) === g.id) })).filter(g => g.items.length);
		list.replaceChildren(
			pull,
			...(groups.length
				? groups.map(g => h("section", { class: `group ${g.id}` }, h("h2", {}, g.label, h("span", { class: "count" }, String(g.items.length))), ...g.items.map(sessionRow)))
				: [h("div", { class: "empty" }, h("p", {}, "No sessions yet."), h("a", { class: "button primary", href: "#/new" }, "Start one"))]),
		);
	};
	app.replaceChildren(header("omp Sessions", { right: h("div", { class: "row" }, dot, h("a", { class: "button icon plus", href: "#/new", "aria-label": "New session" }, "+")) }), list);
	listListeners.add(render);
	render();
	refresh().catch(failed);

	// Pull to refresh.
	let startY: number | undefined;
	let pulled = 0;
	list.addEventListener("touchstart", e => {
		startY = list.scrollTop <= 0 ? e.touches[0].clientY : undefined;
	});
	list.addEventListener("touchmove", e => {
		if (startY === undefined) return;
		pulled = Math.max(0, e.touches[0].clientY - startY);
		pull.style.height = `${Math.min(70, pulled / 2)}px`;
		pull.classList.toggle("ready", pulled > 120);
	});
	list.addEventListener("touchend", () => {
		if (startY !== undefined && pulled > 120) {
			listStream?.close();
			listStream = undefined;
			refresh().catch(failed);
		}
		startY = undefined;
		pulled = 0;
		pull.style.height = "0";
		pull.classList.remove("ready");
	});
	leave = () => listListeners.delete(render);
}

// ---------- one session ----------

function showSession(id: string): void {
	const scroller = h("main", { class: "session" });
	const transcript = new Transcript(scroller);
	const dialogs = h("div", { class: "dialogs" });
	scroller.append(transcript.el, dialogs);
	const pending = new Map<string, UiRequest>();
	let meta: SessionMeta | undefined = infoOf(id)?.meta;
	let busy = false;
	let stream: EventSource | undefined;
	let ended = false;
	let closed = false;

	const titleEl = h("div", { class: "title" });
	const subEl = h("div", { class: "sub" });
	const bar = h("header", { class: "bar" }, h("button", { class: "icon back", "aria-label": "Back", onclick: () => go("#/") }, "‹"), h("div", { class: "titles" }, titleEl, subEl));
	const modes = h("div", { class: "seg", role: "radiogroup", "aria-label": "Permission mode" });
	const controls = h("div", { class: "controls" });
	const tools = h("div", { class: "toolbar" }, modes, controls);
	const input = h("textarea", { rows: 1, placeholder: "Message omp…", enterkeyhint: "send" });
	const buttons = h("div", { class: "send-buttons" });
	const composer = h("form", { class: "composer", onsubmit: (e: Event) => e.preventDefault() }, input, buttons);

	const send = async (steer: boolean) => {
		const text = input.value.trim();
		if (!text) return;
		input.value = "";
		autosize();
		try {
			await action(id, "prompt", { text, steer });
		} catch (err) {
			input.value = text;
			autosize();
			failed(err);
		}
	};
	const autosize = () => {
		input.style.height = "auto";
		input.style.height = `${Math.min(160, input.scrollHeight)}px`;
	};
	input.addEventListener("input", autosize);

	const act = (name: "abort" | "stop" | "resume", label: string) =>
		h(
			"button",
			{
				class: name === "stop" ? "danger" : "",
				onclick: async () => {
					try {
						await action(id, name);
						if (name === "resume") reconnectSoon();
					} catch (err) {
						failed(err);
					}
				},
			},
			label,
		);

	const renderChrome = () => {
		const info = infoOf(id);
		const m = meta ?? info?.meta;
		titleEl.textContent = m?.title || "Session";
		subEl.textContent = m ? [project(m), statusLabel(m, info), info ? queueText(info.queue) : "", money(m.cost)].filter(Boolean).join(" · ") : "";
		const working = busy || m?.status === "working" || m?.status === "starting";
		const stopped = m?.status === "stopped";
		const mode = m && (m.status !== "stopped" ? m.permissionMode : undefined);
		modes.replaceChildren(
			...PERMISSION_MODES.map(pm =>
				h(
					"button",
					{
						class: pm === mode ? "on" : "",
						role: "radio",
						"aria-checked": pm === mode ? "true" : "false",
						title: PERMISSION_MODE_INFO[pm].detail,
						onclick: () => void setMode(pm),
					},
					PERMISSION_MODE_INFO[pm].label,
				),
			),
		);
		controls.replaceChildren(...(stopped ? [act("resume", "Resume")] : [working ? act("abort", "Abort") : null, act("stop", "Stop")].filter(b => b !== null)));
		buttons.replaceChildren(
			...(working && !stopped
				? [h("button", { class: "ghost", type: "button", title: "Send after the current turn", onclick: () => void send(false) }, "Queue"), h("button", { class: "primary", type: "button", title: "Steer the current turn", onclick: () => void send(true) }, "Steer")]
				: [h("button", { class: "primary", type: "button", onclick: () => void send(false) }, stopped ? "Resume & send" : "Send")]),
		);
		input.placeholder = stopped ? "Resumes the session…" : working ? "Steer or queue…" : "Message omp…";
	};

	const setMode = async (mode: PermissionMode) => {
		try {
			await action(id, "mode", { mode });
			if (meta && meta.status !== "stopped") meta = { ...meta, permissionMode: mode };
			renderChrome();
			toast(`${PERMISSION_MODE_INFO[mode].label}: ${PERMISSION_MODE_INFO[mode].detail}`, false);
		} catch (err) {
			failed(err);
		}
	};

	const renderDialogs = () => {
		dialogs.replaceChildren(
			...[...pending.values()].map(req =>
				dialogCard(req, async answer => {
					pending.delete(req.id);
					renderDialogs();
					try {
						await action(id, "ui", { id: req.id, ...answer });
					} catch (err) {
						pending.set(req.id, req);
						renderDialogs();
						failed(err);
					}
				}),
			),
		);
		if (pending.size) transcript.scrollToEnd();
	};

	const onHost = (msg: unknown) => {
		if (!isRecord(msg)) return;
		switch (msg.t) {
			case "snapshot": {
				if (isSessionMeta(msg.meta)) meta = msg.meta;
				transcript.reset(Array.isArray(msg.messages) ? msg.messages : [], num(msg.omitted) ?? 0);
				if (isRecord(msg.inflight)) transcript.setLive(str(msg.inflight.messageId), msg.inflight.message);
				if (Array.isArray(msg.runningTools)) for (const t of msg.runningTools.filter(isRecord)) transcript.toolStart(str(t.toolCallId), str(t.toolName), t.args);
				pending.clear();
				if (Array.isArray(msg.pendingUi)) for (const r of msg.pendingUi) if (isUiRequest(r)) pending.set(r.id, r);
				busy = isRecord(msg.state) && msg.state.isStreaming === true;
				renderDialogs();
				break;
			}
			case "meta":
				if (isSessionMeta(msg.meta)) meta = msg.meta;
				break;
			case "reset":
				transcript.reset(Array.isArray(msg.messages) ? msg.messages : [], 0);
				break;
			case "state":
				busy = isRecord(msg.state) && msg.state.isStreaming === true;
				break;
			case "ui_resolved":
				pending.delete(str(msg.id));
				renderDialogs();
				break;
			case "event":
				if (isRecord(msg.ev)) onEvent(msg.ev);
				break;
		}
		renderChrome();
	};

	const onEvent = (ev: Record<string, unknown>) => {
		switch (ev.type) {
			case "message_start":
			case "message_update":
				transcript.setLive(str(ev.messageId), ev.message);
				break;
			case "message_end":
				transcript.commit(str(ev.messageId), ev.message);
				break;
			case "tool_execution_start":
				transcript.toolStart(str(ev.toolCallId), str(ev.toolName), ev.args);
				break;
			case "tool_execution_update":
				transcript.toolUpdate(str(ev.toolCallId), ev.partialResult);
				break;
			case "tool_execution_end":
				transcript.toolEnd(str(ev.toolCallId), str(ev.toolName), ev.result, ev.isError === true);
				break;
			case "agent_start":
				busy = true;
				break;
			case "agent_end":
			case "session_settled":
				busy = false;
				break;
			case "prompt_result":
				if (ev.sessionSettled) busy = false;
				break;
			case "notice":
				transcript.add({ role: "notice", level: ev.level, message: ev.message });
				break;
			case "command_output":
				transcript.add({ role: "commandOutput", text: ev.text });
				break;
			case "extension_ui_request":
				if (isUiRequest(ev) && DIALOG_METHODS[ev.method]) pending.set(ev.id, ev);
				else if (ev.method === "cancel") pending.delete(str(ev.targetId));
				renderDialogs();
				break;
		}
	};

	const connect = () => {
		if (closed) return;
		stream?.close();
		ended = false;
		const es = new EventSource(`/api/sessions/${encodeURIComponent(id)}/events`);
		stream = es;
		es.addEventListener("host", e => {
			if (e instanceof MessageEvent) onHost(JSON.parse(String(e.data)));
		});
		es.addEventListener("end", () => {
			// Stopped (or the host went away): wait for the list to show it running again.
			ended = true;
			es.close();
			if (meta && meta.status !== "stopped") meta = { ...meta, status: "stopped" };
			busy = false;
			pending.clear();
			renderDialogs();
			renderChrome();
		});
		es.onerror = () => {
			if (es.readyState === EventSource.CLOSED && !ended) listSessions().then(setSessions, failed);
		};
	};
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	const reconnectSoon = () => {
		clearTimeout(reconnectTimer);
		reconnectTimer = setTimeout(connect, 600);
	};
	const onList = () => {
		const info = infoOf(id);
		if (info && ended && info.meta.status !== "stopped") {
			meta = info.meta;
			reconnectSoon();
		}
		if (info && (!meta || info.meta.updatedAt >= meta.updatedAt)) meta = { ...info.meta, permissionMode: info.meta.permissionMode ?? meta?.permissionMode };
		renderChrome();
	};
	const onVisible = () => {
		if (document.visibilityState === "visible" && stream?.readyState === EventSource.CLOSED && !ended) connect();
	};

	app.replaceChildren(bar, tools, scroller, composer);
	renderChrome();
	listListeners.add(onList);
	document.addEventListener("visibilitychange", onVisible);
	connect();
	if (!listStream) refresh().catch(failed);
	leave = () => {
		closed = true;
		clearTimeout(reconnectTimer);
		stream?.close();
		listListeners.delete(onList);
		document.removeEventListener("visibilitychange", onVisible);
	};
}

function isUiRequest(v: unknown): v is UiRequest {
	return isRecord(v) && typeof v.id === "string" && typeof v.method === "string";
}

// ---------- new session ----------

async function showNew(): Promise<void> {
	const pathField = h("input", { type: "text", placeholder: "~/projects/app or /absolute/path", autocapitalize: "off", autocorrect: "off", spellcheck: "false" });
	const folderList = h("div", { class: "folders" }, h("div", { class: "dim" }, "Loading recent folders…"));
	const prompt = h("textarea", { rows: 4, placeholder: "What should omp do?" });
	const title = h("input", { type: "text", placeholder: "Title (optional)" });
	const queueOnly = h("input", { type: "checkbox", id: "queue-only" });
	let mode: PermissionMode | undefined;
	const modes = h("div", { class: "seg wide", role: "radiogroup", "aria-label": "Permission mode" });
	const renderModes = () =>
		modes.replaceChildren(
			...[undefined, ...PERMISSION_MODES].map(pm =>
				h(
					"button",
					{
						type: "button",
						class: pm === mode ? "on" : "",
						role: "radio",
						"aria-checked": pm === mode ? "true" : "false",
						title: pm ? PERMISSION_MODE_INFO[pm].detail : "The project's / omp's default",
						onclick: () => {
							mode = pm;
							renderModes();
						},
					},
					pm ? PERMISSION_MODE_INFO[pm].label : "Default",
				),
			),
		);
	renderModes();
	const startButton = h("button", { class: "primary big", type: "submit" }, "Start session");
	const submit = async () => {
		const cwd = pathField.value.trim();
		const text = prompt.value.trim();
		if (!cwd) return toast("Pick a folder");
		if (queueOnly.checked && !text) return toast("A queued session needs a task");
		startButton.disabled = true;
		startButton.textContent = queueOnly.checked ? "Queuing…" : "Starting…";
		try {
			const id = await createSession({ cwd, ...(queueOnly.checked ? { task: text } : text ? { prompt: text } : {}), title: title.value.trim() || undefined, mode: isPermissionMode(mode) ? mode : undefined });
			go(`#/s/${id}`);
		} catch (err) {
			failed(err);
			startButton.disabled = false;
			startButton.textContent = "Start session";
		}
	};
	app.replaceChildren(
		header("New session", { back: true }),
		h(
			"main",
			{ class: "new" },
			h(
				"form",
				{ onsubmit: (e: Event) => (e.preventDefault(), void submit()) },
				h("label", {}, "Folder"),
				folderList,
				pathField,
				h("label", {}, "Prompt"),
				prompt,
				h("label", {}, "Permission mode"),
				modes,
				h("label", { class: "toggle", for: "queue-only" }, queueOnly, h("span", {}, h("b", {}, "Queue only"), h("span", { class: "dim" }, " · add as a task; the server starts it when a slot is free"))),
				title,
				startButton,
			),
		),
	);
	try {
		const projects = await listProjects();
		const pick = (p: string) => {
			pathField.value = p;
			for (const b of folderList.querySelectorAll("button")) b.classList.toggle("on", b.dataset.path === p);
		};
		folderList.replaceChildren(
			...(projects.length
				? projects.map(p => {
						const b = h("button", { type: "button", class: "folder", onclick: () => pick(p.path) }, h("span", { class: "fname" }, p.name), h("span", { class: "fpath" }, p.path));
						b.dataset.path = p.path;
						return b;
					})
				: [h("div", { class: "dim" }, "No recent folders: type a path below.")]),
		);
		if (projects[0] && !pathField.value) pick(projects[0].path);
	} catch (err) {
		folderList.replaceChildren();
		failed(err);
	}
}

// ---------- boot ----------

async function boot(): Promise<void> {
	const paired = /^#pair=([\w-]+)/.exec(location.hash);
	window.addEventListener("hashchange", route);
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible" && !listStream && !pairing) refresh().catch(failed);
	});
	if (paired) {
		// Strip the token from the address bar and history right away.
		history.replaceState(null, "", location.pathname);
		try {
			await pair(paired[1]);
		} catch (err) {
			showPair(err instanceof Error ? `Pairing failed: ${err.message}` : undefined);
			return;
		}
	}
	try {
		await refresh();
	} catch (err) {
		if (err instanceof AuthError) return showPair();
		toast(err instanceof Error ? err.message : String(err));
	}
	route();
}

void boot();
