// The AO dashboard tab: Agent Orchestrator's own web UI, served by the Switchyard server on omp's
// machine and proxied by the plugin backend at /ao/ (plugin_api.py). The dashboard embeds it
// (same origin: the browser's Hermes sign-in cookie rides along); Desktop can't, so it opens the
// backend's public landing page (ao-dashboard.html) in the system browser.
import { type AoDashboardStatus, errorMessage, type Host } from "./api";
import { Button, Empty, ErrorBox } from "./components";
import { h, type ReactElement, useEffect, useState } from "./react";
import { icon } from "./util";

const STATUS = "/ao/switchyard-ao-dashboard/status";
const INSTALL = "switchyard dashboard install";

type Probe = { status: AoDashboardStatus } | { error: string; down: boolean } | null;

export function AoDashboardPanel(p: { host: Host }): ReactElement {
	const { host } = p;
	const [probe, setProbe] = useState<Probe>(null);
	const [opening, setOpening] = useState(false);
	const [note, setNote] = useState<string | null>(null);
	// Bumped by Reload: a new key remounts the frame at AO's start page.
	const [frameKey, setFrameKey] = useState(0);

	const check = async (): Promise<void> => {
		setProbe(null);
		try {
			setProbe({ status: await host.request<AoDashboardStatus>(STATUS) });
		} catch (err) {
			const message = errorMessage(err);
			setProbe({ error: message, down: /not running on 127\.0\.0\.1/.test(message) });
		}
	};
	useEffect(() => {
		void check();
	}, []);

	const openBrowser = async (): Promise<void> => {
		if (!host.openPage) return;
		setNote(null);
		setOpening(true);
		try {
			const { page } = await host.request<{ page: string }>("/ao-page");
			await host.openPage(page);
			setNote("Opened in your browser. Sign in to this Hermes there if it asks.");
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
			? h(Empty, { icon: "server", title: "AO dashboard server not running", body: `${probe.error}: the Switchyard planner serves it on omp's machine.`, action: checkAgain })
			: h(ErrorBox, { message: probe.error, onRetry: () => void check() });
	}
	const { status } = probe;
	if (!status.installed) {
		return h(Empty, {
			icon: "terminal",
			title: "AO dashboard not installed",
			body: h("span", null, "Run ", h("code", null, INSTALL), " on omp's machine: it fetches Agent Orchestrator's web UI from AO's release."),
			action: checkAgain,
		});
	}

	const daemon = status.daemon ? null : h("span", { className: "omps-stale omps-ao-warn" }, icon("alert", 12), "AO's daemon is not answering: the dashboard shows no live data until it is back.");
	const version = h("span", { className: "omps-muted omps-total" }, `AO dashboard${status.version ? ` ${status.version}` : ""} · port ${status.port}`);
	if (!host.aoFrame) {
		return h(
			"div",
			{ className: "omps-ao" },
			h(Empty, {
				icon: "external",
				title: "AO dashboard",
				body: host.aoNote,
				action: host.openPage ? h(Button, { kind: "brand", icon: "external", label: "Open in browser", busy: opening, onClick: () => void openBrowser() }) : checkAgain,
			}),
			note ? h("div", { className: "omps-notice omps-ao-note" }, icon("external", 12), note) : null,
			h("div", { className: "omps-ao-foot" }, version, daemon),
		);
	}
	return h(
		"div",
		{ className: "omps-ao" },
		h(
			"div",
			{ className: "omps-filters omps-ao-bar" },
			version,
			daemon,
			h("span", { className: "omps-grow" }),
			h(Button, { small: true, kind: "ghost", icon: "refresh", label: "Reload", onClick: () => setFrameKey(frameKey + 1) }),
			h("a", { className: "omps-btn omps-btn-sm omps-btn-default", href: host.aoFrame, target: "_blank", rel: "noopener" }, icon("external", 13), h("span", null, "Open in new window")),
		),
		h("iframe", { key: frameKey, className: "omps-ao-frame", src: host.aoFrame, title: "AO dashboard", allow: "clipboard-read; clipboard-write" }),
	);
}
