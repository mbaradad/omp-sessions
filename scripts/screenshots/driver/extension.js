// Screenshot driver for scripts/screenshots/run.mjs: builds the demo through Switchyard's extension API, then
// arranges each view and grabs the screen. Inert unless SWITCHYARD_SHOTS is set (run.mjs sets it).
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

const sleep = ms => new Promise(r => setTimeout(r, ms));

exports.activate = () => {
	if (!process.env.SWITCHYARD_SHOTS) return;
	const cfg = JSON.parse(process.env.SWITCHYARD_SHOTS);
	const log = msg => fs.appendFileSync(path.join(cfg.root, "driver.log"), `${new Date().toISOString()} ${msg}\n`);
	const finish = result => fs.writeFileSync(cfg.done, JSON.stringify(result));
	void main(cfg, log).then(
		shots => finish({ ok: true, shots }),
		err => {
			log(`failed: ${err?.stack ?? err}`);
			finish({ ok: false, error: String(err?.message ?? err) });
		},
	);
};

async function main(cfg, log) {
	const cmd = (id, ...args) => vscode.commands.executeCommand(id, ...args);
	const waitFor = async (what, fn, timeoutMs = 120_000) => {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const v = await fn();
			if (v) return v;
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
			await sleep(300);
		}
	};
	const shots = [];
	// The screen is 1600×1000 and VS Code's window sits inside it on black (no window manager to maximize it): keep the window.
	const GRAB = "import os,sys; from PIL import ImageGrab; im=ImageGrab.grab(xdisplay=os.environ['DISPLAY']); im.crop(im.convert('L').point(lambda p: 255 if p > 6 else 0).getbbox()).save(sys.argv[1])";
	const shot = async name => {
		await cmd("notifications.clearAll");
		await sleep(1500);
		execFileSync("python3", ["-c", GRAB, path.join(cfg.shots, `${name}.png`)], { timeout: 20_000 });
		shots.push(name);
		log(`shot ${name}`);
	};
	const layout = async ({ sidebar = true } = {}) => {
		await cmd("workbench.action.closeAllEditors");
		await cmd("workbench.action.closePanel");
		await cmd("workbench.action.closeAuxiliaryBar");
		if (sidebar) await cmd("workbench.view.extension.switchyard");
		else await cmd("workbench.action.closeSidebar");
	};

	const api = await vscode.extensions.getExtension("mbaradad.switchyard").activate();
	await cmd("notifications.toggleDoNotDisturbMode");
	await layout();
	// The side bar's Chat view only says "open a session here" while chats open in editor tabs.
	await cmd("switchyard.chatView.removeView").then(undefined, err => log(`hiding the Chat view: ${err}`));
	const status = id => api.sessions.get(id)?.status;
	/** Starts a session; `omp` picks what the daemon runs for it (run.mjs's bin/omp reads bin/next-omp). */
	const launch = async (project, opts, omp = "fake") => {
		fs.writeFileSync(cfg.nextOmp, omp);
		try {
			const id = await api.sessions.launch({ cwd: cfg.projects[project], ...opts });
			await waitFor(`${opts.title} started`, () => status(id) && status(id) !== "starting", 180_000);
			await sleep(2000);
			log(`launched ${opts.title} (${id}, ${omp})`);
			return id;
		} finally {
			fs.writeFileSync(cfg.nextOmp, "fake");
		}
	};
	const idle = (id, timeoutMs) => waitFor(`${id} idle`, () => status(id) === "idle", timeoutMs);

	// ---------- the demo ----------
	const dark = await launch("web-app", { title: "Dark theme for the settings page", mode: "auto", prompt: "Add a dark theme to the settings page, following the system setting." });
	await idle(dark);
	const config = await launch("acme-api", { title: "Migrate config loader", mode: "auto", prompt: "Move the config loader into src/config.ts." });
	await idle(config);
	const notes = await launch("acme-api", { title: "Release notes for 1.5", mode: "auto", prompt: "Draft the release notes for 1.5 from CHANGELOG.md." });
	await idle(notes);
	await api.sessions.stop(notes);
	await waitFor("release notes stopped", () => status(notes) === "stopped");

	const nightly = await launch("web-app", { title: "Nightly test sweep", mode: "auto" });
	await idle(nightly);
	const twoAm = new Date();
	twoAm.setHours(26, 0, 0, 0);
	await api.sessions.editQueue(nightly, [{ op: "add", title: "Run the full test suite and file the failures" }]);
	await api.sessions.editQueue(nightly, [{ op: "schedule", at: twoAm.getTime() }]);

	const deps = await launch("acme-api", { title: "Upgrade dependencies", mode: "auto" });
	await idle(deps);
	await api.sessions.editQueue(deps, [
		{ op: "add", title: "Bump express to v5", subtasks: ["Read the migration guide", "Fix removed APIs", "Run the test suite"] },
		{ op: "add", title: "Replace supertest with fetch in tests" },
		{ op: "add", title: "Write release notes for 1.5" },
	]);
	await api.sessions.editQueue(deps, [{ op: "run" }]);
	await waitFor("the first task running", () => status(deps) === "working" && (api.sessions.get(deps)?.queue?.running ?? 0) >= 1, 120_000);

	const rate = await launch("acme-api", { title: "Add rate limiting to the public API", mode: "edits", prompt: "Add rate limiting to the public API: 100 requests per minute per API key." });
	await idle(rate);
	const flaky = await launch("acme-api", { title: "Fix the flaky checkout test", mode: "ask", prompt: "The checkout test fails about one run in ten. Find out why and fix it." });
	await waitFor("the flaky test asking", () => status(flaky) === "waiting");

	// ---------- screenshots ----------
	await layout();
	api.openPanel(rate, "editor");
	await sleep(3000);
	await shot("chat");

	await layout();
	api.openPanel(flaky, "editor");
	await sleep(3000);
	await shot("sessions");

	await layout();
	api.openPanel(deps, "editor");
	await cmd("switchyard.tasks.focus");
	await sleep(3000);
	await shot("tasks");

	await layout({ sidebar: false });
	await cmd("switchyard.board");
	await sleep(4000);
	// Focus leaves the board, so its first card shows its title instead of the focused card's toolbar.
	await cmd("workbench.action.focusActivityBar");
	await shot("board");

	await layout();
	await cmd("switchyard.dashboard");
	await sleep(6000);
	await shot("dashboard");

	if (cfg.skipReal) return shots;
	// One real omp turn: its checkpoints (Switchyard's omp extension) back Review Changes and Undo.
	const signup = await launch(
		"acme-api",
		{
			title: "Validate signup input",
			mode: "auto",
			prompt:
				'In src/routes/public.ts, make the /signup handler answer 400 with { error: "invalid email" } when req.body.email is not a string containing "@". Also add a file test/signup.test.ts with one vitest test for that 400 case, written like test/checkout.test.ts. Do not run anything; reply with one short sentence.',
		},
		"real",
	);
	await idle(signup, 600_000);
	await sleep(2000);
	await layout();
	await cmd("switchyard.reviewChanges", signup);
	await sleep(5000);
	await shot("review");

	await layout();
	api.openPanel(signup, "editor");
	await sleep(3000);
	void cmd("switchyard.undo", signup); // modal: stays open; run.mjs closes VS Code
	await sleep(3000);
	await shot("checkpoints");
	return shots;
}
