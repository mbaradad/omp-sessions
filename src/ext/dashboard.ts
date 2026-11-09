// Usage dashboard (`switchyard.dashboard`), today's spend (`switchyard.todayCost` + status bar item) and the
// history search command. Usage comes from omp's own transcripts, parsed incrementally by the same
// aggregation the session host uses for `meta.cost` (src/shared/cost.ts), so it covers turns made
// while VS Code was closed, subagents, side calls and earlier transcripts of a session.

import * as crypto from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { TranscriptUsage, type UsageRecord, sessionTranscripts } from "../shared/cost";
import { locateTranscript } from "../shared/omp-paths";
import type { SessionMeta } from "../shared/protocol";
import { listTranscripts, readTranscriptHead } from "../shared/transcript-files";
import type { OmpApi } from "./api";
import { searchHistory } from "./history-search";
import { configuredOmpPaths, projectRoot } from "./sessions";
import { type Summary, type Totals, type UsageSource, formatCost, formatTokens, summarize } from "./transcripts";

/** One dashboard row: a VS Code session (`meta`) or, with terminal sessions included, a bare omp transcript. */
interface UsageRow extends UsageSource {
	key: string;
	title: string;
	cwd: string;
	/** Main transcript; empty for sessions omp has not started yet. */
	file: string;
	meta?: SessionMeta;
	records: UsageRecord[];
}

interface UsageSnapshot {
	at: number;
	includeAll: boolean;
	rows: UsageRow[];
	summary: Summary<UsageRow>;
}

const INCLUDE_ALL = "dashboard.includeTerminalSessions";
const THROTTLE_MS = 60_000;

const includeAllSetting = () => vscode.workspace.getConfiguration("switchyard").get<boolean>(INCLUDE_ALL, false);

/** Collects usage from transcripts on demand; results are reused for `maxAgeMs`. */
class UsageService {
	private readonly usage = new TranscriptUsage();
	private last: UsageSnapshot | undefined;
	private running: { includeAll: boolean; promise: Promise<UsageSnapshot> } | undefined;

	constructor(private readonly api: OmpApi) {}

	get(maxAgeMs: number): Promise<UsageSnapshot> {
		const includeAll = includeAllSetting();
		if (this.last && this.last.includeAll === includeAll && Date.now() - this.last.at < maxAgeMs) return Promise.resolve(this.last);
		if (this.running?.includeAll === includeAll) return this.running.promise;
		const promise = this.collect(includeAll).then(rows => {
			const snap: UsageSnapshot = { at: Date.now(), includeAll, rows, summary: summarize(rows) };
			if (includeAll === includeAllSetting()) this.last = snap;
			return snap;
		});
		const running = { includeAll, promise };
		this.running = running;
		void promise.finally(() => {
			if (this.running === running) this.running = undefined;
		});
		return promise;
	}

	private async collect(includeAll: boolean): Promise<UsageRow[]> {
		const rows: UsageRow[] = [];
		const claimed = new Set<string>();
		const metas = this.api.sessions.all();
		const transcripts = includeAll || metas.some(m => !m.ompSessionFile) ? await listTranscripts(configuredOmpPaths()) : [];
		// AO sessions whose omp session the Switchyard omp extension didn't record (GAPS G9): each runs in its
		// own AO workspace folder, so the transcripts omp wrote with that cwd are the session's.
		const byCwd = new Map<string, string[]>();
		if (metas.some(m => !m.ompSessionFile)) {
			for (const { file } of transcripts) {
				const cwd = readTranscriptHead(file)?.cwd;
				if (cwd) byCwd.set(cwd, [...(byCwd.get(cwd) ?? []), file]);
			}
		}
		for (const meta of metas) {
			const files = meta.ompSessionFile ? sessionTranscripts(meta) : meta.cwd ? (byCwd.get(meta.cwd) ?? []) : [];
			for (const f of files) {
				claimed.add(path.resolve(f));
				const found = locateTranscript(f);
				if (found) claimed.add(path.resolve(found));
			}
			const file = meta.ompSessionFile ?? files.at(-1) ?? "";
			rows.push({ key: `s:${meta.id}`, title: meta.title, cwd: meta.cwd, project: projectRoot(meta.cwd).root, file, meta, records: files.length ? await this.usage.records(files) : [] });
		}
		if (!includeAll) return rows;
		for (const { file } of transcripts) {
			if (claimed.has(path.resolve(file))) continue;
			const records = await this.usage.records([file]);
			if (records.length === 0) continue;
			const head = this.usage.peek(file)?.head;
			const cwd = head?.cwd ?? "";
			rows.push({ key: `f:${file}`, title: head?.title || path.basename(file).replace(/\.jsonl(\.gz)?$/, ""), cwd, project: cwd ? projectRoot(cwd).root : "(unknown folder)", file, records });
		}
		return rows;
	}
}

