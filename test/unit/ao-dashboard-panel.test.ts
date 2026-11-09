import assert from "node:assert/strict";
import { test } from "node:test";
import manifest from "../../package.json" with { type: "json" };
import { dashboardHtml, frameUrl } from "../../src/ext/ao-dashboard-core";
import { type DashboardFacts, dashboardChecks } from "../../src/ext/doctor-ao";
import { commandGroup } from "../../src/ext/toolbox-core";

const NONCE = "bm9uY2Vub25jZQ==";

test("frameUrl: the path ends with / (AO's UI loads as a folder, routes by hash); only http(s)", () => {
	assert.equal(frameUrl("http://127.0.0.1:3012").toString(), "http://127.0.0.1:3012/");
	assert.equal(frameUrl("https://x-3012.app.github.dev/proxy/3012").toString(), "https://x-3012.app.github.dev/proxy/3012/");
	assert.equal(frameUrl("http://localhost:41234/#/projects/x").toString(), "http://localhost:41234/");
	assert.throws(() => frameUrl("file:///etc/passwd"), /not an http/);
	assert.throws(() => frameUrl("javascript:alert(1)"), /not an http/);
});

test("dashboardHtml: strict CSP framing only the dashboard origin, nonce'd script and style", () => {
	const html = dashboardHtml("http://localhost:41234/", NONCE);
	const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1];
	assert.equal(csp, `default-src 'none'; frame-src http://localhost:41234; style-src 'nonce-${NONCE}'; script-src 'nonce-${NONCE}';`);
	assert.match(html, /<iframe id="frame" src="http:\/\/localhost:41234\/" allow="clipboard-read; clipboard-write"/);
	assert.equal(html.match(/<script/g)?.length, 1);
	assert.match(html, new RegExp(`<script nonce="${NONCE}">`));
	assert.match(html, /postMessage\(\{ type: "open" \}\)/);
});

test("dashboardHtml: a hostile URL can't break out of the attributes or the script", () => {
	const html = dashboardHtml(`http://localhost:1/a"onload="x'</script><b>/`, NONCE);
	assert.ok(!html.includes('"onload="'));
	assert.ok(!html.includes("</script><b>"));
	assert.equal(html.match(/<\/script>/g)?.length, 1);
});

const FACTS: DashboardFacts = { enabled: true, url: "http://127.0.0.1:3012/", install: { version: "0.9.1", source: "release v0.9.1" }, serving: { daemon: true }, installCommand: "switchyard dashboard install" };

test("dashboardChecks: healthy is ok; never an error", () => {
	const checks = dashboardChecks(FACTS);
	assert.deepEqual(
		checks.map(c => [c.level, c.title]),
		[
			["ok", "AO dashboard 0.9.1 installed"],
			["ok", "AO dashboard served at http://127.0.0.1:3012/"],
		],
	);
	const broken = [dashboardChecks({ ...FACTS, install: undefined, serving: undefined }), dashboardChecks({ ...FACTS, serving: { daemon: false } }), dashboardChecks({ ...FACTS, enabled: false })].flat();
	assert.ok(broken.every(c => c.level !== "error"));
});

test("dashboardChecks: not installed offers the install command; not served offers start/log; off is a note", () => {
	const missing = dashboardChecks({ ...FACTS, install: undefined, serving: undefined });
	assert.equal(missing[0].level, "warn");
	assert.match(missing[0].detail ?? "", /switchyard dashboard install/);
	assert.deepEqual(missing[0].fixes?.map(f => f.command), ["switchyard.installAoDashboard"]);
	assert.match(missing[1].title, /Nothing serves the AO dashboard at http:\/\/127\.0\.0\.1:3012\//);
	assert.deepEqual(missing[1].fixes?.map(f => f.command), ["switchyard.server.start", "switchyard.server.showLog"]);
	assert.equal(dashboardChecks({ ...FACTS, serving: { daemon: false } })[1].level, "info");
	assert.deepEqual(
		dashboardChecks({ ...FACTS, enabled: false }).map(c => c.level),
		["info"],
	);
});

test("manifest: Open AO Dashboard is a Switchyard command in the Sessions view menu and the command center", () => {
	const cmd = manifest.contributes.commands.find(c => c.command === "switchyard.openAoDashboard");
	assert.deepEqual(cmd && { title: cmd.title, category: cmd.category, icon: cmd.icon }, { title: "Open AO Dashboard", category: "Switchyard", icon: "$(dashboard)" });
	assert.ok(manifest.contributes.commands.some(c => c.command === "switchyard.installAoDashboard"));
	assert.ok(manifest.contributes.menus["view/title"].some(m => m.command === "switchyard.openAoDashboard" && m.when === "view == switchyard.sessions"));
	assert.equal(commandGroup("switchyard.openAoDashboard"), "Sessions");
});
