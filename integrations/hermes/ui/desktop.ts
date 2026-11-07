// Hermes Desktop entry (bundled as an ES module to omp-sessions/desktop/plugin.js): the page as a route
// with a sidebar row next to Kanban and a palette command. Its only imports are the ones Desktop
// resolves (@hermes/plugin-sdk, react); the requests go to the plugin's backend through ctx.rest,
// and the CSS rides inside the page as a <style> element (removed with the page).
import { host, PALETTE_AREA, type PluginContext, ROUTES_AREA, SIDEBAR_NAV_AREA } from "@hermes/plugin-sdk";
import * as React from "react";
import { createPage } from "./app";
import css from "./style.css";

const ROUTE = "/omp-sessions";

export default {
	id: "omp-sessions",
	name: "omp Sessions",
	register(ctx: PluginContext): void {
		const Page = createPage({
			kind: "desktop",
			React,
			css,
			request: (path, options) => ctx.rest(path, options?.body === undefined ? { method: options?.method ?? "GET" } : { method: options.method ?? "POST", body: options.body }),
		});
		ctx.registerMany([
			{ id: "page", area: ROUTES_AREA, data: { path: ROUTE }, render: () => React.createElement(Page, null) },
			// Kanban's row has order 50.
			{ id: "nav", area: SIDEBAR_NAV_AREA, order: 51, data: { path: ROUTE, label: "omp Sessions", codicon: "server-process" } },
			{
				id: "open",
				area: PALETTE_AREA,
				data: { id: "omp-sessions.open", label: "omp Sessions: Open", keywords: ["omp", "sessions", "coding", "agent", "omp-vs"], run: () => host.navigate(ROUTE) },
			},
		]);
	},
};
