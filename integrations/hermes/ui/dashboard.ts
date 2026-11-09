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
		/** The dashboard's path prefix behind a reverse proxy (X-Forwarded-Prefix); "" at the root. */
		__HERMES_BASE_PATH__?: string;
		/** True when the dashboard signs in with a session cookie; false in legacy session-token mode. */
		__HERMES_AUTH_REQUIRED__?: boolean;
	}
}

const BASE = "/api/plugins/switchyard";
const sdk = window.__HERMES_PLUGIN_SDK__;
const registry = window.__HERMES_PLUGINS__;
// Normalized like the dashboard's own fetches: a leading slash, no trailing one.
const basePath = window.__HERMES_BASE_PATH__ ?? "";
const prefix = (basePath && !basePath.startsWith("/") ? `/${basePath}` : basePath).replace(/\/+$/, "");
// Only a cookie sign-in reaches a frame; legacy token mode authenticates fetches with a header.
const cookieAuth = window.__HERMES_AUTH_REQUIRED__ !== false;
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
			aoFrame: cookieAuth ? `${prefix}${BASE}/ao/` : undefined,
			aoNote: cookieAuth
				? undefined
				: "This Hermes dashboard runs without sign-in (legacy session-token mode): its requests carry a token header that an embedded page can't send. Open the address switchyard dashboard url prints in a browser on omp's machine, or turn on the dashboard's sign-in.",
		}),
	);
}