/** Runs `fn` at most once per `ms`; calls in between coalesce into one trailing run. */
function throttle(ms: number, fn: () => void): { (): void; dispose(): void } {
	let lastRun = 0;
	let timer: NodeJS.Timeout | undefined;
	const run = () => {
		if (timer) return;
		timer = setTimeout(
			() => {
				timer = undefined;
				lastRun = Date.now();
				fn();
			},
			Math.max(0, lastRun + ms - Date.now()),
		);
	};
	run.dispose = () => clearTimeout(timer);
	return run;
}

export function registerDashboard(api: OmpApi): void {
	const { context, sessions } = api;
	const usage = new UsageService(api);
	const reg = (name: string, fn: (...args: unknown[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(name, fn));

	// ---------- dashboard ----------
	let panel: vscode.WebviewPanel | undefined;
	let shown: UsageSnapshot | undefined;

	const render = async (maxAgeMs: number) => {
		const target = panel;
		if (!target) return;
		try {
			const snap = await usage.get(maxAgeMs);
			if (panel !== target) return;
			shown = snap;
			target.webview.html = dashboardHtml(target.webview, snap);
		} catch (err) {
			if (panel === target) target.webview.html = messageHtml(target.webview, `Could not read omp transcripts: ${err instanceof Error ? err.message : String(err)}`);
		}
	};
	const autoRefresh = throttle(THROTTLE_MS, () => {
		if (panel?.visible) void render(THROTTLE_MS);
	});

	reg("switchyard.dashboard", () => {
		if (panel) {
			panel.reveal();
			void render(0);
			return;
		}
		const created = vscode.window.createWebviewPanel("switchyard.dashboard", "Switchyard Usage", vscode.ViewColumn.Active, { enableScripts: true, enableFindWidget: true });
		panel = created;
		created.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "switchyard-color.svg");
		created.webview.html = messageHtml(created.webview, "Reading omp transcripts…");
		created.onDidDispose(() => {
			if (panel === created) panel = undefined;
			shown = undefined;
		});
		created.onDidChangeViewState(e => {
			if (e.webviewPanel.visible) autoRefresh();
		});
		created.webview.onDidReceiveMessage((msg: unknown) => void onMessage(msg));
		void render(0);
	});

	const onMessage = async (msg: unknown) => {
		if (typeof msg !== "object" || msg === null || !("type" in msg)) return;
		if (msg.type === "refresh") return render(0);
		if (msg.type === "search") return vscode.commands.executeCommand("switchyard.searchHistory");
		if (msg.type === "includeAll" && "value" in msg && typeof msg.value === "boolean") {
			await vscode.workspace.getConfiguration("switchyard").update(INCLUDE_ALL, msg.value, vscode.ConfigurationTarget.Global);
			return render(0);
		}
		// Rows are looked up by key, so the webview can only act on what it was shown.
		const row = "key" in msg && typeof msg.key === "string" ? shown?.rows.find(r => r.key === msg.key) : undefined;
		if (!row) return;
		const meta = row.meta ? sessions.get(row.meta.id) : undefined;
		if (msg.type === "open" && meta) return vscode.commands.executeCommand("switchyard.openSession", meta.id);
		if (msg.type === "resume") {
			if (meta) return vscode.commands.executeCommand(meta.status === "stopped" ? "switchyard.resumeSession" : "switchyard.openSession", meta.id);
		}
	};

	// ---------- today's spend ----------
	const item = vscode.window.createStatusBarItem("switchyard.todayCost", vscode.StatusBarAlignment.Left, 49);
	item.name = "Switchyard: Today's Spend";
	item.command = "switchyard.dashboard";
	const statusEnabled = () => vscode.workspace.getConfiguration("switchyard").get<boolean>("showTodayCost", true);
	const updateItem = async () => {
		if (!statusEnabled()) {
			item.hide();
			return;
		}
		try {
			const { summary } = await usage.get(THROTTLE_MS);
			const { today, week, month } = summary.periods;
			if (today.turns === 0 || !statusEnabled()) {
				item.hide();
				return;
			}
			item.text = `$(pulse) ${today.cost > 0 ? formatCost(today.cost) : `${formatTokens(today.tokens)} tok`}`;
			const md = new vscode.MarkdownString(undefined, true);
			md.appendMarkdown(`**omp today:** ${spend(today)}\n\n`);
			md.appendMarkdown(`Last 7 days: ${formatCost(week.cost)} · last 30 days: ${formatCost(month.cost)}\n\n`);
			const top = summary.sessions.filter(s => s.today.turns > 0).sort((a, b) => b.today.cost - a.today.cost);
			for (const s of top.slice(0, 5)) md.appendMarkdown(`- ${escapeMd(s.source.title)}: ${formatCost(s.today.cost)}\n`);
			md.appendMarkdown("\nClick for the usage dashboard.");
			item.tooltip = md;
			item.show();
		} catch {
			item.hide();
		}
	};
	const statusRefresh = throttle(THROTTLE_MS, () => void updateItem());
	// Midnight rollover and turns made by sessions in other windows.
	const rollover = setInterval(statusRefresh, 5 * 60_000);
	const startup = setTimeout(statusRefresh, 3000);
	context.subscriptions.push(
		item,
		sessions.onDidChange(() => {
			if (statusEnabled()) statusRefresh();
			autoRefresh();
		}),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration("switchyard.showTodayCost") || e.affectsConfiguration(`switchyard.${INCLUDE_ALL}`)) void updateItem();
		}),
		{
			dispose: () => {
				clearInterval(rollover);
				clearTimeout(startup);
				statusRefresh.dispose();
				autoRefresh.dispose();
			},
		},
	);

	reg("switchyard.todayCost", async () => {
		const { summary } = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Switchyard: reading transcripts" }, () => usage.get(THROTTLE_MS));
		const { today, week } = summary.periods;
		const scope = includeAllSetting() ? "all omp sessions" : "Switchyard only";
		const text = today.turns ? `omp today: ${spend(today)} (${scope}). Last 7 days: ${formatCost(week.cost)}.` : `No omp model calls today (${scope}). Last 7 days: ${formatCost(week.cost)}.`;
		if ((await vscode.window.showInformationMessage(text, "Open Dashboard")) === "Open Dashboard") await vscode.commands.executeCommand("switchyard.dashboard");
	});

	// ---------- history search ----------
	reg("switchyard.searchHistory", () => searchHistory(api));
}

