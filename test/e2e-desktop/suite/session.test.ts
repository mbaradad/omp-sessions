// Runs inside a local desktop VS Code extension host (Electron), with omp.path → test/fake-omp.mjs.
import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as vscode from "vscode";
import { type SessionMeta, sessionDir } from "../../../src/shared/protocol";
import { HostClient, ancestors, env, hostPids, pidAlive, procStat, readChanges, readMeta, readQueue, sessionIds, waitFor } from "./util";

const EXTENSION_ID = "mbaradad.omp-sessions";
const workspace = env("OMP_E2E_WORKSPACE");
const stateFile = env("OMP_E2E_STATE");
const fakeLog = env("FAKE_OMP_LOG");
const helloFile = path.join(workspace, "hello.txt");
const existingFile = path.join(workspace, "existing.txt");

/** The session host must not be a descendant of this (extension host) process and must lead its own session. */
function assertDetached(pid: number): void {
	const st = procStat(pid);
	assert.ok(st, `no process ${pid} for the host`);
	assert.notEqual(st.ppid, process.pid, "host's parent is the extension host");
	const chain = ancestors(pid);
	assert.ok(!chain.includes(process.pid), `extension host ${process.pid} is an ancestor of host ${pid}: ${chain.join(" → ")}`);
	assert.ok(st.sessionLeader, "host is not a session leader (not setsid'd)");
}

function fakeArgvs(): string[][] {
	return fs
		.readFileSync(fakeLog, "utf8")
		.split("\n")
		.filter(Boolean)
		.map(l => JSON.parse(l) as { kind: string; argv?: string[] })
		.filter(e => e.kind === "argv")
		.map(e => e.argv ?? []);
}

/** Runs `omp.tasks.add` with the input box answered by `text`; returns the options it was shown with. */
async function addTask(arg: unknown, text: string): Promise<vscode.InputBoxOptions | undefined> {
	const win = vscode.window as unknown as Record<string, unknown>;
	const original = win.showInputBox;
	let asked: vscode.InputBoxOptions | undefined;
	win.showInputBox = async (options?: vscode.InputBoxOptions) => {
		asked = options;
		return text;
	};
	try {
		await vscode.commands.executeCommand("omp.tasks.add", arg);
	} finally {
		win.showInputBox = original;
	}
	return asked;
}

/** "title:status" per task, in queue order. */
function queueState(id: string): string | undefined {
	return readQueue(id)
		?.tasks.map(t => `${t.title}:${t.status}`)
		.join(",");
}

function clientHellos(id: string): number {
	return fs.readFileSync(path.join(sessionDir(id), "host.log"), "utf8").match(/client hello \d+ vscode:/g)?.length ?? 0;
}

