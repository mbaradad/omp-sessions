// The Orchestrator view: AO's orchestrator of each project (the coordinating agent AO runs: it splits a
// high-level task into worker sessions, steers them and has their PRs reviewed). One card per project with
// its state, last reply, the question it waits on (answered with the same controls as a session's), the
// project's worker sessions with their PRs, and its settings; above them the task box that gives it work
// (starting it when needed). Everything is AO's or the CLI's: the page reads and calls
// /orchestrators… and /sessions/<orchestrator id>/… of the backend, which run `switchyard orchestrator …`.
import type { OrchestratorConfig, OrchestratorPermissions } from "../../../src/ao/orchestrator";
import { prSummaryLine } from "../../../src/shared/pr-review";
import {
	errorMessage,
	type Harnesses,
	type Host,
	type Orchestrator,
	type OrchestratorList,
	type OrchestratorSettings,
	type OrchestratorSettingsBody,
	type OrchestratorStarted,
	type OrchestratorSubmitted,
	type Places,
} from "./api";
import { Button, Empty, ErrorBox, Field } from "./components";
import { AnswerBox } from "./detail";
import { h, type ReactElement, useEffect, useState } from "./react";
import { ago, cx, icon, markdown, plain, shortId, STATE_LABEL } from "./util";
import { openInVscode } from "./vscode";

const POLL_MS = 4000;
const WORKERS_SHOWN = 8;
const REPLY_CLIP = 280;

/** What each approval mode of an orchestrator lets it do without asking. */
const PERMISSIONS: Record<OrchestratorPermissions, string> = {
	default: "default — ask before every command",
	"accept-edits": "accept-edits — edits run, commands ask",
	auto: "auto — AO's classifier decides",
	"bypass-permissions": "bypass-permissions — everything runs",
};

const TOGGLE_LABEL: Record<string, string> = { "": "Not set (AO's default)", on: "On", off: "Off" };

/** A project the task box can name: an AO project by its id, or a Hermes project by its folder (AO registers it on first use). */
interface ProjectChoice {
	value: string;
	label: string;
	group: "AO projects" | "Hermes projects";
}

function choicesOf(places: Places | null, orchestrators: Orchestrator[]): ProjectChoice[] {
	const out: ProjectChoice[] = [];
	const seen = new Set<string>();
	for (const f of places?.folders ?? []) {
		if (!f.id) continue;
		seen.add(f.path);
		out.push({ value: f.id, label: `${f.name} — ${f.label}`, group: "AO projects" });
	}
	for (const o of orchestrators) {
		if (out.some(c => c.value === o.projectId)) continue;
		seen.add(o.projectPath);
		out.push({ value: o.projectId, label: `${o.projectName} — ${o.projectPathLabel}`, group: "AO projects" });
	}
	for (const x of places?.hermesProjects ?? []) {
		if (x.path && !seen.has(x.path)) out.push({ value: x.path, label: `${x.name} — ${x.path}`, group: "Hermes projects" });
	}
	return out;
}

function projectSelect(id: string, label: string, choices: ProjectChoice[], value: string, onChange: (v: string) => void): ReactElement {
	const groups = ["AO projects", "Hermes projects"] as const;
	return h(
		"select",
		{ id, className: "omps-input", "aria-label": label, value, onChange: (e: Event) => onChange((e.target as HTMLSelectElement).value) },
		...groups.flatMap(g => {
			const mine = choices.filter(c => c.group === g);
			return mine.length ? [h("optgroup", { key: g, label: g }, ...mine.map(c => h("option", { key: c.value, value: c.value }, c.label)))] : [];
		}),
	);
}

