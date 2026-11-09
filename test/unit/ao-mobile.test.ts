import assert from "node:assert/strict";
import { test } from "node:test";
import { type PairingStatus, pairingLink, pairingPending, pairingReady, reachSummary, tunnelHost } from "../../src/ao/mobile";

const lan = { kind: "lan", host: "192.168.1.20", port: 3001, secure: false };
const tunnel = { kind: "tunnel", host: "abc.trycloudflare.com", port: 443, secure: true };
const status = (over: Partial<PairingStatus> = {}): PairingStatus => ({ enabled: true, hostId: "host-1", host: "pc", password: "s3cret", endpoints: [lan], ...over });

test("pairingLink: aomobile://pair#base64url(offer v2) with every endpoint, as AO's desktop app builds it", () => {
	const link = pairingLink(status({ endpoints: [lan, tunnel] }));
	assert.ok(link);
	const [scheme, payload] = link.split("#");
	assert.equal(scheme, "aomobile://pair");
	const offer = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
	assert.deepEqual(offer, { v: 2, hostId: "host-1", name: "192.168.1.20", platform: "", endpoints: [lan, tunnel], token: "s3cret" });
	assert.doesNotMatch(payload, /[+/=]/, "base64url: safe in a fragment and a QR");
});

test("pairingLink needs the bridge on, an address and the password: an offer without one cannot connect", () => {
	assert.equal(pairingLink(status({ enabled: false })), undefined);
	assert.equal(pairingLink(status({ endpoints: [] })), undefined);
	assert.equal(pairingLink(status({ endpoints: null })), undefined);
	assert.equal(pairingLink(status({ password: "" })), undefined);
	assert.equal(pairingReady(status()), true);
});

test("pairingPending: coming up (no address yet, or the tunnel is starting), not failed, not off, not LAN-only", () => {
	assert.equal(pairingPending(status({ enabled: false })), false);
	assert.equal(pairingPending(status({ endpoints: [] })), true, "no address yet");
	assert.equal(pairingPending(status({ tunnel: { running: true, ready: false } })), true, "tunnel starting");
	assert.equal(pairingPending(status({ tunnel: { supported: true, running: false, ready: false } })), true, "tunnel about to start");
	assert.equal(pairingPending(status({ tunnel: { running: true, ready: true } })), false);
	assert.equal(pairingPending(status({ tunnel: { running: false, ready: false, lastError: "boom" } })), false, "failed: nothing more is coming");
	assert.equal(pairingPending(status({ noPublicTunnel: true, tunnel: { running: true, ready: false } })), false, "the user opted out of the tunnel");
});

test("reachSummary and tunnelHost say how far the code reaches", () => {
	assert.equal(reachSummary(status({ endpoints: [] })), "no address yet");
	assert.equal(reachSummary(status({ endpoints: [lan, tunnel] })), "this network · anywhere (Cloudflare tunnel)");
	assert.equal(tunnelHost(status({ endpoints: [lan, tunnel] })), "abc.trycloudflare.com");
	assert.equal(tunnelHost(status()), undefined);
	assert.match(reachSummary(status({ tunnel: { running: false, ready: false, lastError: "no network" } })), /public tunnel failed: no network/);
	assert.match(reachSummary(status({ tunnel: { supported: false, running: false, ready: false } })), /cloudflared isn't installed/);
	assert.equal(reachSummary(status({ noPublicTunnel: true, tunnel: { supported: false, running: false, ready: false } })), "this network");
});
