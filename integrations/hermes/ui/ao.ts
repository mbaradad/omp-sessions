// The AO dashboard tab: Agent Orchestrator's own web UI, served by the Switchyard server on the Switchyard
// machine (127.0.0.1:<dashboard port>, `switchyard dashboard url`).
//   - A browser dashboard embeds the backend's /ao/ proxy (plugin_api.py): same origin, so the browser's Hermes
//     sign-in cookie rides along.
//   - Desktop can't use the proxy (its bearer token stays in its main process), so it frames the dashboard port
//     itself, when that port answers on this computer: on the Switchyard machine it does, anywhere else it takes
//     a port forward (`ssh -L <port>:localhost:<port> <host>`). Without one it opens the backend's landing page
//     (ao-dashboard.html) in the system browser.
// Either way the frame opens at AO's own page for a project (#/projects/<id>), like AO's app does.
import { type AoDashboardStatus, errorMessage, type Host, type OrchestratorList } from "./api";
import { Button, Empty, ErrorBox } from "./components";
import { h, type ReactElement, useEffect, useState } from "./react";
import { icon } from "./util";

const STATUS = "/ao/switchyard-ao-dashboard/status";
const INSTALL = "switchyard dashboard install";

interface ProjectLink {
	id: string;
	name: string;
}

interface Ready {
	status: AoDashboardStatus;
	/** The dashboard port answers on this computer: the frame (and the browser button) go straight to it. */
	direct: string | null;
	projects: ProjectLink[];
}

type Probe = Ready | { error: string; down: boolean } | null;

/** AO's web UI route for a project (its hash router), or its start page. */
function aoRoute(projectId: string | undefined): string {
	return projectId ? `#/projects/${encodeURIComponent(projectId)}` : "";
}

/** The project to open first: the one chosen in the page's filter, else the only one with an orchestrator. */
function initialProject(projects: ProjectLink[], filter: string): string | undefined {
	const chosen = projects.find(x => x.id === filter || x.name === filter);
	return (chosen ?? (projects.length === 1 ? projects[0] : undefined))?.id;
}

/** Whether a page on this computer is served at `origin` (reaches a no-CORS opaque response, never its body). */
async function answers(origin: string): Promise<boolean> {
	try {
		await fetch(`${origin}${STATUS.replace("/ao/", "/")}`, { mode: "no-cors", cache: "no-store" });
		return true;
	} catch {
		return false;
	}
}

