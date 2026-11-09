// Pairing AO's mobile app with this machine: the pure part of Connect Phone (VS Code) that a CLI can
// share. AO's daemon serves the phone (`/api/v1/mobile/*`); the pairing code is the one AO's desktop
// app shows (frontend/src/renderer/lib/pairing-payload.ts), and the phone parses it in
// packages/mobile/lib/pairingCode.ts: `aomobile://pair#<base64url(JSON offer v2)>`.

/** One address the daemon advertises for phones (`MobileEndpoint`). */
export interface PairingEndpoint {
	/** `lan`, `tailscale`, `tunnel` (and whatever a newer daemon adds: passed through, the phone validates). */
	kind: string;
	host: string;
	port: number;
	secure: boolean;
}

/** The fields of `GET /api/v1/mobile/status` (`MobileStatusResponse`) pairing needs. */
export interface PairingStatus {
	enabled: boolean;
	hostId?: string;
	host?: string;
	password?: string;
	endpoints?: readonly PairingEndpoint[] | null;
	/** LAN-only: the user opted out of the public tunnel. */
	noPublicTunnel?: boolean;
	tunnel?: { supported?: boolean; installing?: boolean; running: boolean; ready: boolean; hostname?: string; lastError?: string };
	tailscaleHost?: string;
	securePairing?: { enabled: boolean; available: boolean; active: boolean; reason?: string };
	warning?: string;
}

/** The app's registered scheme: the system camera opens the app straight from the code. */
export const PAIRING_LINK_BASE = "aomobile://pair";
export const IOS_APP_URL = "https://apps.apple.com/app/ao-mobile/id6792552173";
export const ANDROID_APP_URL = "https://play.google.com/store/apps/details?id=aoagents.dev";

/** Whether a scannable code exists: the bridge is on and advertises at least one address (an offer without one cannot connect). */
export function pairingReady(status: PairingStatus): boolean {
	return status.enabled && !!status.endpoints?.length && !!status.password;
}

/** Still coming up: no address yet, or the public tunnel is starting (the code then gains its address). */
export function pairingPending(status: PairingStatus): boolean {
	if (!status.enabled) return false;
	if (!status.endpoints?.length) return true;
	if (status.noPublicTunnel) return false;
	const t = status.tunnel;
	if (!t || t.ready || t.lastError) return false;
	return t.supported === true || t.running || t.installing === true;
}

/**
 * The pairing link (offer v2): every advertised endpoint, so the phone races LAN, Tailscale and the
 * tunnel. The payload rides in the fragment, which never reaches a server. Undefined until `pairingReady`.
 */
export function pairingLink(status: PairingStatus): string | undefined {
	if (!pairingReady(status)) return undefined;
	const endpoints = status.endpoints ?? [];
	const offer = { v: 2, hostId: status.hostId ?? "", name: endpoints[0]?.host ?? status.host ?? "", platform: "", endpoints: [...endpoints], token: status.password ?? "" };
	return `${PAIRING_LINK_BASE}#${Buffer.from(JSON.stringify(offer)).toString("base64url")}`;
}

/** The public tunnel's address, once it serves. */
export function tunnelHost(status: PairingStatus): string | undefined {
	return status.endpoints?.find(e => e.kind === "tunnel")?.host;
}

/** A sentence on how far the code reaches, for the panel. */
export function reachSummary(status: PairingStatus): string {
	const kinds = new Set((status.endpoints ?? []).map(e => e.kind));
	const parts = [kinds.has("lan") ? "this network" : "", kinds.has("tailscale") ? "Tailscale" : "", kinds.has("tunnel") ? "anywhere (Cloudflare tunnel)" : ""].filter(Boolean);
	if (!parts.length) return "no address yet";
	if (!kinds.has("tunnel") && !status.noPublicTunnel && status.tunnel?.lastError) parts.push(`the public tunnel failed: ${status.tunnel.lastError}`);
	else if (!kinds.has("tunnel") && !status.noPublicTunnel && status.tunnel?.supported === false) parts.push("no public tunnel: cloudflared isn't installed");
	return parts.join(" · ");
}
