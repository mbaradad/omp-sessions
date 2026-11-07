// Remote access to the omp-vs server over HTTP (the phone app and other clients): the config in
// `<root>/remote.json` (mode 0600; the server watches it and starts, stops or rebinds its HTTP
// listener live), the bearer token, bind address resolution and the pairing URL.
// Node-only; no vscode import. The HTTP API itself is src/server/remote.ts (docs/REMOTE-API.md).
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { stateRoot } from "./protocol";

/** `tailscale`: the machine's Tailscale IPv4; `lan`: all interfaces; `localhost`: 127.0.0.1; else one IP address. */
export type RemoteBind = "tailscale" | "lan" | "localhost" | (string & {});

export interface RemoteConfig {
	enabled: boolean;
	bind: RemoteBind;
	port: number;
	/** 32 random bytes, base64url; empty until remote access is first enabled. */
	token: string;
}

/** What the server's HTTP listener is doing (the `remote` server op). */
export interface RemoteStatus {
	enabled: boolean;
	bind: RemoteBind;
	port: number;
	/** Where the listener is bound right now. */
	listening?: { host: string; port: number };
	/** Base URL a phone opens (`http://<address>:<port>/`), while listening. */
	url?: string;
	/** Why it is not listening although enabled (no Tailscale address, port in use, …). */
	error?: string;
}

export const DEFAULT_REMOTE_PORT = 7413;
export const REMOTE_COOKIE = "omp_vs";

export function remoteConfigPath(): string {
	return path.join(stateRoot(), "remote.json");
}

export function isRemoteBind(value: unknown): value is RemoteBind {
	return value === "tailscale" || value === "lan" || value === "localhost" || (typeof value === "string" && net.isIP(value) !== 0);
}

/** 0 = any free port (tests); the status then reports the real one. */
function isPort(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 65536;
}

/** Parses remote.json text; anything missing or malformed falls back to the defaults (disabled). */
export function parseRemoteConfig(text: string | undefined): RemoteConfig {
	let raw: unknown;
	try {
		raw = text ? JSON.parse(text) : undefined;
	} catch {
		raw = undefined;
	}
	const r = raw && typeof raw === "object" && !Array.isArray(raw) ? new Map(Object.entries(raw)) : new Map<string, unknown>();
	const bind = r.get("bind");
	const port = r.get("port");
	const token = r.get("token");
	return {
		enabled: r.get("enabled") === true,
		bind: isRemoteBind(bind) ? bind : "tailscale",
		port: isPort(port) ? port : DEFAULT_REMOTE_PORT,
		token: typeof token === "string" ? token : "",
	};
}

export function readRemoteConfig(file = remoteConfigPath()): RemoteConfig {
	let text: string | undefined;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		text = undefined;
	}
	return parseRemoteConfig(text);
}

/** Atomic write, readable by this user only (the file holds the token). */
export function writeRemoteConfig(cfg: RemoteConfig, file = remoteConfigPath()): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, "\t")}\n`, { mode: 0o600 });
	fs.chmodSync(tmp, 0o600);
	fs.renameSync(tmp, file);
}

export function newRemoteToken(): string {
	return crypto.randomBytes(32).toString("base64url");
}

/** Merges `patch` into remote.json; enabling creates the token when there is none yet. */
export function updateRemoteConfig(patch: Partial<RemoteConfig>, file = remoteConfigPath()): RemoteConfig {
	const next: RemoteConfig = { ...readRemoteConfig(file), ...patch };
	if (next.enabled && !next.token) next.token = newRemoteToken();
	writeRemoteConfig(next, file);
	return next;
}

/** Constant-time token comparison (hashing first makes lengths equal). */
export function tokenMatches(given: string, token: string): boolean {
	if (!token || !given) return false;
	const a = crypto.createHash("sha256").update(given).digest();
	const b = crypto.createHash("sha256").update(token).digest();
	return crypto.timingSafeEqual(a, b);
}

type Interfaces = NodeJS.Dict<os.NetworkInterfaceInfo[]>;

function ipv4s(ifaces: Interfaces): string[] {
	const out: string[] = [];
	for (const list of Object.values(ifaces)) for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) out.push(a.address);
	return out;
}

function isTailscale(ip: string): boolean {
	const [a, b] = ip.split(".").map(Number);
	return a === 100 && b >= 64 && b <= 127;
}

/** First address in Tailscale's CGNAT range 100.64.0.0/10, if any. */
export function tailscaleAddress(ifaces: Interfaces = os.networkInterfaces()): string | undefined {
	return ipv4s(ifaces).find(isTailscale);
}

/** The address other devices on the local network most likely reach this machine at. */
export function lanAddress(ifaces: Interfaces = os.networkInterfaces()): string | undefined {
	const all = ipv4s(ifaces);
	const isPrivate = (ip: string) => {
		const [a, b] = ip.split(".").map(Number);
		return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
	};
	return all.find(isPrivate) ?? all.find(ip => !isTailscale(ip)) ?? all[0];
}

/** Where to listen and which address to put in URLs; throws with a readable reason. */
export function resolveBind(bind: RemoteBind, ifaces: Interfaces = os.networkInterfaces()): { host: string; advertise: string } {
	switch (bind) {
		case "tailscale": {
			const ip = tailscaleAddress(ifaces);
			if (!ip) throw new Error("no Tailscale address (100.64.0.0/10) on this machine: is Tailscale running? (or bind to lan / localhost)");
			return { host: ip, advertise: ip };
		}
		case "lan":
			return { host: "0.0.0.0", advertise: lanAddress(ifaces) ?? "127.0.0.1" };
		case "localhost":
			return { host: "127.0.0.1", advertise: "127.0.0.1" };
		default:
			if (net.isIP(bind) === 0) throw new Error(`not an IP address: ${bind}`);
			return { host: bind, advertise: bind === "0.0.0.0" ? (lanAddress(ifaces) ?? "127.0.0.1") : bind === "::" ? "::1" : bind };
	}
}

export function baseUrl(address: string, port: number): string {
	return `http://${net.isIPv6(address) ? `[${address}]` : address}:${port}/`;
}

/** Opening it pairs a browser: the app posts the fragment's token to /api/pair (fragments never reach servers or logs). */
export function pairingUrl(base: string, token: string): string {
	return `${base}#pair=${token}`;
}