export function AoDashboardPanel(p: { host: Host; project: string }): ReactElement {
	const { host } = p;
	const [probe, setProbe] = useState<Probe>(null);
	const [opening, setOpening] = useState(false);
	const [note, setNote] = useState<string | null>(null);
	// The project AO opens at; "" is AO's start page.
	const [target, setTarget] = useState<string | undefined>(undefined);
	// Bumped by Reload: a new key remounts the frame.
	const [frameKey, setFrameKey] = useState(0);

	const check = async (): Promise<void> => {
		setProbe(null);
		try {
			const status = await host.request<AoDashboardStatus>(STATUS);
			const origin = `http://localhost:${status.port}`;
			const direct = host.aoDirect && status.installed && (await answers(origin)) ? `${origin}/` : null;
			const projects = await host
				.request<OrchestratorList>("/orchestrators")
				.then(list => list.orchestrators.map(o => ({ id: o.projectId, name: o.projectName })).filter((x, i, all) => all.findIndex(y => y.id === x.id) === i))
				.catch(() => []);
			setTarget(initialProject(projects, p.project));
			setProbe({ status, direct, projects });
		} catch (err) {
			const message = errorMessage(err);
			setProbe({ error: message, down: /not running on 127\.0\.0\.1/.test(message) });
		}
	};
	useEffect(() => {
		void check();
	}, []);

	const openBrowser = async (direct: string | null): Promise<void> => {
		if (!host.openPage) return;
		setNote(null);
		setOpening(true);
		try {
			const page = direct ? `${direct}${aoRoute(target)}` : (await host.request<{ page: string }>("/ao-page")).page;
			await host.openPage(page);
			setNote(direct ? "Opened in your browser." : "Opened in your browser. Sign in to this Hermes there if it asks.");
		} catch (err) {
			setNote(errorMessage(err));
		} finally {
			setOpening(false);
		}
	};

	const checkAgain = h(Button, { label: "Check again", icon: "refresh", onClick: () => void check() });
	if (!probe) return h("div", { className: "omps-loading" }, h("span", { className: "omps-spinner" }), "Checking the AO dashboard…");
	if ("error" in probe) {
		return probe.down
			? h(Empty, { icon: "server", title: "AO dashboard server not running", body: `${probe.error}: the Switchyard planner serves it on the Switchyard machine.`, action: checkAgain })
			: h(ErrorBox, { message: probe.error, onRetry: () => void check() });
	}
	const { status, direct, projects } = probe;
	if (!status.installed) {
		return h(Empty, {
			icon: "terminal",
			title: "AO dashboard not installed",
			body: h("span", null, "Run ", h("code", null, INSTALL), " on the Switchyard machine: it fetches Agent Orchestrator's web UI from AO's release."),
			action: checkAgain,
		});
	}

	const daemon = status.daemon ? null : h("span", { className: "omps-stale omps-ao-warn" }, icon("alert", 12), "AO's daemon is not answering: the dashboard shows no live data until it is back.");
	const version = h("span", { className: "omps-muted omps-total" }, `AO dashboard${status.version ? ` ${status.version}` : ""} · port ${status.port}`);
	const src = direct ? `${direct}${aoRoute(target)}` : host.aoFrame ? `${host.aoFrame}${aoRoute(target)}` : undefined;
	if (!src) {
		const forward = `ssh -L ${status.port}:localhost:${status.port} <the Switchyard machine>`;
		return h(
			"div",
			{ className: "omps-ao" },
			h(Empty, {
				icon: "external",
				title: "AO dashboard",
				body: host.aoDirect
					? h("span", null, `${host.aoNote ?? ""} To show it here, forward its port to this computer: `, h("code", null, forward), ".")
					: host.aoNote,
				action: host.openPage ? h(Button, { kind: "brand", icon: "external", label: "Open in browser", busy: opening, onClick: () => void openBrowser(null) }) : checkAgain,
			}),
			note ? h("div", { className: "omps-notice omps-ao-note" }, icon("external", 12), note) : null,
			h("div", { className: "omps-ao-foot" }, version, daemon),
		);
	}
	const projectButtons = projects.map(x =>
		h(Button, { key: x.id, small: true, kind: target === x.id ? "primary" : "ghost", pressed: target === x.id, label: x.name, title: `AO's page for ${x.name}`, onClick: () => setTarget(x.id) }),
	);
	return h(
		"div",
		{ className: "omps-ao" },
		h(
			"div",
			{ className: "omps-filters omps-ao-bar" },
			version,
			daemon,
			projects.length ? h(Button, { small: true, kind: target ? "ghost" : "primary", pressed: !target, label: "All projects", onClick: () => setTarget(undefined) }) : null,
			...projectButtons,
			h("span", { className: "omps-grow" }),
			h(Button, { small: true, kind: "ghost", icon: "refresh", label: "Reload", onClick: () => setFrameKey(frameKey + 1) }),
			host.openPage
				? h(Button, { small: true, icon: "external", label: "Open in browser", busy: opening, onClick: () => void openBrowser(direct) })
				: h("a", { className: "omps-btn omps-btn-sm omps-btn-default", href: src, target: "_blank", rel: "noopener" }, icon("external", 13), h("span", null, "Open in new window")),
		),
		note ? h("div", { className: "omps-notice omps-ao-note" }, icon("external", 12), note) : null,
		h("iframe", { key: `${frameKey}:${target ?? ""}`, className: "omps-ao-frame", src, title: "AO dashboard", allow: "clipboard-read; clipboard-write" }),
	);
}