/** One of AO's chat harnesses as a select (a text box when the list isn't available); `blank` is what leaving it unset means. */
function HarnessSelect(p: { id: string; label: string; value: string; blank: string; harnesses: Harnesses | null; onChange: (v: string) => void }): ReactElement {
	if (!p.harnesses) {
		return h("input", { id: p.id, className: "omps-input omps-mono", "aria-label": p.label, value: p.value, placeholder: p.blank, autoComplete: "off", spellCheck: false, onChange: (e: Event) => p.onChange((e.target as HTMLInputElement).value) });
	}
	const known = p.harnesses.harnesses;
	return h(
		"select",
		{ id: p.id, className: "omps-input", "aria-label": p.label, value: p.value, onChange: (e: Event) => p.onChange((e.target as HTMLSelectElement).value) },
		h("option", { value: "" }, p.blank),
		...(p.value && !known.some(x => x.id === p.value) ? [h("option", { key: p.value, value: p.value }, `${p.value} (not one of AO's chat harnesses)`)] : []),
		...known.map(x => h("option", { key: x.id, value: x.id, disabled: Boolean(x.unavailable) }, `${x.label}${x.id !== x.label ? ` (${x.id})` : ""}${x.authStatus === "authorized" ? "" : ` · ${x.authStatus}`}${x.unavailable ? " · can't chat here" : ""}`)),
	);
}

// ---------- the task box ----------

function TaskBox(p: {
	host: Host;
	choices: ProjectChoice[];
	project: string;
	onProject: (v: string) => void;
	current: Orchestrator | undefined;
	harnesses: Harnesses | null;
	onSubmitted: (sent: OrchestratorSubmitted) => void;
}): ReactElement {
	const [task, setTask] = useState("");
	const [steer, setSteer] = useState(false);
	const [harness, setHarness] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const running = Boolean(p.current?.active);
	const working = p.current?.state === "working" || p.current?.state === "starting";

	const submit = async (): Promise<void> => {
		if (!task.trim()) return setError("Write what the orchestrator should do.");
		if (!p.project) return setError("Pick the project.");
		setBusy(true);
		setError(null);
		try {
			const sent = await p.host.request<OrchestratorSubmitted>("/orchestrators/submit", {
				method: "POST",
				body: { task, project: p.project, steer: running && steer, ...(!running && harness ? { harness } : {}) },
			});
			setTask("");
			setSteer(false);
			p.onSubmitted(sent);
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	};

	return h(
		"form",
		{
			className: "omps-orch-task",
			"aria-label": "Give the orchestrator a task",
			onSubmit: (e: Event) => {
				e.preventDefault();
				void submit();
			},
		},
		h("div", { className: "omps-section-label" }, "Give the orchestrator a task"),
		h("textarea", {
			id: "omps-orch-task",
			className: "omps-input omps-prompt",
			rows: 4,
			value: task,
			"aria-label": "The task for the orchestrator",
			placeholder: "Move the billing module to the new API, split it across workers and get the PRs reviewed",
			onChange: (e: Event) => setTask((e.target as HTMLTextAreaElement).value),
			onKeyDown: (e: KeyboardEvent) => {
				if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
					e.preventDefault();
					void submit();
				}
			},
		}),
		h(
			"div",
			{ className: "omps-orch-task-row" },
			h(Field, { label: "Project", htmlFor: "omps-orch-project", children: p.choices.length ? projectSelect("omps-orch-project", "Project", p.choices, p.project, p.onProject) : h("div", { className: "omps-field-hint" }, "Loading projects… (an orchestrator coordinates a project AO knows: a git repository)") }),
			running
				? h(Field, {
						label: "Orchestrator",
						children: h("div", { className: "omps-field-hint" }, `${p.current?.id} is running${p.current?.harness ? ` on ${p.current.harness}` : ""}: the task goes to it, queued behind its turn.`),
					})
				: h(Field, {
						label: p.current ? "Harness when it restarts" : "Harness when it starts",
						htmlFor: "omps-orch-harness",
						hint: p.current ? "The orchestrator is stopped: the task brings it back." : "No orchestrator for this project yet: the task starts one.",
						children: h(HarnessSelect, { id: "omps-orch-harness", label: "Harness", value: harness, blank: "The project's setting, else Switchyard's default", harnesses: p.harnesses, onChange: setHarness }),
					}),
		),
		error ? h(ErrorBox, { message: error }) : null,
		h(
			"div",
			{ className: "omps-followup-row" },
			h(
				"label",
				{ className: "omps-check", title: running ? (working ? "Redirect the turn it is working on with this text" : "It is not working on a turn: the task goes in as usual") : "There is no running orchestrator to steer" },
				h("input", { type: "checkbox", checked: steer && running, disabled: !running, onChange: (e: Event) => setSteer((e.target as HTMLInputElement).checked) }),
				"Steer the turn in progress",
			),
			h("span", { className: "omps-hint" }, "Ctrl+Enter to send"),
			h("span", { className: "omps-grow" }),
			h(Button, { type: "submit", kind: "brand", icon: running ? "send" : "sparkle", label: running ? (steer ? "Steer" : "Send task") : "Start and send task", busy, disabled: !task.trim() || !p.project }),
		),
	);
}

