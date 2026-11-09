// Hermes Desktop entry (bundled as an ES module to switchyard/desktop/plugin.js): the page as a route
// with a sidebar row next to Kanban and a palette command. Its only imports are the ones Desktop
// resolves (@hermes/plugin-sdk, react); the requests go to the plugin's backend through ctx.rest,
// and the CSS rides inside the page as a <style> element (removed with the page).
import { host, PALETTE_AREA, type PluginContext, ROUTES_AREA, SIDEBAR_NAV_AREA } from "@hermes/plugin-sdk";
import * as React from "react";
import { createPage } from "./app";
import css from "./style.css";

const ROUTE = "/switchyard";

export default {
	id: "switchyard",
	name: "Switchyard",
	register(ctx: PluginContext): void {
		const Page = createPage({
			kind: "desktop",
			React,
			css,
			request: (path, options) => ctx.rest(path, options?.body === undefined ? { method: options?.method ?? "GET" } : { method: options.method ?? "POST", body: options.body }),
			// Desktop opens only web links (no vscode://), so the dashboard's redirect page, in the browser.
			openVscode: async link => {
				if (!(await ctx.os.openExternal(link.page))) throw new Error(`Hermes Desktop did not open the browser. Open this link on this computer: ${link.url}`);
			},
			// A frame can't carry Desktop's bearer token, and the SDK's SandboxedFrame has an opaque origin
			// (no storage or cookies) AO's UI can't run in: the landing page opens it in the browser instead.
			aoNote: "Hermes Desktop can't show Agent Orchestrator's web UI inside itself (an embedded page can't use Desktop's sign-in), so it opens in your browser, signed in to this Hermes.",
			openPage: async page => {
				if (!(await ctx.os.openExternal(page))) throw new Error(`Hermes Desktop did not open the browser. Open this link on this computer: ${page}`);
			},
		});
		ctx.registerMany([
			{ id: "page", area: ROUTES_AREA, data: { path: ROUTE }, render: () => React.createElement(Page, null) },
			// Kanban's row has order 50.
			{ id: "nav", area: SIDEBAR_NAV_AREA, order: 51, data: { path: ROUTE, label: "Switchyard", codicon: "pulse" } },
			{
				id: "open",
				area: PALETTE_AREA,
				data: { id: "switchyard.open", label: "Switchyard: Open", keywords: ["omp", "sessions", "coding", "agent", "switchyard"], run: () => host.navigate(ROUTE) },
			},
		]);
	},
};
