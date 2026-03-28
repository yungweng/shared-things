/**
 * Daemon orchestrator (v3)
 *
 * Connects the file watcher, WebSocket client, and sync engine.
 * - Watcher detects local Things changes → triggers sync
 * - WebSocket receives server deltas → applies remote changes
 * - Cooldown after each sync to avoid feedback loops
 *   (AppleScript reads/writes trigger WAL changes too)
 */

import type { DaemonConfig, SyncDelta } from "@shared-things/common";
import { logError, logInfo } from "./logger.js";
import { applyDelta, runSync } from "./sync.js";
import { ThingsWatcher } from "./watcher.js";
import { WsClient } from "./ws-client.js";

/** Ignore watcher events for this long after a sync completes */
const COOLDOWN_MS = 3000;

export class Daemon {
	private watcher: ThingsWatcher;
	private wsClient: WsClient;
	private syncing = false;
	private pendingSync = false;
	private lastSyncEnd = 0;
	private pendingDeltas: SyncDelta[] = [];

	constructor(private config: DaemonConfig) {
		this.watcher = new ThingsWatcher();
		this.wsClient = new WsClient(config.serverUrl, config.apiKey);
	}

	async start(): Promise<void> {
		logInfo("Daemon started (v3 — event-driven)");

		// Initial sync
		try {
			await this.doSync();
			logInfo("Initial sync complete");
		} catch (error) {
			logError("Initial sync failed", error);
		}

		// Start file watcher (local changes → push to server)
		this.watcher.on("change", () => {
			const elapsed = Date.now() - this.lastSyncEnd;
			if (elapsed < COOLDOWN_MS) {
				return;
			}
			this.triggerSync();
		});
		this.watcher.start(500, this.config.fallbackPollIntervalSeconds * 1000);

		// Start WebSocket client (server pushes → apply locally)
		this.wsClient.on("delta", (delta: SyncDelta) => {
			if (this.syncing) {
				// Queue delta if sync lock is held, apply after sync completes
				this.pendingDeltas.push(delta);
				return;
			}
			applyDelta(delta);
			this.lastSyncEnd = Date.now();
		});

		// Re-sync after reconnect to catch missed deltas
		this.wsClient.on("reconnected", () => {
			this.triggerSync();
		});

		this.wsClient.start();

		// Handle shutdown
		const shutdown = () => {
			logInfo("Daemon stopping");
			this.watcher.stop();
			this.wsClient.stop();
			process.exit(0);
		};
		process.on("SIGTERM", shutdown);
		process.on("SIGINT", shutdown);

		logInfo(
			`Watching Things DB, WebSocket ${this.wsClient.isConnected() ? "connected" : "connecting"}...`,
		);
	}

	private async doSync(): Promise<void> {
		await runSync();
		this.lastSyncEnd = Date.now();
		this.drainPendingDeltas();
	}

	private drainPendingDeltas(): void {
		while (this.pendingDeltas.length > 0) {
			const delta = this.pendingDeltas.shift()!;
			applyDelta(delta);
			this.lastSyncEnd = Date.now();
		}
	}

	private async triggerSync(): Promise<void> {
		if (this.syncing) {
			this.pendingSync = true;
			return;
		}

		this.syncing = true;
		try {
			await this.doSync();
		} catch (error) {
			logError("Sync failed", error);
		} finally {
			this.syncing = false;
			if (this.pendingSync) {
				this.pendingSync = false;
				setTimeout(() => this.triggerSync(), COOLDOWN_MS);
			}
		}
	}
}
