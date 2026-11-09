// Installs AO's UI for src/ao/dashboard.ts: the renderer of AO's desktop app (`.vite/renderer/main_window/` in
// its `app.asar`), taken from AO's official Linux release (`agent-orchestrator-linux-x64.deb`: an ar archive
// whose `data.tar.zst` holds `usr/lib/agent-orchestrator/resources/app.asar`) or from a local `.deb`, `app.asar`
// or renderer folder (a build of AO's `frontend/`). The renderer is plain web files on every platform, so the
// Linux package serves any machine. Everything is parsed here (ar, tar, asar); only zstd needs Node 22.15+
// (`zlib.createZstdDecompress`) or a `zstd` binary.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Readable, Transform, type TransformCallback, Writable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import * as zlib from "node:zlib";
import { type DashboardInstall, bridgeChunk, dashboardDir, readDashboardInstall, rendererDir } from "./dashboard";
import { refuseRealStateInTests, switchyardHome } from "./native";

export const AO_RELEASES = "https://github.com/OrchestratorInc/agent-orchestrator/releases";
const DEB_ASSET = "agent-orchestrator-linux-x64.deb";
/** Where the renderer sits inside AO's app.asar (electron-forge's Vite plugin, window `main_window`). */
const ASAR_RENDERER = ".vite/renderer/main_window";

/** The download URL of AO's Linux package for `tag` (`latest`, `v0.14.10` or `0.14.10`). */
export function releaseUrl(tag = "latest"): string {
	if (tag === "latest") return `${AO_RELEASES}/latest/download/${DEB_ASSET}`;
	if (!/^v?\d+\.\d+\.\d+[\w.-]*$/.test(tag)) throw new Error(`not a release tag: ${tag} (e.g. v0.14.10, or latest)`);
	return `${AO_RELEASES}/download/${tag.startsWith("v") ? tag : `v${tag}`}/${DEB_ASSET}`;
}

// ---------- ar (.deb) ----------

export interface ArMember {
	name: string;
	offset: number;
	size: number;
}

/** The members of an ar archive (a .deb): name, data offset and size. */
export function arMembers(file: string): ArMember[] {
	const fd = fs.openSync(file, "r");
	try {
		const total = fs.fstatSync(fd).size;
		const magic = Buffer.alloc(8);
		fs.readSync(fd, magic, 0, 8, 0);
		if (magic.toString("latin1") !== "!<arch>\n") throw new Error(`${file} is not a .deb (ar) archive`);
		const out: ArMember[] = [];
		const header = Buffer.alloc(60);
		let at = 8;
		while (at + 60 <= total) {
			fs.readSync(fd, header, 0, 60, at);
			const name = header.toString("latin1", 0, 16).trim().replace(/\/$/, "");
			const size = Number.parseInt(header.toString("latin1", 48, 58).trim(), 10);
			if (!Number.isFinite(size) || header.toString("latin1", 58, 60) !== "`\n") throw new Error(`${file}: bad ar member header at ${at}`);
			out.push({ name, offset: at + 60, size });
			at += 60 + size + (size % 2);
		}
		return out;
	} finally {
		fs.closeSync(fd);
	}
}

function decompressor(name: string): NodeJS.ReadWriteStream {
	if (name.endsWith(".gz")) return zlib.createGunzip();
	if (name.endsWith(".zst")) {
		if (typeof zlib.createZstdDecompress === "function") return zlib.createZstdDecompress();
		return external("zstd", name);
	}
	if (name.endsWith(".xz")) return external("xz", name);
	if (name.endsWith(".tar")) return new Transform({ transform: (chunk, _enc, done) => done(null, chunk) });
	throw new Error(`unsupported .deb payload ${name}`);
}