// ---------- one orchestrator ----------

/** Its last reply: clipped to a few lines; Show more renders all of it. */
function Reply(p: { text: string }): ReactElement {
	const [open, setOpen] = useState(false);
	const long = p.text.length > REPLY_CLIP || p.text.trim().split("\n").length > 4;
	return h(
		"section",
		{ className: "omps-reply", "aria-label": "Last reply" },
		h("div", { className: "omps-section-label" }, "Last reply"),
		open || !long
			? h("div", { className: "omps-md" }, ...markdown(p.text))
			: h("div", { className: "omps-md omps-orch-clip" }, h("p", null, plain(p.text.length > REPLY_CLIP ? `${p.text.slice(0, REPLY_CLIP).trimEnd()}…` : p.text))),
		long ? h(Button, { small: true, kind: "ghost", icon: "chevron", label: open ? "Show less" : "Show more", pressed: open, onClick: () => setOpen(!open) }) : null,
	);
}

function prTone(f: Orchestrator["workers"][number]["prs"][number]): string {
	if (f.state === "merged" || (f.state === "open" && f.review === "approved" && f.mergeability === "mergeable" && f.ci !== "failing")) return "is-ok";
	if (f.state === "open" && (f.ci === "failing" || f.review === "changes_requested" || f.mergeability === "conflicting")) return "is-warn";
	return "";
}

function WorkerRow(p: { w: Orchestrator["workers"][number]; now: number; onOpen: (id: string) => void; onReview: (session: string, pr: number) => Promise<void> }): ReactElement {
	const { w } = p;
	return h(
		"li",
		{ className: "omps-orch-worker" },
		h(
			"button",
			{ type: "button", className: "omps-orch-worker-main", title: `Open ${w.title}`, onClick: () => p.onOpen(w.id) },
			h("span", { className: cx("omps-dot", `tone-${w.state}`), "aria-hidden": true }),
			h("span", { className: cx("omps-orch-worker-state", `tone-${w.state}`) }, STATE_LABEL[w.state]),
			h("span", { className: "omps-orch-worker-title" }, w.title),
			h("code", { className: "omps-orch-worker-id" }, shortId(w.id)),
		),
		h(
			"span",
			{ className: "omps-orch-worker-meta" },
			w.displayStatus ? h("span", { className: "omps-muted", title: "AO's status for the session" }, w.displayStatus) : null,
			w.harness && w.harness !== "omp" ? h("span", { className: "omps-chip omps-harness", title: `Runs on the ${w.harness} harness` }, w.harness) : null,
			w.branch ? h("span", { className: "omps-chip", title: `Branch ${w.branch}` }, icon("tag", 10), w.branch) : null,
			...w.prs.map(pr =>
				h(
					"span",
					{ key: pr.url || pr.number, className: "omps-orch-pr-group" },
					h("a", { className: cx("omps-chip omps-orch-pr", prTone(pr)), href: pr.url, target: "_blank", rel: "noreferrer noopener", title: `Open the pull request (updated ${ago(Date.parse(pr.updatedAt) || undefined, p.now) || "unknown"})` }, prSummaryLine(pr)),
					h(Button, { small: true, kind: "ghost", icon: "external", title: `Review #${pr.number} in VS Code`, onClick: () => void p.onReview(w.id, pr.number) }),
				),
			),
		),
	);
}

function countsLine(o: Orchestrator): string {
	const n = o.counts;
	const bits = [n.working && `${n.working} working`, n.needsInput && `${n.needsInput} need${n.needsInput === 1 ? "s" : ""} you`, n.idle && `${n.idle} idle`, n.stopped && `${n.stopped} stopped`, n.openPrs && `${n.openPrs} open PR${n.openPrs === 1 ? "" : "s"}`].filter(Boolean);
	return `${n.workers} worker${n.workers === 1 ? "" : "s"}${bits.length ? ` · ${bits.join(" · ")}` : ""}`;
}

