import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginReport } from "../../src/shared/hermes-plugin";
import { type HermesFacts, hermesChecks } from "../../src/ext/doctor-hermes";

const NOW = 1_800_000_000_000;

function profile(label: string, over: Partial<PluginReport> & { current?: boolean; managed?: boolean } = {}): PluginReport {
	const { current = true, managed = true, ...rest } = over;
	return { label, home: `/h/${label}`, target: `/h/${label}/plugins/omp-sessions`, state: { installed: true, managed, current }, status: "enabled", lane: false, injection: true, ...rest };
}

const missing = (label: string): PluginReport => ({ label, home: `/h/${label}`, target: `/h/${label}/plugins/omp-sessions`, state: { installed: false, managed: false, current: false } });

function facts(profiles: PluginReport[], over: Partial<HermesFacts> = {}): HermesFacts {
	return {
		hermes: "/usr/bin/hermes",
		profiles,
		lane: { profile: "default", status: { dispatcherNotes: [], dispatcher: { at: NOW / 1000 - 30, profile: "default", laneOn: true } } },
		ompVs: { path: "/home/u/.local/bin/omp-vs", via: "install" },
		gatewayPath: true,
		now: NOW,
		...over,
	};
}

const warnings = (f: HermesFacts) => hermesChecks(f).filter(c => c.level === "warn" || c.level === "error");

test("healthy: current, enabled, lane on in the dispatcher's profile", () => {
	const checks = hermesChecks(facts([profile("default", { lane: true }), profile("work")]));
	assert.deepEqual(warnings(facts([profile("default", { lane: true }), profile("work")])), []);
	assert.ok(checks.some(c => c.level === "ok" && c.title === "omp-sessions plugin current and enabled in 2 profile(s)"));
	assert.ok(checks.some(c => c.level === "ok" && c.title === "Kanban dispatcher runs the plugin in default"));
	assert.ok(checks.some(c => c.level === "ok" && c.title === "Kanban lane on in default, the dispatcher's profile"));
});

test("not installed anywhere: one info with Install; nothing else", () => {
	const checks = hermesChecks(facts([missing("default"), missing("work")], { lane: undefined }));
	assert.deepEqual(
		checks.map(c => [c.level, c.title, c.fixes?.map(f => f.command)]),
		[
			["ok", "Hermes Agent found", undefined],
			["info", "omp-sessions plugin not installed", ["omp.hermes.install"]],
		],
	);
});

test("a managed copy newer than the bundle (another editor's omp-vs) is info, never an Update", () => {
	const checks = hermesChecks(facts([profile("default", { current: false, ahead: true })]));
	assert.equal(checks.some(c => c.title.startsWith("omp-sessions plugin outdated")), false);
	const ahead = checks.find(c => c.title === "omp-sessions plugin in default is newer than this extension's");
	assert.deepEqual([ahead?.level, ahead?.fixes], ["info", undefined]);
});

test("outdated managed copies → Update with their profiles; Git installs → info only; disabled → Enable", () => {
	const checks = hermesChecks(facts([profile("default", { current: false, lane: true }), profile("work", { current: false }), profile("git", { current: false, managed: false }), profile("off", { status: "disabled", lane: undefined, injection: undefined })]));
	const outdated = checks.find(c => c.title.startsWith("omp-sessions plugin outdated"));
	assert.equal(outdated?.level, "warn");
	assert.deepEqual(outdated?.fixes, [{ label: "Update", command: "omp.hermes.update", args: [["default", "work"]] }]);
	assert.equal(checks.find(c => c.title.includes("differs from the bundled one"))?.level, "info");
	assert.deepEqual(checks.find(c => c.title === "omp-sessions plugin disabled in off")?.fixes, [{ label: "Enable", command: "omp.hermes.enable", args: ["off"] }]);
});

test("notifications: allow_gateway_injection off, and a refused notification", () => {
	const f = facts([profile("default", { lane: true, injection: false })]);
	f.lane = { profile: "default", status: { dispatcherNotes: [], dispatcher: { at: NOW / 1000 - 10, profile: "default" }, lastNotification: { at: NOW / 1000 - 120, ok: false, session: "0123456789" } } };
	const titles = warnings(f).map(c => c.title);
	assert.deepEqual(titles, ["Notifications off in default", "Hermes refused the last notification (default)"]);
	assert.deepEqual(warnings(f)[0].fixes, [{ label: "Allow", command: "omp.hermes.enable", args: ["default"] }]);
});