function spend(t: Totals): string {
	return `${formatCost(t.cost)} · ${formatTokens(t.tokens)} tokens · ${t.turns} model call${t.turns === 1 ? "" : "s"}`;
}

function escapeMd(s: string): string {
	return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&");
}

// ---------------------------------------------------------------- HTML

function esc(s: string): string {
	return s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}

function page(webview: vscode.Webview, body: string, nonce?: string, script = ""): string {
	const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${nonce ? `'nonce-${nonce}'` : "'none'"};`;
	return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>${STYLE}</style></head><body>${body}${nonce ? `<script nonce="${nonce}">${script}</script>` : ""}</body></html>`;
}

function messageHtml(webview: vscode.Webview, text: string): string {
	return page(webview, `<p class="muted">${esc(text)}</p>`);
}

function card(label: string, t: Totals): string {
	return `<div class="card"><div class="label">${label}</div><div class="cost">${formatCost(t.cost)}</div><div class="muted">${formatTokens(t.tokens)} tokens · ${t.turns} call${t.turns === 1 ? "" : "s"}</div></div>`;
}

function num(v: number, shown: string): string {
	return `<td class="num" data-v="${v}">${shown}</td>`;
}

function th(label: string, type: "num" | "str" = "num"): string {
	return `<th data-type="${type}" class="${type}" tabindex="0">${label}</th>`;
}