// ---------- settings ----------

interface Draft {
	harness: string;
	model: string;
	effort: string;
	permissions: string;
	rules: string;
	rulesFile: string;
	workerHarness: string;
	workerModel: string;
	review: string;
	autoReview: string;
}

function draftOf(c: OrchestratorConfig): Draft {
	return {
		harness: c.harness ?? "",
		model: c.model ?? "",
		effort: c.effort ?? "",
		permissions: c.permissions ?? "",
		rules: c.rules ?? "",
		rulesFile: c.rulesFile ?? "",
		workerHarness: c.workerHarness ?? "",
		workerModel: c.workerModel ?? "",
		review: c.workersRequestReview === undefined ? "" : c.workersRequestReview ? "on" : "off",
		autoReview: c.autoReview === undefined ? "" : c.autoReview ? "on" : "off",
	};
}

/** What differs from the saved settings, as the backend takes it ("" or null clears one). */
function changesOf(draft: Draft, saved: Draft): OrchestratorSettingsBody {
	const body: OrchestratorSettingsBody = {};
	for (const key of ["harness", "model", "effort", "permissions", "rules", "rulesFile", "workerHarness", "workerModel"] as const) {
		if (draft[key] !== saved[key]) body[key] = draft[key];
	}
	if (draft.review !== saved.review) body.workersRequestReview = draft.review === "" ? null : draft.review === "on";
	if (draft.autoReview !== saved.autoReview) body.autoReview = draft.autoReview === "" ? null : draft.autoReview === "on";
	return body;
}

function ToggleSelect(p: { id: string; label: string; value: string; onChange: (v: string) => void }): ReactElement {
	return h(
		"select",
		{ id: p.id, className: "omps-input", "aria-label": p.label, value: p.value, onChange: (e: Event) => p.onChange((e.target as HTMLSelectElement).value) },
		...Object.entries(TOGGLE_LABEL).map(([v, text]) => h("option", { key: v, value: v }, text)),
	);
}