/** `<tool> -dc` as a stream (no zstd in this Node, or an xz payload). */
function external(tool: string, name: string): NodeJS.ReadWriteStream {
	const child = spawn(tool, ["-dc"], { stdio: ["pipe", "pipe", "inherit"] });
	const stream = new Transform({
		transform(chunk: Buffer, _enc, done: TransformCallback) {
			if (child.stdin.write(chunk)) done();
			else child.stdin.once("drain", done);
		},
		flush(done: TransformCallback) {
			child.stdin.end();
			child.stdout.once("end", () => done());
		},
	});
	child.stdout.on("data", (chunk: Buffer) => stream.push(chunk));
	child.on("error", err => stream.destroy(new Error(`${name} needs ${tool} (${err.message}); or run with Node 22.15+, or pass --from <app.asar>`)));
	return stream;
}

// ---------- tar ----------

/**
 * A tar stream reader that copies the one entry `wanted(name)` accepts into `dest`, skipping the rest
 * (ustar names with prefix, GNU long names, pax `path`). Resolves with the entry name, or undefined.
 */
class TarExtract extends Writable {
	private buf: Buffer = Buffer.alloc(0);
	private remaining = 0;
	private padding = 0;
	private out: fs.WriteStream | undefined;
	private longName: string | undefined;
	private meta: "L" | "x" | undefined;
	private metaChunks: Buffer[] = [];
	found: string | undefined;
	/** Settles once the found entry is flushed to `dest`. */
	private written: Promise<void> = Promise.resolve();

	constructor(private readonly wanted: (name: string) => boolean, private readonly dest: string) {
		super();
	}

	override _write(chunk: Buffer, _enc: BufferEncoding, done: (err?: Error | null) => void): void {
		this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
		this.drain(done);
	}

	private drain(done: (err?: Error | null) => void): void {
		while (this.buf.length) {
			if (this.remaining > 0) {
				const take = Math.min(this.remaining, this.buf.length);
				const piece = this.buf.subarray(0, take);
				this.buf = this.buf.subarray(take);
				this.remaining -= take;
				if (this.meta) this.metaChunks.push(Buffer.from(piece));
				else if (this.out && !this.out.write(piece)) {
					const end = this.remaining === 0;
					this.out.once("drain", () => {
						if (end) this.endEntry();
						this.drain(done);
					});
					return;
				}
				if (this.remaining === 0) this.endEntry();
				continue;
			}
			if (this.padding > 0) {
				const take = Math.min(this.padding, this.buf.length);
				this.buf = this.buf.subarray(take);
				this.padding -= take;
				continue;
			}
			if (this.buf.length < 512) break;
			const header = this.buf.subarray(0, 512);
			this.buf = this.buf.subarray(512);
			if (header.every(b => b === 0)) continue;
			const field = (from: number, len: number) => header.toString("utf8", from, from + len).replace(/\0.*$/s, "");
			const size = Number.parseInt(field(124, 12).trim() || "0", 8);
			const type = String.fromCharCode(header[156] || 48);
			const prefix = header.toString("latin1", 257, 263).startsWith("ustar") ? field(345, 155) : "";
			const name = this.longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
			this.longName = undefined;
			this.remaining = size;
			this.padding = (512 - (size % 512)) % 512;
			if (type === "L" || type === "x") {
				this.meta = type;
				this.metaChunks = [];
			} else if ((type === "0" || type === "\0") && !this.found && this.wanted(name)) {
				this.found = name;
				this.out = fs.createWriteStream(this.dest);
				const { promise, resolve, reject } = Promise.withResolvers<void>();
				this.out.once("close", () => resolve());
				this.out.once("error", reject);
				this.written = promise;
			}
			if (size === 0) this.endEntry();
		}
		done();
	}

	private endEntry(): void {
		if (this.meta) {
			const text = Buffer.concat(this.metaChunks).toString("utf8");
			if (this.meta === "L") this.longName = text.replace(/\0.*$/s, "");
			else {
				const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(text);
				if (m) this.longName = m[1];
			}
			this.meta = undefined;
			return;
		}
		if (this.out) {
			this.out.end();
			this.out = undefined;
		}
	}

	override _final(done: (err?: Error | null) => void): void {
		// A truncated archive leaves the entry open.
		this.out?.end();
		this.written.then(() => done(), done);
	}
}