function shortProject(p: string): string {
	return path.basename(p) || p;
}

function dashboardHtml(webview: vscode.Webview, snap: UsageSnapshot): string {
	const nonce = crypto.randomBytes(16).toString("base64");
	const { summary: s, includeAll } = snap;
	const toolbar = `<div class="toolbar"><h1>omp usage</h1>
<label title="Also count omp sessions run without Switchyard (plain omp in a terminal), from ~/.omp/agent/sessions"><input type="checkbox" id="all"${includeAll ? " checked" : ""}> Include terminal sessions</label>
<button id="search" class="secondary">Search history…</button><button id="refresh">Refresh</button>
<span class="muted">Updated ${esc(new Date(snap.at).toLocaleTimeString())}</span></div>`;
	if (s.periods.all.turns === 0) {
		const none = includeAll ? "No omp transcripts with usage were found." : "No usage recorded by Switchyard yet. Tick “Include terminal sessions” to count omp sessions run elsewhere.";
		return page(webview, `${toolbar}<p class="muted">${none}</p>`, nonce, SCRIPT);
	}
	const cards = `<div class="cards">${card("Today", s.periods.today)}${card("Last 7 days", s.periods.week)}${card("Last 30 days", s.periods.month)}${card("All time", s.periods.all)}</div>`;

	const byCost = s.days.some(d => d.cost > 0);
	const metric = (t: Totals) => (byCost ? t.cost : t.tokens);
	const max = Math.max(...s.days.map(metric), 0);
	const bars = s.days
		.map((d, i) => {
			const h = max > 0 ? Math.max(metric(d) > 0 ? 2 : 0, Math.round((metric(d) / max) * 100)) : 0;
			const label = i % 5 === s.days.length % 5 || i === s.days.length - 1 ? d.day.slice(5) : "";
			return `<div class="col" title="${d.day}: ${formatCost(d.cost)} · ${formatTokens(d.tokens)} tokens · ${d.turns} calls"><div class="bar" style="height:${h}%"></div><div class="tick">${label}</div></div>`;
		})
		.join("");
	const chart = `<h2>Per day <span class="muted">(${byCost ? "cost" : "tokens"}, last ${s.days.length} days)</span></h2><div class="chart">${bars}</div>`;

	const projects = `<h2>Projects</h2><table class="sortable"><thead><tr>${th("Project", "str")}${th("Sessions")}${th("Calls")}${th("Tokens")}${th("Cost")}</tr></thead><tbody>${s.projects
		.map(p => `<tr><td data-v="${esc(p.project)}" title="${esc(p.project)}">${esc(shortProject(p.project))}</td>${num(p.sessions, String(p.sessions))}${num(p.turns, String(p.turns))}${num(p.tokens, formatTokens(p.tokens))}${num(p.cost, formatCost(p.cost))}</tr>`)
		.join("")}</tbody></table>`;

	const allCost = s.periods.all.cost || 1;
	const models = `<h2>Models</h2><table class="sortable"><thead><tr>${th("Model", "str")}${th("Calls")}${th("Tokens")}${th("Cost")}${th("Share")}</tr></thead><tbody>${s.models
		.map(m => {
			const share = s.periods.all.cost > 0 ? m.cost / allCost : 0;
			return `<tr><td data-v="${esc(m.model)}">${esc(m.model)}</td>${num(m.turns, String(m.turns))}${num(m.tokens, formatTokens(m.tokens))}${num(m.cost, formatCost(m.cost))}<td class="num" data-v="${share}"><span class="share"><span style="width:${Math.round(share * 100)}%"></span></span> ${Math.round(share * 100)}%</td></tr>`;
		})
		.join("")}</tbody></table>`;

	const sessionRows = s.sessions
		.map(x => {
			const r = x.source;
			const status = r.meta?.status ?? "terminal";
			const actions = r.meta
				? `<button class="link" data-act="open" data-key="${esc(r.key)}">Open</button>${status === "stopped" && r.file ? ` <button class="link" data-act="resume" data-key="${esc(r.key)}">Resume</button>` : ""}`
				: r.cwd
					? `<button class="link" data-act="resume" data-key="${esc(r.key)}" title="Resume this transcript in a background session">Resume</button>`
					: "";
			const titleCell = r.meta ? `<button class="link title" data-act="open" data-key="${esc(r.key)}">${esc(r.title)}</button>` : `<span class="title">${esc(r.title)}</span>`;
			return `<tr><td data-v="${esc(r.title.toLowerCase())}" title="${esc(r.file || r.cwd)}">${titleCell}</td><td data-v="${status}"><span class="badge ${status}">${status}</span></td><td data-v="${esc(r.project)}" title="${esc(r.cwd)}">${esc(shortProject(r.project))}</td><td data-v="${esc(x.models.join(", "))}" class="models">${esc(x.models.map(m => m.split("/").pop() ?? m).join(", "))}</td>${num(x.total.turns, String(x.total.turns))}${num(x.total.tokens, formatTokens(x.total.tokens))}${num(x.total.cost, formatCost(x.total.cost))}${num(x.today.cost, x.today.turns ? formatCost(x.today.cost) : "")}${num(x.last, x.last ? esc(new Date(x.last).toLocaleString()) : "")}<td class="actions">${actions}</td></tr>`;
		})
		.join("");
	const sessionsTable = `<h2>Sessions <span class="muted">(${s.sessions.length})</span></h2><table class="sortable" id="sessions"><thead><tr>${th("Session", "str")}${th("Status", "str")}${th("Project", "str")}${th("Models", "str")}${th("Calls")}${th("Tokens")}${th("Cost")}${th("Today")}${th("Last active")}<th></th></tr></thead><tbody>${sessionRows}</tbody></table>`;

	const note = `<p class="muted small">From omp transcripts (incl. subagents and side calls). Costs are omp's own estimates.</p>`;
	return page(webview, `${toolbar}${cards}${chart}<div class="grid"><section>${projects}</section><section>${models}</section></div>${sessionsTable}${note}`, nonce, SCRIPT);
}