/** The project's orchestrator settings (AO's project settings: `switchyard orchestrator config`). A running orchestrator keeps what it started with: Restart applies them. */
function SettingsPanel(p: { host: Host; projectId: string; running: boolean; harnesses: Harnesses | null; initial: OrchestratorConfig | undefined; onRestarted: (started: OrchestratorStarted) => void }): ReactElement {
	const [saved, setSaved] = useState<Draft | null>(p.initial ? draftOf(p.initial) : null);
	const [draft, setDraft] = useState<Draft | null>(saved);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState<"save" | "restart" | null>(null);
	const [confirm, setConfirm] = useState(false);
	const [justSaved, setJustSaved] = useState(false);
	const base = `omps-orch-${p.projectId}`;

	const adopt = (settings: OrchestratorSettings): void => {
		const next = draftOf(settings.config);
		setSaved(next);
		setDraft(next);
	};
	useEffect(() => {
		p.host
			.request<OrchestratorSettings>(`/orchestrators/${encodeURIComponent(p.projectId)}/config`)
			.then(adopt)
			.catch(err => setError(errorMessage(err)));
	}, [p.projectId]);

	if (!saved || !draft) return error ? h(ErrorBox, { message: error }) : h("div", { className: "omps-loading" }, h("span", { className: "omps-spinner" }), "Loading settings…");
	const set = (key: keyof Draft) => (v: string) => {
		setDraft({ ...draft, [key]: v });
		setJustSaved(false);
	};
	const changes = changesOf(draft, saved);
	const dirty = Object.keys(changes).length > 0;

	const save = async (): Promise<void> => {
		setBusy("save");
		setError(null);
		try {
			adopt(await p.host.request<OrchestratorSettings>(`/orchestrators/${encodeURIComponent(p.projectId)}/config`, { method: "POST", body: changes }));
			setJustSaved(true);
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(null);
		}
	};
	const restart = async (): Promise<void> => {
		setBusy("restart");
		setError(null);
		try {
			p.onRestarted(await p.host.request<OrchestratorStarted>(`/orchestrators/${encodeURIComponent(p.projectId)}/restart`, { method: "POST", body: {} }));
			setConfirm(false);
			setJustSaved(false);
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(null);
		}
	};

	return h(
		"form",
		{
			className: "omps-orch-settings",
			"aria-label": "Orchestrator settings",
			onSubmit: (e: Event) => {
				e.preventDefault();
				if (dirty) void save();
			},
		},
		h(Field, { label: "Orchestrator harness", htmlFor: `${base}-harness`, hint: "AO's chat harness it runs on", children: h(HarnessSelect, { id: `${base}-harness`, label: "Orchestrator harness", value: draft.harness, blank: "AO's choice", harnesses: p.harnesses, onChange: set("harness") }) }),
		h(Field, { label: "Model", htmlFor: `${base}-model`, hint: "As the harness names it", children: h("input", { id: `${base}-model`, className: "omps-input omps-mono", value: draft.model, placeholder: "The harness's default", autoComplete: "off", spellCheck: false, onChange: (e: Event) => set("model")((e.target as HTMLInputElement).value) }) }),
		h(Field, { label: "Effort", htmlFor: `${base}-effort`, children: h("input", { id: `${base}-effort`, className: "omps-input omps-mono", value: draft.effort, placeholder: "The harness's default", autoComplete: "off", spellCheck: false, onChange: (e: Event) => set("effort")((e.target as HTMLInputElement).value) }) }),
		h(Field, {
			label: "Permissions",
			htmlFor: `${base}-permissions`,
			hint: "Approval mode a new orchestrator starts in",
			children: h(
				"select",
				{ id: `${base}-permissions`, className: "omps-input", value: draft.permissions, onChange: (e: Event) => set("permissions")((e.target as HTMLSelectElement).value) },
				h("option", { value: "" }, "AO's default for an orchestrator (bypass-permissions)"),
				...(Object.entries(PERMISSIONS) as Array<[OrchestratorPermissions, string]>).map(([v, text]) => h("option", { key: v, value: v }, text)),
			),
		}),
		h(Field, {
			label: "Standing rules",
			htmlFor: `${base}-rules`,
			hint: "Instructions it always follows for this project",
			children: h("textarea", { id: `${base}-rules`, className: "omps-input", rows: 4, value: draft.rules, placeholder: "Always ask for a review. Never merge.", onChange: (e: Event) => set("rules")((e.target as HTMLTextAreaElement).value) }),
		}),
		h(Field, { label: "Rules file", htmlFor: `${base}-rules-file`, hint: "A file of the project with the rules", children: h("input", { id: `${base}-rules-file`, className: "omps-input omps-mono", value: draft.rulesFile, placeholder: "Not set", autoComplete: "off", spellCheck: false, onChange: (e: Event) => set("rulesFile")((e.target as HTMLInputElement).value) }) }),
		h(Field, { label: "Worker harness", htmlFor: `${base}-worker-harness`, hint: "For the workers it starts", children: h(HarnessSelect, { id: `${base}-worker-harness`, label: "Worker harness", value: draft.workerHarness, blank: "The project's setting, else AO's", harnesses: p.harnesses, onChange: set("workerHarness") }) }),
		h(Field, { label: "Worker model", htmlFor: `${base}-worker-model`, children: h("input", { id: `${base}-worker-model`, className: "omps-input omps-mono", value: draft.workerModel, placeholder: "The harness's default", autoComplete: "off", spellCheck: false, onChange: (e: Event) => set("workerModel")((e.target as HTMLInputElement).value) }) }),
		h(Field, { label: "Workers request a review", htmlFor: `${base}-review`, hint: "Of their PRs, from AO's reviewer", children: h(ToggleSelect, { id: `${base}-review`, label: "Workers request a review", value: draft.review, onChange: set("review") }) }),
		h(Field, { label: "AO reviews PRs by itself", htmlFor: `${base}-auto-review`, children: h(ToggleSelect, { id: `${base}-auto-review`, label: "AO reviews PRs by itself", value: draft.autoReview, onChange: set("autoReview") }) }),
		error ? h("div", { className: "omps-orch-settings-wide" }, h(ErrorBox, { message: error })) : null,
		h(
			"div",
			{ className: "omps-orch-settings-foot" },
			p.running ? h("span", { className: "omps-hint" }, justSaved ? "Saved. The running orchestrator keeps what it started with: restart it to apply." : "A running orchestrator keeps the settings it started with.") : h("span", { className: "omps-hint" }, justSaved ? "Saved: the next orchestrator starts with it." : "Settings of the next orchestrator this project starts."),
			h("span", { className: "omps-grow" }),
			p.running
				? confirm
					? h(
							"span",
							{ className: "omps-confirm" },
							"Replace it with a fresh one? Its context is lost.",
							h(Button, { small: true, kind: "danger", label: "Restart", busy: busy === "restart", onClick: () => void restart() }),
							h(Button, { small: true, kind: "ghost", label: "Cancel", onClick: () => setConfirm(false) }),
						)
					: h(Button, { small: true, kind: justSaved && !dirty ? "primary" : "default", icon: "refresh", label: "Restart to apply", title: dirty ? "Save first: a restart starts from the saved settings" : "Replace the orchestrator with a fresh one on these settings", disabled: dirty, onClick: () => setConfirm(true) })
				: null,
			h(Button, { type: "submit", small: true, kind: dirty ? "primary" : "default", label: "Save", disabled: !dirty, busy: busy === "save" }),
		),
	);
}

