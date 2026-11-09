// Hermes dashboard entry (bundled as an IIFE to switchyard/dashboard/dist/index.js): the page as the
// "Switchyard" tab, on the dashboard's React and authenticated fetch (window.__HERMES_PLUGIN_SDK__).
// The dashboard loads dist/style.css itself (manifest "css").
import { createPage } from "./app";
import type { ReactLike } from "./react";

interface DashboardSdk {
	React: ReactLike;
	fetchJSON<T>(url: string, init?: RequestInit): Promise<T>;
}

interface DashboardRegistry {
	register(name: string, component: unknown): void;
}

declare global {
	interface Window {
		__HERMES_PLUGIN_SDK__?: DashboardSdk;
		__HERMES_PLUGINS__?: DashboardRegistry;
	}
}

const BASE = "/api/plugins/switchyard";
const sdk = window.__HERMES_PLUGIN_SDK__;
const registry = window.__HERMES_PLUGINS__;
if (sdk && registry) {
	registry.register(
		"switchyard",
		createPage({
			kind: "dashboard",
			React: sdk.React,
			request: (path, options) =>
				sdk.fetchJSON(
					BASE + path,
					options?.body === undefined
						? { method: options?.method ?? "GET" }
						: { method: options.method ?? "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(options.body) },
				),
			// The browser asks before handing vscode:// to VS Code; the page stays.
			openVscode: async link => {
				window.location.href = link.url;
			},
		}),
	);
}