const STYLE = `
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);padding:0 20px 24px;line-height:1.4}
h1{font-size:1.4em;margin:0 12px 0 0;font-weight:600}h2{font-size:1.1em;margin:24px 0 8px;font-weight:600}
.muted{color:var(--vscode-descriptionForeground)}.small{font-size:.9em;margin-top:20px}
.toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:16px 0 8px;position:sticky;top:0;background:var(--vscode-editor-background);z-index:1}
.toolbar .muted{margin-left:auto}
button{font:inherit;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:none;padding:4px 12px;border-radius:2px;cursor:pointer}
button:hover{background:var(--vscode-button-hoverBackground)}
button.secondary{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}
button.secondary:hover{background:var(--vscode-button-secondaryHoverBackground)}
button.link{background:none;color:var(--vscode-textLink-foreground);padding:0}button.link:hover{text-decoration:underline;background:none}
button.title{color:var(--vscode-foreground);text-align:left}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-top:8px}
.card{border:1px solid var(--vscode-panel-border,var(--vscode-widget-border,transparent));background:var(--vscode-sideBar-background,transparent);border-radius:4px;padding:12px}
.card .label{color:var(--vscode-descriptionForeground);font-size:.9em}.card .cost{font-size:1.8em;font-weight:600;margin:2px 0}
.chart{display:flex;align-items:flex-end;gap:3px;height:140px;padding-bottom:18px;border-bottom:1px solid var(--vscode-panel-border,transparent)}
.col{flex:1;height:100%;display:flex;flex-direction:column;justify-content:flex-end;position:relative;min-width:6px}
.bar{background:var(--vscode-charts-blue,var(--vscode-progressBar-background));border-radius:2px 2px 0 0;min-height:0}
.col:hover .bar{opacity:.75}
.tick{position:absolute;bottom:-18px;left:50%;transform:translateX(-50%);font-size:.8em;color:var(--vscode-descriptionForeground);white-space:nowrap}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:0 24px}
table{border-collapse:collapse;width:100%}
th,td{padding:4px 8px;border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.2));text-align:left;vertical-align:top}
th{font-weight:600;cursor:pointer;user-select:none;white-space:nowrap}th:empty{cursor:default}
th.num,td.num{text-align:right;white-space:nowrap}
th[data-dir="asc"]::after{content:" ▲"}th[data-dir="desc"]::after{content:" ▼"}
tbody tr:hover{background:var(--vscode-list-hoverBackground)}
td.models{color:var(--vscode-descriptionForeground)}td.actions{white-space:nowrap}
.badge{font-size:.85em;padding:0 6px;border-radius:8px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}
.badge.stopped,.badge.terminal{background:none;color:var(--vscode-descriptionForeground);border:1px solid var(--vscode-panel-border,rgba(128,128,128,.4))}
.badge.working,.badge.starting{background:var(--vscode-charts-blue)}.badge.waiting{background:var(--vscode-charts-orange)}
.share{display:inline-block;width:60px;height:6px;background:var(--vscode-editorWidget-background,rgba(128,128,128,.2));vertical-align:middle;border-radius:3px;overflow:hidden}
.share span{display:block;height:100%;background:var(--vscode-charts-purple,var(--vscode-progressBar-background))}
`;