describe("omp Sessions — local desktop extension host", () => {
	let id = "";
	let hostPid = 0;
	let ompPid = 0;

	before(async function () {
		const ext = vscode.extensions.getExtension(EXTENSION_ID);
		assert.ok(ext, `${EXTENSION_ID} not loaded`);
		await ext.activate();
	});

	it("activates in a local Electron extension host", () => {
		const ext = vscode.extensions.getExtension(EXTENSION_ID);
		assert.ok(ext?.isActive);
		assert.equal(vscode.env.remoteName, undefined, "expected a local (non-remote) window");
		// Local window: extensions run where the UI runs, regardless of the manifest's "workspace" kind.
		assert.equal(ext.extensionKind, vscode.ExtensionKind.UI);
		assert.ok(process.versions.electron, "extension host is not Electron");
		assert.equal(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, workspace);
		assert.ok(vscode.workspace.getConfiguration("omp").get<string>("path")?.endsWith("fake-omp.mjs"));
	});

	it("registers every contributed command", async () => {
		const ext = vscode.extensions.getExtension(EXTENSION_ID);
		const contributed = (ext?.packageJSON.contributes.commands as { command: string }[]).map(c => c.command);
		for (const c of [
			"omp.newSession",
			"omp.openSession",
			"omp.stopSession",
			"omp.resumeSession",
			"omp.reviewChanges",
			"omp.addToChat",
			"omp.revertFile",
			"omp.openInSidebar",
			"omp.scm.review",
			"omp.tasks.add",
			"omp.tasks.start",
			"omp.tasks.pause",
			"omp.tasks.markDone",
			"omp.tasks.markPending",
			"omp.tasks.skip",
			"omp.tasks.moveUp",
			"omp.tasks.moveDown",
			"omp.tasks.delete",
		]) {
			assert.ok(contributed.includes(c), `${c} not contributed`);
		}
		const registered = new Set(await vscode.commands.getCommands(true));
		const missing = contributed.filter(c => !registered.has(c));
		assert.deepEqual(missing, [], `contributed but not registered: ${missing.join(", ")}`);
	});

	it("omp.newSession starts a double-forked host that reaches idle", async function () {
		this.timeout(40_000);
		const before = new Set(sessionIds());
		await vscode.commands.executeCommand("omp.newSession", workspace);
		id = await waitFor("new session dir", () => sessionIds().find(s => !before.has(s)), 20_000);
		await waitFor("new session: meta idle", () => readMeta(id)?.status === "idle");
		const meta = readMeta(id);
		assert.ok(meta);
		assert.equal(meta.cwd, workspace);
		// sun_path holds ~104 bytes: a deep state dir (macOS's /var/folders/… temp) uses a short tmp path.
		const preferred = path.join(sessionDir(id), "s.sock");
		assert.equal(meta.socket, Buffer.byteLength(preferred) < 100 ? preferred : path.join(os.tmpdir(), `ompv-${process.getuid?.() ?? "u"}`, `${id}.sock`));
		assert.ok(fs.existsSync(meta.socket), "socket missing");
		hostPid = meta.pid;
		ompPid = meta.ompPid ?? 0;
		assert.ok(pidAlive(hostPid), `host ${hostPid} not alive`);
		assert.ok(pidAlive(ompPid), `omp ${ompPid} not alive`);
		assertDetached(hostPid);
		assert.equal(procStat(ompPid)?.ppid, hostPid, "omp is not a child of the session host");
		const argv = fakeArgvs().at(-1) ?? [];
		assert.deepEqual(argv.slice(0, 4), ["--mode", "rpc-ui", "--cwd", workspace]);
		await waitFor(
			"chat panel tab",
			() => vscode.window.tabGroups.all.some(g => g.tabs.some(t => t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith("omp.chat"))),
			10_000,
		);
	});

	it("runs a prompt over the socket and records the file change", async function () {
		this.timeout(40_000);
		const meta = readMeta(id);
		assert.ok(meta);
		const { client, snapshot } = await HostClient.connect(meta.socket, "e2e-desktop");
		try {
			assert.equal(snapshot.meta.id, id);
			assert.equal(snapshot.meta.status, "idle");
			client.send({ t: "rpc", cmd: { id: "p1", type: "prompt", message: "write hello.txt hi" } });
			const change = await client.next("change broadcast", m => m.t === "change");
			assert.equal(change.t === "change" && change.change.files[0]?.path, helloFile);
			await waitFor("hello.txt written", () => fs.existsSync(helloFile) && fs.readFileSync(helloFile, "utf8") === "hi\n");
			await client.next("idle meta", m => m.t === "meta" && m.meta.status === "idle");

			client.send({ t: "rpc", cmd: { id: "p2", type: "prompt", message: "edit existing.txt original => changed" } });
			await waitFor("existing.txt edited", () => fs.readFileSync(existingFile, "utf8") === "changed line\n");
			await client.next("idle meta after edit", m => m.t === "meta" && m.meta.status === "idle");
		} finally {
			client.close();
		}

		const changes = await waitFor("two changes.jsonl entries", () => {
			const c = readChanges(id);
			return c.length >= 2 ? c : undefined;
		});
		const created = changes.find(c => c.files.some(f => f.path === helloFile));
		assert.ok(created, "no change entry for hello.txt");
		assert.equal(created.toolName, "write");
		assert.deepEqual(
			created.files.map(f => ({ path: f.path, op: f.op, before: f.before })),
			[{ path: helloFile, op: "create", before: null }],
		);
		assert.ok(created.files[0].after && fs.existsSync(path.join(sessionDir(id), "blobs", created.files[0].after)), "after blob missing");
		const edited = changes.find(c => c.files.some(f => f.path === existingFile));
		assert.ok(edited, "no change entry for existing.txt");
		assert.equal(edited.files[0].op, "update");
		const beforeBlob = edited.files[0].before;
		assert.ok(beforeBlob);
		assert.equal(fs.readFileSync(path.join(sessionDir(id), "blobs", beforeBlob), "utf8"), "original line\n");
		await waitFor("meta.changedFiles == 2 and title from first prompt", () => {
			const m = readMeta(id);
			return m?.changedFiles === 2 && m.title === "write hello.txt hi";
		});
	});

	it("omp.openSessionFileDiff and omp.reviewChanges open diff editors", async () => {
		await vscode.commands.executeCommand("omp.openSessionFileDiff", id, existingFile);
		await waitFor("text diff tab for existing.txt", () =>
			vscode.window.tabGroups.all.some(g => g.tabs.some(t => t.input instanceof vscode.TabInputTextDiff && t.input.modified.fsPath === existingFile)),
		);
		await vscode.commands.executeCommand("omp.reviewChanges", id);
		await waitFor("multi-file review tab", () => vscode.window.tabGroups.all.some(g => g.tabs.some(t => /2 files changed/.test(t.label))), 10_000);
	});

	it("omp.revertFile restores the pre-session content (modal stubbed)", async () => {
		// The test bundle lives inside the extension under development, so `vscode` here is the
		// same API object the extension uses and its modal can be answered in-process.
		const win = vscode.window as unknown as Record<string, unknown>;
		const original = { warn: win.showWarningMessage, error: win.showErrorMessage };
		const prompts: { message: string; options: unknown; items: unknown[] }[] = [];
		const errors: string[] = [];
		win.showWarningMessage = async (message: string, options: unknown, ...items: unknown[]) => {
			prompts.push({ message, options, items });
			return items[0];
		};
		win.showErrorMessage = async (message: string) => {
			errors.push(message);
			return undefined;
		};
		try {
			await vscode.commands.executeCommand("omp.revertFile", id, existingFile);
			assert.deepEqual(errors, []);
			assert.equal(prompts.length, 1, "revert did not ask for confirmation through window.showWarningMessage");
			assert.deepEqual(prompts[0].options, { modal: true, detail: "Unsaved and later edits to this file are lost." });
			assert.deepEqual(prompts[0].items, ["Revert"]);
			assert.equal(fs.readFileSync(existingFile, "utf8"), "original line\n");

			await vscode.commands.executeCommand("omp.revertFile", id, helloFile);
			assert.deepEqual(errors, []);
			assert.equal(prompts.length, 2);
			assert.deepEqual(prompts[1].items, ["Delete File"]);
			assert.ok(!fs.existsSync(helloFile), "created file was not deleted on revert");
		} finally {
			win.showWarningMessage = original.warn;
			win.showErrorMessage = original.error;
		}
	});

	it("omp.stopSession stops the host; omp.resumeSession restarts it with the same id", async function () {
		this.timeout(60_000);
		const transcript = readMeta(id)?.ompSessionFile;
		assert.ok(transcript, "meta has no ompSessionFile to resume");
		await vscode.commands.executeCommand("omp.stopSession", id);
		const stopped = await waitFor("meta stopped", () => {
			const m = readMeta(id);
			return m?.status === "stopped" ? m : undefined;
		});
		assert.equal(stopped.exitReason, "stopped");
		await waitFor("host exited", () => !pidAlive(hostPid), 15_000);
		await waitFor("omp exited", () => !pidAlive(ompPid), 15_000);
		await waitFor("socket removed", () => !fs.existsSync(stopped.socket), 5_000);
		const hostLog = path.join(sessionDir(id), "host.log");
		const panelHellos = () => fs.readFileSync(hostLog, "utf8").match(/client hello \d+ vscode:/g)?.length ?? 0;
		const hellosBefore = panelHellos();

		await vscode.commands.executeCommand("omp.resumeSession", id);
		await waitFor("resumed session: meta idle", () => readMeta(id)?.status === "idle");
		const resumed = readMeta(id);
		assert.ok(resumed);
		assert.equal(resumed.id, id);
		assert.equal(resumed.createdAt, stopped.createdAt);
		assert.notEqual(resumed.pid, hostPid, "same host pid after resume");
		hostPid = resumed.pid;
		ompPid = resumed.ompPid ?? 0;
		assert.ok(pidAlive(hostPid) && pidAlive(ompPid));
		assertDetached(hostPid);
		const argv = fakeArgvs().at(-1) ?? [];
		assert.equal(argv[argv.indexOf("--resume") + 1], transcript, `resume did not pass the transcript: ${argv.join(" ")}`);

		const { client, snapshot } = await HostClient.connect(resumed.socket, "e2e-desktop");
		client.close();
		assert.ok(JSON.stringify(snapshot.messages).includes("write hello.txt hi"), "resumed transcript lost earlier prompts");
		assert.equal(snapshot.changes.length, readChanges(id).length, "resumed host did not reload changes.jsonl");
		await waitFor("open chat panel reattached to the resumed host", () => panelHellos() > hellosBefore, 10_000);
		await vscode.commands.executeCommand("omp.resumeSession", id);
		assert.equal(readMeta(id)?.pid, hostPid, "resuming a running session replaced its host");
		assert.equal(sessionIds().filter(s => readMeta(s)?.status !== "stopped").length, 1);
	});

	it("omp.tasks.add/start/pause: the host runs queued tasks in order, also after a stopped session is edited on disk", async function () {
		this.timeout(120_000);
		const queueFile = path.join(sessionDir(id), "queue.json");
		assert.equal(readQueue(id)?.tasks.length ?? 0, 0, "fresh session already has queued tasks");
		const asked = await addTask(id, "echo one :: a; b");
		assert.equal(asked?.title, "New task", "omp.tasks.add did not ask through window.showInputBox");
		await waitFor("first task in queue.json", () => readQueue(id)?.tasks.length === 1);
		await addTask(id, "echo two");
		const queued = await waitFor("two tasks in queue.json", () => {
			const q = readQueue(id);
			return q?.tasks.length === 2 ? q : undefined;
		});
		assert.deepEqual(
			queued.tasks.map(t => [t.title, t.status, t.subtasks.map(s => [s.title, s.done])]),
			[
				["echo one", "pending", [["a", false], ["b", false]]],
				["echo two", "pending", []],
			],
		);
		assert.equal(queued.autoRun, false, "a new queue must not auto-run");
		await sleep(1000); // negative check: the host's dispatch timer (400 ms) must not fire a paused queue
		assert.equal(queueState(id), "echo one:pending,echo two:pending", "tasks ran before omp.tasks.start");

		await vscode.commands.executeCommand("omp.tasks.start", id);
		const done = await waitFor(
			"both tasks done",
			() => {
				const q = readQueue(id);
				return q?.tasks.length === 2 && q.tasks.every(t => t.status === "done") ? q : undefined;
			},
			30_000,
		);
		const [one, two] = done.tasks;
		assert.ok(one.startedAt && one.finishedAt && two.startedAt && two.finishedAt, "missing start/finish timestamps");
		assert.ok(one.finishedAt <= two.startedAt, "second task started before the first finished");
		assert.deepEqual(
			one.subtasks.map(s => s.done),
			[true, true],
		);
		assert.equal(one.summary, "one");
		assert.equal(two.summary, "two");
		await waitFor("meta.queue summary 2/2 auto-run, idle", () => {
			const m = readMeta(id);
			return m?.status === "idle" && JSON.stringify(m.queue) === JSON.stringify({ pending: 0, running: 0, done: 2, total: 2, autoRun: true });
		});
		{
			const { client, snapshot } = await HostClient.connect(readMeta(id)?.socket ?? "", "e2e-desktop");
			client.close();
			const texts = JSON.stringify(snapshot.messages);
			assert.ok(texts.indexOf("[Task 1/2 from the queue] echo one") >= 0, "omp never got task 1");
			assert.ok(texts.indexOf("[Task 2/2 from the queue] echo two") > texts.indexOf("[Task 1/2 from the queue] echo one"), "task 2 not sent after task 1");
		}

		await vscode.commands.executeCommand("omp.tasks.pause", id);
		await waitFor("paused: autoRun off in queue.json and meta", () => readQueue(id)?.autoRun === false && readMeta(id)?.queue?.autoRun === false);

		// Stopped session: the extension edits queue.json (and meta.queue) itself.
		await vscode.commands.executeCommand("omp.stopSession", id);
		await waitFor("meta stopped", () => readMeta(id)?.status === "stopped");
		await waitFor("host exited", () => !pidAlive(hostPid) && hostPids(id).length === 0, 15_000);
		await vscode.commands.executeCommand("omp.refresh");
		const rawBefore = fs.readFileSync(queueFile, "utf8");
		await addTask(id, "echo three");
		assert.notEqual(fs.readFileSync(queueFile, "utf8"), rawBefore, "queue.json of the stopped session unchanged");
		assert.equal(queueState(id), "echo one:done,echo two:done,echo three:pending");
		const stoppedMeta = readMeta(id);
		assert.equal(stoppedMeta?.status, "stopped");
		assert.deepEqual(stoppedMeta?.queue, { pending: 1, running: 0, done: 2, total: 3, autoRun: false });
		assert.deepEqual(hostPids(id), [], "editing a stopped queue launched a host");

		await vscode.commands.executeCommand("omp.tasks.start", id);
		const resumed = await waitFor("omp.tasks.start resumed the session", () => {
			const m = readMeta(id);
			return m && m.status !== "stopped" && m.pid !== hostPid && pidAlive(m.pid) ? m : undefined;
		});
		hostPid = resumed.pid;
		ompPid = resumed.ompPid ?? 0;
		assertDetached(hostPid);
		const resumedQueue = await waitFor(
			"third task done after resume",
			() => {
				const q = readQueue(id);
				return q?.tasks[2]?.status === "done" ? q : undefined;
			},
			30_000,
		);
		assert.equal(queueState(id), "echo one:done,echo two:done,echo three:done");
		assert.ok((resumedQueue.tasks[2].startedAt ?? 0) > (two.finishedAt ?? Infinity), "task 3 did not run after the resume");
		assert.equal(resumedQueue.tasks[2].summary, "three");
		await waitFor("meta.queue summary 3/3, idle", () => {
			const m = readMeta(id);
			return m?.status === "idle" && JSON.stringify(m.queue) === JSON.stringify({ pending: 0, running: 0, done: 3, total: 3, autoRun: true });
		});
		ompPid = readMeta(id)?.ompPid ?? 0;
	});

	it("omp.tasks.markDone/markPending/skip/moveUp/moveDown/delete edit the queue through task nodes", async function () {
		this.timeout(40_000);
		await vscode.commands.executeCommand("omp.tasks.pause", id);
		await waitFor("autoRun off", () => readQueue(id)?.autoRun === false);
		const node = (index: number) => {
			const task = readQueue(id)?.tasks[index];
			assert.ok(task, `no task at ${index}`);
			return { kind: "task", sessionId: id, task, index };
		};
		const run = async (command: string, index: number, expect: string) => {
			await vscode.commands.executeCommand(command, node(index));
			await waitFor(`${command}(${index}) → ${expect}`, () => queueState(id) === expect, 10_000);
		};
		assert.equal(queueState(id), "echo one:done,echo two:done,echo three:done");

		await run("omp.tasks.markPending", 0, "echo one:pending,echo two:done,echo three:done");
		const reopened = readQueue(id)?.tasks[0];
		assert.deepEqual([reopened?.startedAt, reopened?.finishedAt, reopened?.summary], [undefined, undefined, undefined]);
		await sleep(1500); // negative check: no dispatch (400–800 ms timer) while paused
		assert.equal(readQueue(id)?.tasks[0].status, "pending", "paused queue re-ran a task marked pending");
		assert.equal(readMeta(id)?.status, "idle");

		await run("omp.tasks.skip", 0, "echo one:skipped,echo two:done,echo three:done");
		await run("omp.tasks.markDone", 0, "echo one:done,echo two:done,echo three:done");
		assert.ok(readQueue(id)?.tasks[0].subtasks.every(s => s.done));
		await run("omp.tasks.moveDown", 0, "echo two:done,echo one:done,echo three:done");
		await run("omp.tasks.moveUp", 2, "echo two:done,echo three:done,echo one:done");
		await run("omp.tasks.delete", 0, "echo three:done,echo one:done");
		await waitFor("meta.queue after edits", () => JSON.stringify(readMeta(id)?.queue) === JSON.stringify({ pending: 0, running: 0, done: 2, total: 2, autoRun: false }));
	});

	it("omp.openInSidebar resolves omp.chatView and attaches it as a second client", async function () {
		this.timeout(30_000);
		await waitFor("editor chat attached to the current host", () => clientHellos(id) > 0);
		const before = clientHellos(id);
		const uncaught: string[] = [];
		const onUncaught = (err: Error) => uncaught.push(err.message);
		process.on("uncaughtException", onUncaught);
		try {
			await vscode.commands.executeCommand("omp.openInSidebar", id);
			await vscode.commands.executeCommand("omp.chatView.focus");
			await waitFor("side bar chat hello in host.log", () => clientHellos(id) > before, 15_000);
			assert.deepEqual(uncaught, []);
		} finally {
			process.off("uncaughtException", onUncaught);
		}
	});

	it("omp.scm.review sends the review prompt to the repository's session", async function () {
		this.timeout(30_000);
		assert.ok(fs.existsSync(path.join(workspace, ".git")), "workspace is not a git repository");
		const info: string[] = [];
		const win = vscode.window as unknown as Record<string, unknown>;
		const original = win.showInformationMessage;
		win.showInformationMessage = async (message: string) => {
			info.push(message);
			return undefined;
		};
		const meta = readMeta(id);
		assert.ok(meta);
		const { client } = await HostClient.connect(meta.socket, "e2e-desktop");
		try {
			await vscode.commands.executeCommand("omp.scm.review", { rootUri: vscode.Uri.file(workspace) });
			assert.deepEqual(info, []);
			await client.next("working meta", m => m.t === "meta" && m.meta.status === "working");
			await client.next("idle meta", m => m.t === "meta" && m.meta.status === "idle");
		} finally {
			client.close();
			win.showInformationMessage = original;
		}
		const { client: c2, snapshot } = await HostClient.connect(meta.socket, "e2e-desktop");
		c2.close();
		assert.ok(JSON.stringify(snapshot.messages).includes("Review the uncommitted changes in this repository"), "review prompt not in the transcript");
	});

	it("a second host for a running session refuses to start", async function () {
		this.timeout(30_000);
		assert.deepEqual(hostPids(id), [hostPid]);
		await vscode.commands.executeCommand("omp.resumeSession", id);
		await sleep(1000); // negative check: a (daemonized) second host would appear within this window
		assert.deepEqual(hostPids(id), [hostPid], "omp.resumeSession on a running session started another host");

		// Bypass the extension's guard, as a second window racing to resume would.
		const ext = vscode.extensions.getExtension(EXTENSION_ID);
		assert.ok(ext);
		const omp = vscode.workspace.getConfiguration("omp").get<string>("path") ?? "";
		const dup = spawn(process.execPath, [path.join(ext.extensionPath, "out", "host.js"), "--id", id, "--cwd", workspace, "--omp", omp], {
			stdio: "ignore",
			env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
		});
		// Watchdog only: a refusing host exits at once; a second real host would never exit.
		const watchdog = setTimeout(() => dup.kill("SIGKILL"), 10_000);
		const [code] = (await once(dup, "exit")) as [number | null];
		clearTimeout(watchdog);
		assert.equal(code, 0, "duplicate host did not exit cleanly");
		assert.deepEqual(hostPids(id), [hostPid], "two hosts for one session");
		assert.match(fs.readFileSync(path.join(sessionDir(id), "host.log"), "utf8"), new RegExp(`another host is already running for this session: ${hostPid}`));
		const meta = readMeta(id);
		assert.equal(meta?.pid, hostPid, "duplicate host overwrote meta.json");
		assert.notEqual(meta?.status, "stopped");
		assert.ok(pidAlive(ompPid), "duplicate host disturbed omp");
		const { client } = await HostClient.connect(meta?.socket ?? "", "e2e-desktop");
		client.close();
	});

	it("a chat panel whose host socket is missing does not throw in the extension host", async function () {
		this.timeout(20_000);
		// A live-looking session (pid = this process) without a socket, like the window between a
		// resumed host writing meta.json ("starting") and listening: the panel's reconnect loop
		// must treat ENOENT as "not up yet" instead of raising an uncaught exception.
		const ghost = `e2eghost${Date.now().toString(36)}`;
		const dir = sessionDir(ghost);
		const metaFile = path.join(dir, "meta.json");
		fs.mkdirSync(dir, { recursive: true });
		const meta: SessionMeta = { id: ghost, cwd: workspace, title: "ghost", status: "idle", pid: process.pid, socket: path.join(dir, "s.sock"), createdAt: Date.now(), updatedAt: Date.now(), changedFiles: 0 };
		fs.writeFileSync(metaFile, JSON.stringify(meta));
		const uncaught: string[] = [];
		const onUncaught = (err: Error) => uncaught.push(err.message);
		process.on("uncaughtException", onUncaught);
		try {
			await vscode.commands.executeCommand("omp.refresh");
			await vscode.commands.executeCommand("omp.openSession", ghost);
			await sleep(1500); // the panel retries after ~250 and ~750 ms
			assert.deepEqual(uncaught, [], "src/ext/client.ts: readline re-emits the socket's connect error with no listener");
		} finally {
			process.off("uncaughtException", onUncaught);
			fs.writeFileSync(metaFile, JSON.stringify({ ...meta, status: "stopped", updatedAt: Date.now() }));
			await vscode.commands.executeCommand("omp.refresh");
			const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs).filter(t => t.input instanceof vscode.TabInputWebview && t.label === "ghost");
			await vscode.window.tabGroups.close(tabs);
			fs.rmSync(dir, { recursive: true, force: true });
			await vscode.commands.executeCommand("omp.refresh");
		}
	});

	after(() => {
		// The runner checks, after VS Code exits, that this host is still alive, then stops it.
		if (id && pidAlive(hostPid)) {
			const meta = readMeta(id);
			fs.writeFileSync(stateFile, JSON.stringify({ id, pid: hostPid, ompPid, socket: meta?.socket }));
		}
	});
});