// ---------- the card ----------

function OrchestratorCard(p: {
	host: Host;
	project: { id: string; name: string; path: string };
	o: Orchestrator | undefined;
	now: number;
	harnesses: Harnesses | null;
	onOpenSession: (id: string) => void;
	onOpenAo: () => void;
	onChanged: () => void;
	onNotice: (text: string) => void;
}): ReactElement {
	const { o, project } = p;
	const [showSettings, setShowSettings] = useState(!o);
	const [allWorkers, setAllWorkers] = useState(false);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [confirmStop, setConfirmStop] = useState(false);

	const run = async (name: string, fn: () => Promise<void>): Promise<void> => {
		setBusy(name);
		setError(null);
		try {
			await fn();
			p.onChanged();
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(null);
		}
	};
	const answer = (text: string): Promise<void> =>
		run("answer", async () => {
			if (!o?.question) return;
			await p.host.request(`/sessions/${encodeURIComponent(o.id)}/answer`, { method: "POST", body: { answer: text, question: o.question.id } });
		});
	const stop = (): Promise<void> =>
		run("stop", async () => {
			await p.host.request(`/orchestrators/${encodeURIComponent(project.id)}/stop`, { method: "POST", body: {} });
			setConfirmStop(false);
		});
	const start = (): Promise<void> =>
		run("start", async () => {
			const started = await p.host.request<OrchestratorStarted>(`/orchestrators/${encodeURIComponent(project.id)}/start`, { method: "POST", body: {} });
			p.onNotice(`${started.revived ? "Brought back" : "Started"} the orchestrator of ${project.name}: ${started.id}.`);
		});
	// The orchestrator's chat is a session: the VS Code flow takes its id.
	const openVscode = (): Promise<void> =>
		run("vscode", async () => {
			if (o) p.onNotice(await openInVscode(p.host, `/sessions/${encodeURIComponent(o.id)}/vscode`));
		});
	// A worker's PR review opens in VS Code through the same flow, on the worker's session.
	const reviewPr = (session: string, pr: number): Promise<void> =>
		run("vscode", async () => p.onNotice(await openInVscode(p.host, `/sessions/${encodeURIComponent(session)}/vscode`, { review: "pr", pr })));

	const workers = o?.workers ?? [];
	const shown = allWorkers ? workers : workers.slice(0, WORKERS_SHOWN);
	return h(
		"section",
		{ className: cx("omps-bcard omps-orch", o?.active && "is-on", o && `tone-${o.state}`), "aria-label": `Orchestrator of ${project.name}` },
		h(
			"header",
			{ className: "omps-bcard-head" },
			h("span", { className: "omps-bcard-icon" }, icon("sparkle", 15)),
			h(
				"div",
				{ className: "omps-bcard-titles" },
				h("div", { className: "omps-bcard-name" }, project.name),
				h(
					"div",
					{ className: "omps-bcard-slug", title: project.path },
					o ? [o.harness ? `${o.harness}${o.model ? ` ${o.model}` : ""} · ` : "", shortId(o.id), o.updatedAt ? ` · ${ago(o.updatedAt, p.now)}` : ""].join("") : "no orchestrator yet",
				),
			),
			h("span", { className: "omps-grow" }),
			o ? h("span", { className: cx("omps-state", `tone-${o.state}`), title: o.displayStatus }, h("span", { className: cx("omps-dot", `tone-${o.state}`) }), `${STATE_LABEL[o.state]}${o.active || o.state === "stopped" ? "" : " (stopped)"}`) : null,
		),
		o
			? h(
					"div",
					{ className: "omps-orch-actions" },
					h(Button, { small: true, kind: "ghost", icon: "external", label: "Open in VS Code", title: "Open the orchestrator's chat in VS Code", busy: busy === "vscode", onClick: () => void openVscode() }),
					h(Button, { small: true, kind: "ghost", icon: "server", label: "AO dashboard", title: "Agent Orchestrator's own web UI: terminals, PRs, the reviewer", onClick: p.onOpenAo }),
					h("span", { className: "omps-grow" }),
					o.active
						? confirmStop
							? h(
									"span",
									{ className: "omps-confirm" },
									"Stop the orchestrator?",
									h(Button, { small: true, kind: "danger", label: "Stop", busy: busy === "stop", onClick: () => void stop() }),
									h(Button, { small: true, kind: "ghost", label: "Cancel", onClick: () => setConfirmStop(false) }),
								)
							: h(Button, { small: true, kind: "ghost", icon: "stop", label: "Stop", title: "End its agent (its transcript stays; a task or Start brings it back)", onClick: () => setConfirmStop(true) })
						: h(Button, { small: true, kind: "primary", icon: "send", label: "Start", title: "Bring the stopped orchestrator back", busy: busy === "start", onClick: () => void start() }),
				)
			: h("div", { className: "omps-orch-empty omps-muted" }, `${project.name} has no orchestrator yet: a task above starts one (on the harness set here, else AO's choice).`),
		error ? h("div", { className: "omps-orch-pad" }, h(ErrorBox, { message: error })) : null,
		o?.state === "needs_input" && o.question
			? h("div", { className: "omps-orch-pad" }, h(AnswerBox, { key: o.question.id, q: o.question, busy: busy === "answer", onAnswer: text => void answer(text) }))
			: null,
		o?.reply ? h("div", { className: "omps-orch-pad" }, h(Reply, { key: o.id, text: o.reply })) : null,
		o
			? h(
					"div",
					{ className: "omps-bcard-cards" },
					h("div", { className: "omps-section-label" }, `Workers · ${countsLine(o)}`),
					workers.length
						? h(
								"ul",
								{ className: "omps-orch-workers" },
								...shown.map(w => h(WorkerRow, { key: w.id, w, now: p.now, onOpen: p.onOpenSession, onReview: reviewPr })),
								workers.length > WORKERS_SHOWN ? h("li", { key: "more" }, h(Button, { small: true, kind: "ghost", label: allWorkers ? "Show fewer" : `Show all ${workers.length}`, onClick: () => setAllWorkers(!allWorkers) })) : null,
							)
						: h("div", { className: "omps-muted" }, "No worker sessions in this project yet."),
				)
			: null,
		h(
			"div",
			{ className: "omps-orch-settings-bar" },
			h(Button, { small: true, kind: "ghost", icon: "chevron", label: "Settings", pressed: showSettings, className: cx(showSettings && "is-open"), title: "Harness, model, rules, workers and review of this project's orchestrator", onClick: () => setShowSettings(!showSettings) }),
		),
		showSettings ? h(SettingsPanel, { host: p.host, projectId: project.id, running: Boolean(o?.active), harnesses: p.harnesses, initial: o?.config, onRestarted: started => (p.onNotice(`Replaced the orchestrator of ${project.name} with ${started.id}.`), p.onChanged()) }) : null,
	);
}

