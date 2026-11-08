// Resuming a session whose omp transcript `omp gc` archived (or that vanished).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import * as zlib from "node:zlib";
import { alive, isRecord, launch, tempDir, textOf, until } from "./harness";

test("resume restores an archived transcript; a vanished one starts fresh with a warning", async t => {
	// omp's layout: <agent>/sessions/<slug>/<file>.jsonl, archived to <agent>/archive/sessions/<slug>/<file>.jsonl.gz.
	const agent = tempDir(t, "omp-agent-");
	const slug = "--work--";
	const h = await launch(t, { env: { FAKE_OMP_SESSIONS: path.join(agent, "sessions", slug) } });
	const { client: c } = await h.connect();
	await c.prompt("echo keep this");
	const before = await until(() => {
		const m = h.meta();
		return m.lastText === "keep this" && m.ompSessionFile ? m : undefined;
	}, "meta.json flush");
	const file = before.ompSessionFile ?? "";
	const stop = async () => {
		const pid = h.meta().pid;
		const ompPid = h.meta().ompPid;
		const { client } = await h.connect("stopper");
		client.send({ t: "stop" });
		await until(() => !alive(pid) && !alive(ompPid), "host and omp exit");
	};
	await stop();

	const archived = path.join(agent, "archive", "sessions", slug, `${path.basename(file)}.gz`);
	fs.mkdirSync(path.dirname(archived), { recursive: true });
	fs.writeFileSync(archived, zlib.gzipSync(fs.readFileSync(file)));
	fs.unlinkSync(file);

	await h.start();
	const { snapshot } = await h.connect("after-gc");
	assert.ok(fs.existsSync(file) && !fs.existsSync(archived), "transcript restored to where omp wrote it");
	const argvs = h.fakeEntries().flatMap(e => (e.kind === "argv" && e.argv ? [e.argv] : []));
	assert.equal(argvs[1][argvs[1].indexOf("--resume") + 1], file);
	assert.equal(snapshot.meta.ompSessionFile, file);
	const texts = snapshot.messages.map(m => (isRecord(m) && m.role === "notice" ? `notice: ${String(m.message)}` : textOf(m)));
	assert.ok(texts.includes("keep this"), texts.join(" | "));
	assert.ok(texts.some(x => x.startsWith("notice: Restored the omp transcript from omp's archive")), texts.join(" | "));

	await stop();
	fs.unlinkSync(file);
	await h.start();
	const { snapshot: fresh } = await h.connect("after-delete");
	const last = h.fakeEntries().flatMap(e => (e.kind === "argv" && e.argv ? [e.argv] : []))[2];
	assert.ok(!last.includes("--resume"), last.join(" "));
	assert.notEqual(fresh.meta.ompSessionFile, file);
	assert.deepEqual(fresh.meta.ompSessionFiles, [file]);
	assert.ok(fresh.messages.some(m => isRecord(m) && m.role === "notice" && m.level === "warning" && String(m.message).includes("This is a new conversation")));
});