test("an undelivered notification with notifications allowed is not a warning (the chat had ended)", () => {
	const f = facts([profile("default", { lane: true, injection: true })]);
	f.lane = { profile: "default", status: { dispatcherNotes: [], dispatcher: { at: NOW / 1000 - 10, profile: "default" }, lastNotification: { at: NOW / 1000 - 120, ok: false, session: "0123456789" } } };
	assert.deepEqual(warnings(f), []);
	assert.equal(hermesChecks(f).find(c => c.title.startsWith("Hermes didn't deliver"))?.level, "info");
});

test("lane on in several profiles, dispatcher in default: one warning, turn off the others", () => {
	const w = warnings(facts([profile("default", { lane: true }), profile("work", { lane: true }), profile("ops", { lane: true })]));
	assert.equal(w.length, 1);
	assert.equal(w[0].title, "Kanban lane on in 3 profiles: default, work, ops");
	assert.deepEqual(
		w[0].fixes?.map(f => f.args),
		[
			["work", "off"],
			["ops", "off"],
		],
	);
});

test("lane on only in a profile the dispatcher doesn't tick: turn it on there and off here", () => {
	const w = warnings(facts([profile("default"), profile("work", { lane: true })]));
	assert.equal(w.length, 1);
	assert.equal(w[0].title, "Kanban lane on in work, but the dispatcher runs the plugin in default");
	assert.deepEqual(
		w[0].fixes?.map(f => [f.command, ...(f.args ?? [])]),
		[
			["omp.hermes.lane", "default", "on"],
			["omp.hermes.lane", "work", "off"],
		],
	);
});

test("dispatcher in a named profile (separate gateways) makes default the wrong one", () => {
	const f = facts([profile("default", { lane: true }), profile("lightscale")]);
	f.lane = { profile: "default", status: { dispatcherNotes: [], dispatcher: { at: NOW / 1000 - 5, profile: "lightscale" } } };
	assert.deepEqual(warnings(f)[0].fixes?.map(x => x.label), ["Turn on in lightscale", "Turn off in default"]);
});

test("unknown dispatcher: soft notes only", () => {
	const old = facts([profile("default"), profile("work", { lane: true })], { lane: { profile: "default", status: { dispatcherNotes: [] } } });
	assert.deepEqual(warnings(old), []);
	const checks = hermesChecks(old);
	assert.ok(checks.some(c => c.level === "info" && c.title === "The plugin in default doesn't report the kanban dispatcher"));
	assert.ok(checks.some(c => c.level === "info" && c.title === "Kanban lane on in work"));
	// Several lanes without a dispatcher: warn, keep default.
	const many = facts([profile("default", { lane: true }), profile("work", { lane: true })], { lane: { profile: "default", error: "timed out" } });
	assert.deepEqual(warnings(many).map(c => [c.title, c.fixes?.map(f => f.args)]), [["Kanban lane on in 2 profiles: default, work", [["work", "off"]]]]);
});

test("dispatcher silent or stale: warn when a lane is on", () => {
	const none = facts([profile("default", { lane: true })], { lane: { profile: "default", status: { dispatcherNotes: ["No kanban dispatcher tick has reached the plugin yet."], dispatcher: null } } });
	assert.deepEqual(warnings(none).map(c => [c.title, c.detail]), [["No kanban dispatcher tick has reached the plugin", "No kanban dispatcher tick has reached the plugin yet."]]);
	const stale = facts([profile("default", { lane: true })], { lane: { profile: "default", status: { dispatcherNotes: [], dispatcher: { at: NOW / 1000 - 600, profile: "default" } } } });
	assert.deepEqual(warnings(stale).map(c => c.title), ["Kanban dispatcher last ticked 10 min ago"]);
	const quiet = facts([profile("default")], { lane: { profile: "default", status: { dispatcherNotes: [], dispatcher: { at: NOW / 1000 - 600, profile: "default" } } } });
	assert.deepEqual(warnings(quiet), [], "no lane: only info");
});

test("omp-vs: missing is an error when the gateway's PATH was searched, else a warning", () => {
	const searched = warnings(facts([profile("default", { ompVs: "/nope/omp-vs" })], { ompVs: undefined }));
	assert.deepEqual(
		searched.map(c => [c.level, c.title, c.fixes?.[0].command]),
		[["error", "The plugin may not find omp-vs", "omp.installCli"]],
	);
	assert.match(searched[0].detail ?? "", /omp_vs setting \(\/nope\/omp-vs\)/);
	assert.equal(warnings(facts([profile("default")], { ompVs: undefined, gatewayPath: false }))[0].level, "warn");
	assert.equal(hermesChecks(facts([profile("default", { status: "disabled", lane: undefined })], { ompVs: undefined })).some(c => c.title.includes("omp-vs")), false, "not checked when no profile loads the plugin");
});