// Sorting (state survives re-renders via setState) and actions posted back to the extension.
const SCRIPT = `
const vscode = acquireVsCodeApi();
const state = vscode.getState() || {};
const post = m => vscode.postMessage(m);
document.getElementById("refresh").onclick = () => post({ type: "refresh" });
document.getElementById("search").onclick = () => post({ type: "search" });
document.getElementById("all").onchange = e => post({ type: "includeAll", value: e.target.checked });
document.body.addEventListener("click", e => {
	const b = e.target.closest("button[data-act]");
	if (b) post({ type: b.dataset.act, key: b.dataset.key });
});
const tables = [...document.querySelectorAll("table.sortable")];
function sortTable(ti, col, dir) {
	const table = tables[ti];
	const th = table && table.tHead.rows[0].cells[col];
	if (!th) return;
	const num = th.dataset.type === "num";
	const body = table.tBodies[0];
	const val = r => r.cells[col].dataset.v || "";
	const rows = [...body.rows].sort((a, b) => {
		const d = num ? Number(val(a)) - Number(val(b)) : val(a).localeCompare(val(b));
		return dir === "asc" ? d : -d;
	});
	for (const r of rows) body.appendChild(r);
	for (const c of table.tHead.rows[0].cells) delete c.dataset.dir;
	th.dataset.dir = dir;
}
tables.forEach((table, ti) => {
	[...table.tHead.rows[0].cells].forEach((th, col) => {
		if (!th.dataset.type) return;
		const activate = () => {
			const dir = th.dataset.dir === "desc" ? "asc" : th.dataset.dir === "asc" ? "desc" : th.dataset.type === "num" ? "desc" : "asc";
			sortTable(ti, col, dir);
			state.sort = { ...(state.sort || {}), [ti]: { col, dir } };
			vscode.setState(state);
		};
		th.addEventListener("click", activate);
		th.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(); } });
	});
});
for (const [ti, s] of Object.entries(state.sort || {})) sortTable(Number(ti), s.col, s.dir);
`;