// ---------- the view ----------

export function OrchestratorPanel(p: { host: Host; now: number; onOpenSession: (id: string) => void; onOpenAo: () => void }): ReactElement {
	const { host } = p;
	const [list, setList] = useState<Orchestrator[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [places, setPlaces] = useState<Places | null>(null);
	const [placesError, setPlacesError] = useState<string | null>(null);
	const [harnesses, setHarnesses] = useState<Harnesses | null>(null);
	const [project, setProject] = useState("");
	const [notice, setNotice] = useState<string | null>(null);

	const load = async (): Promise<void> => {
		try {
			setList((await host.request<OrchestratorList>("/orchestrators")).orchestrators);
			setError(null);
		} catch (err) {
			setError(errorMessage(err));
		}
	};
	useEffect(() => {
		void load();
		const timer = setInterval(() => {
			if (!document.hidden) void load();
		}, POLL_MS);
		return () => clearInterval(timer);
	}, []);
	useEffect(() => {
		host.request<Places>("/projects").then(setPlaces).catch(err => setPlacesError(errorMessage(err)));
		// Without the list the harness fields are text boxes: AO's own check still refuses an unknown harness.
		host.request<Harnesses>("/harnesses").then(setHarnesses).catch(() => setHarnesses(null));
	}, []);

	const orchestrators = list ?? [];
	const choices = choicesOf(places, orchestrators);
	// The task box starts on the busiest project: one that needs you, else a running one, else the first AO knows.
	useEffect(() => {
		if (project || !list) return;
		const first = list.find(o => o.state === "needs_input" && o.active) ?? list.find(o => o.active) ?? list[0];
		const pick = first?.projectId ?? choices[0]?.value;
		if (pick) setProject(pick);
	}, [list, places]);

	// The orchestrator of the project the task box names (an id, or a folder AO already has a project for).
	const current = orchestrators.find(o => o.projectId === project || o.projectPath === project);
	const choice = choices.find(c => c.value === project);
	const chosen = current ? { id: current.projectId, name: current.projectName, path: current.projectPath } : choice && choice.group === "AO projects" ? { id: choice.value, name: choice.label.split(" — ")[0], path: choice.label.split(" — ").slice(1).join(" — ") } : undefined;
	// The chosen project's card comes first, even without an orchestrator: its settings can be set before the first task.
	const others = orchestrators.filter(o => o.projectId !== current?.projectId);

	const changed = (): void => void load();
	const cards = [
		...(chosen ? [{ o: current, project: chosen }] : []),
		...others.map(o => ({ o, project: { id: o.projectId, name: o.projectName, path: o.projectPath } })),
	];

	if (!list) return error ? h(ErrorBox, { message: error, onRetry: () => void load() }) : h("div", { className: "omps-loading" }, h("span", { className: "omps-spinner" }), "Loading orchestrators…");
	return h(
		"div",
		{ className: "omps-orch-panel" },
		h(TaskBox, {
			host,
			choices,
			project,
			onProject: setProject,
			current,
			harnesses,
			onSubmitted: sent => {
				setNotice(`${sent.started ? "Started the orchestrator and gave it the task" : sent.revived ? "Brought the orchestrator back and gave it the task" : sent.mode === "steer" ? "Steered the orchestrator" : "Gave the orchestrator the task"}: ${sent.orchestrator} (${sent.project}${sent.harness ? `, ${sent.harness}` : ""}).`);
				setProject(sent.projectId);
				changed();
			},
		}),
		placesError ? h("div", { className: "omps-stale" }, icon("alert", 12), `Projects unavailable: ${placesError}`) : null,
		error ? h("div", { className: "omps-stale" }, icon("alert", 12), `Not refreshed: ${error}`) : null,
		notice ? h("div", { className: "omps-notice" }, icon("external", 12), notice) : null,
		cards.length === 0
			? h(Empty, {
					icon: "sparkle",
					title: "No orchestrator yet",
					body: "An orchestrator is Agent Orchestrator's coordinating agent for a project: give it a high-level task and it splits it into worker sessions, steers them and has their PRs reviewed. The first task above starts it.",
				})
			: h(
					"div",
					{ className: "omps-bgrid omps-orch-grid" },
					...cards.map(c => h(OrchestratorCard, { key: c.project.id, host, project: c.project, o: c.o, now: p.now, harnesses, onOpenSession: p.onOpenSession, onOpenAo: p.onOpenAo, onChanged: changed, onNotice: setNotice })),
				),
	);
}
