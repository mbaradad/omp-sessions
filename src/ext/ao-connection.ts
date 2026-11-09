// The extension's one connection to the AO daemon (src/ao): found through its run file, or started
// (a systemd user unit where available, else a detached process) when `switchyard.server.autoStart` allows.
// Every module that talks to AO asks `client()`; a failed attempt is retried on the next ask.
import * as vscode from "vscode";
import { type AoEvent, type AoEventSubscription, type AoStreamStatus, AoClient } from "../ao/client";

export class AoConnection implements vscode.Disposable {
	readonly log = vscode.window.createOutputChannel("AO", { log: true });
	private current: AoClient | undefined;
	private connecting: Promise<AoClient> | undefined;
	private readonly connectEmitter = new vscode.EventEmitter<AoClient>();
	/** Fires once a client is connected (the first time, and again after a failed attempt succeeds). */
	readonly onDidConnect = this.connectEmitter.event;

	private readonly eventEmitter = new vscode.EventEmitter<AoEvent>();
	private subscription: AoEventSubscription | undefined;
	/**
	 * AO's change stream (`GET /events`), one subscription for the whole window, shared by every consumer
	 * (resumes after the last event and reconnects; follows the daemon to a new port). Starts when the first
	 * client connects. Filter by `event.sessionId`; `session_updated` fires for any change of a session.
	 */
	readonly onEvent = this.eventEmitter.event;

	private readonly statusEmitter = new vscode.EventEmitter<AoStreamStatus>();
	/**
	 * The state of that same subscription: `open` (with `resumed`/`reset`), `gap`, `retrying`, `closed`. After a
	 * `reset` or a `gap` events may have been missed: re-read whatever was derived from them (a conversation).
	 */
	readonly onStatus = this.statusEmitter.event;
	private lastStatus: AoStreamStatus | undefined;

	/** The latest stream status (for a consumer that starts after it was announced); undefined before the first client. */
	get status(): AoStreamStatus | undefined {
		return this.lastStatus;
	}

	/** The connected client, if any (no I/O). */
	get connected(): AoClient | undefined {
		return this.current;
	}

	/** Whether this window may start the daemon itself (`switchyard.server.autoStart`; tests set SWITCHYARD_NO_SERVER). */
	mayStart(): boolean {
		return !process.env.SWITCHYARD_NO_SERVER && vscode.workspace.getConfiguration("switchyard").get<boolean>("server.autoStart", true);
	}

	/**
	 * A client for the local daemon. `start` (default: `mayStart()`) starts it when none answers; with
	 * `switchyard.server.installService` off it runs as a detached process instead of a systemd user unit.
	 */
	client(start = this.mayStart()): Promise<AoClient> {
		if (this.current) return Promise.resolve(this.current);
		if (this.connecting) return this.connecting;
		const attempt = AoClient.connect({
			start,
			supervisor: vscode.workspace.getConfiguration("switchyard").get<boolean>("server.installService", true) ? "auto" : "detached",
			log: m => this.log.info(m),
		}).then(
			client => {
				this.current = client;
				this.connecting = undefined;
				this.log.info(`connected to AO at ${client.baseUrl}`);
				this.subscription ??= client.events({
					after: "latest",
					onEvent: event => this.eventEmitter.fire(event),
					onStatus: status => {
						this.lastStatus = status;
						this.statusEmitter.fire(status);
					},
				});
				this.connectEmitter.fire(client);
				return client;
			},
			(err: unknown) => {
				this.connecting = undefined;
				this.log.warn(`AO daemon: ${err instanceof Error ? err.message : String(err)}`);
				throw err;
			},
		);
		this.connecting = attempt;
		return attempt;
	}

	dispose(): void {
		this.subscription?.close();
		this.eventEmitter.dispose();
		this.statusEmitter.dispose();
		this.connectEmitter.dispose();
		this.log.dispose();
	}
}