/** Copies `resources/app.asar` out of AO's .deb into `dest`. */
export async function asarFromDeb(deb: string, dest: string): Promise<void> {
	const data = arMembers(deb).find(m => m.name.startsWith("data.tar"));
	if (!data) throw new Error(`${deb} has no data.tar member`);
	const tar = new TarExtract(name => name.replace(/^\.?\//, "").endsWith("resources/app.asar"), dest);
	await pipeline(fs.createReadStream(deb, { start: data.offset, end: data.offset + data.size - 1 }), decompressor(data.name), tar);
	if (!tar.found) throw new Error(`${deb} has no resources/app.asar: not AO's desktop package`);
}

// ---------- asar ----------

interface AsarNode {
	files?: Record<string, AsarNode>;
	size?: number;
	offset?: string;
	unpacked?: boolean;
}

/** The header of an Electron asar archive and where file data starts. */
export function readAsarHeader(file: string): { root: AsarNode; dataStart: number } {
	const fd = fs.openSync(file, "r");
	try {
		const head = Buffer.alloc(16);
		fs.readSync(fd, head, 0, 16, 0);
		// Chromium pickles: [4][header pickle size] then the header pickle: [payload size][string length][JSON].
		const headerSize = head.readUInt32LE(4);
		const jsonLength = head.readUInt32LE(12);
		const json = Buffer.alloc(jsonLength);
		fs.readSync(fd, json, 0, jsonLength, 16);
		const root: unknown = JSON.parse(json.toString("utf8"));
		if (!root || typeof root !== "object" || !("files" in root)) throw new Error("no file table");
		return { root: root as AsarNode, dataStart: 8 + headerSize };
	} catch (err) {
		throw new Error(`${file} is not an asar archive (${err instanceof Error ? err.message : String(err)})`);
	} finally {
		fs.closeSync(fd);
	}
}

function asarNode(root: AsarNode, at: string): AsarNode | undefined {
	let node: AsarNode | undefined = root;
	for (const part of at.split("/").filter(Boolean)) node = node?.files?.[part];
	return node;
}

function readAsarFile(fd: number, dataStart: number, node: AsarNode): Buffer {
	const buf = Buffer.alloc(node.size ?? 0);
	if (buf.length) fs.readSync(fd, buf, 0, buf.length, dataStart + Number(node.offset ?? 0));
	return buf;
}

/** Extracts AO's renderer from `asar` into `dest` (created); returns the app's version (its package.json), when it has one. */
export function rendererFromAsar(asar: string, dest: string): string | null {
	const { root, dataStart } = readAsarHeader(asar);
	const renderer = asarNode(root, ASAR_RENDERER);
	if (!renderer?.files) throw new Error(`${asar} has no ${ASAR_RENDERER}: not AO's desktop app`);
	const fd = fs.openSync(asar, "r");
	try {
		const walk = (node: AsarNode, dir: string) => {
			fs.mkdirSync(dir, { recursive: true });
			for (const [name, child] of Object.entries(node.files ?? {})) {
				if (name.includes("/") || name === ".." || name === ".") throw new Error(`${asar}: bad entry name ${name}`);
				const target = path.join(dir, name);
				if (child.files) walk(child, target);
				else if (child.unpacked) throw new Error(`${asar}: ${name} is unpacked (outside the archive); not supported`);
				else fs.writeFileSync(target, readAsarFile(fd, dataStart, child));
			}
		};
		walk(renderer, dest);
		const pkg = asarNode(root, "package.json");
		if (!pkg || pkg.files) return null;
		const parsed: unknown = JSON.parse(readAsarFile(fd, dataStart, pkg).toString("utf8"));
		return parsed && typeof parsed === "object" && "version" in parsed && typeof parsed.version === "string" ? parsed.version : null;
	} finally {
		fs.closeSync(fd);
	}
}

// ---------- install ----------

export interface InstallOptions {
	/** A release tag (`latest`, `v0.14.10`); the default when `from` is absent: latest. */
	release?: string;
	/** A local AO `.deb`, `app.asar`, renderer folder (holding index.html), or a folder holding one of them (an unpacked AO app or AO's `frontend/`). */
	from?: string;
	home?: string;
	log?: (line: string) => void;
	fetch?: typeof fetch;
}

/** What `from` names, as one of the inputs install understands. */
export function localSource(from: string): { kind: "deb" | "asar" | "renderer"; file: string } {
	const abs = path.resolve(from);
	const st = fs.statSync(abs);
	if (st.isFile()) return { kind: abs.endsWith(".deb") ? "deb" : "asar", file: abs };
	for (const [rel, kind] of [
		["index.html", "renderer"],
		[`${ASAR_RENDERER}/index.html`, "renderer"],
		["resources/app.asar", "asar"],
		["app.asar", "asar"],
		["usr/lib/agent-orchestrator/resources/app.asar", "asar"],
	] as const) {
		const file = path.join(abs, rel);
		if (fs.existsSync(file)) return { kind, file: kind === "renderer" ? path.dirname(file) : file };
	}
	throw new Error(`${from}: no AO renderer here (index.html), no app.asar and not a .deb`);
}

async function download(url: string, dest: string, doFetch: typeof fetch, log: (line: string) => void): Promise<void> {
	log(`downloading ${url}`);
	const response = await doFetch(url, { redirect: "follow" });
	if (!response.ok || !response.body) throw new Error(`download failed: HTTP ${response.status} for ${url}`);
	await pipeline(Readable.fromWeb(response.body as NodeReadableStream), fs.createWriteStream(dest));
}

/** Downloads or copies AO's UI into `<home>/ao-dashboard/renderer` (replacing what was there) and records it in install.json. */
export async function installDashboard(opts: InstallOptions = {}): Promise<DashboardInstall> {
	const home = opts.home ?? switchyardHome();
	refuseRealStateInTests(home);
	const log = opts.log ?? (() => {});
	const dir = dashboardDir(home);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const work = fs.mkdtempSync(path.join(dir, "install-"));
	try {
		const staged = path.join(work, "renderer");
		let version: string | null = null;
		let source: string;
		const fromAsar = (asar: string) => {
			log("extracting AO's UI");
			version = rendererFromAsar(asar, staged);
		};
		if (opts.from) {
			const local = localSource(opts.from);
			source = local.file;
			if (local.kind === "renderer") fs.cpSync(local.file, staged, { recursive: true });
			else if (local.kind === "asar") fromAsar(local.file);
			else {
				const asar = path.join(work, "app.asar");
				await asarFromDeb(local.file, asar);
				fromAsar(asar);
			}
		} else {
			source = releaseUrl(opts.release);
			const deb = path.join(work, DEB_ASSET);
			await download(source, deb, opts.fetch ?? globalThis.fetch, log);
			const asar = path.join(work, "app.asar");
			log("unpacking the package");
			await asarFromDeb(deb, asar);
			fromAsar(asar);
		}
		const index = fs.readFileSync(path.join(staged, "index.html"), "utf8");
		if (!bridgeChunk(index)) throw new Error("this AO build has no bridge-*.js chunk in its index.html: the dashboard shim cannot supply its daemon status (unsupported AO version)");
		const target = rendererDir(home);
		const old = path.join(work, "previous");
		if (fs.existsSync(target)) fs.renameSync(target, old);
		fs.renameSync(staged, target);
		const install: DashboardInstall = { version, source, installedAt: new Date().toISOString() };
		const record = path.join(dir, "install.json");
		fs.writeFileSync(`${record}.tmp`, `${JSON.stringify(install, null, 1)}\n`);
		fs.renameSync(`${record}.tmp`, record);
		return readDashboardInstall(home) ?? install;
	} finally {
		fs.rmSync(work, { recursive: true, force: true });
	}
}

/** Removes the installed UI; false when none was installed. */
export function uninstallDashboard(home = switchyardHome()): boolean {
	refuseRealStateInTests(home);
	const dir = dashboardDir(home);
	const had = fs.existsSync(rendererDir(home));
	fs.rmSync(rendererDir(home), { recursive: true, force: true });
	fs.rmSync(path.join(dir, "install.json"), { force: true });
	return had;
}
