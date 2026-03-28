/**
 * File watcher for Things 3 SQLite WAL file
 *
 * Watches the WAL (Write-Ahead Log) file of Things 3's SQLite database
 * to detect local changes without polling. Falls back to periodic
 * polling if the watcher fails.
 */

import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logDebug, logError, logInfo, logWarn } from "./logger.js";

const THINGS_DB_DIR = path.join(
	os.homedir(),
	"Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac",
);

function findWalPath(): string | null {
	// The path includes a variable subdirectory (e.g., ThingsData-TSCK8)
	if (!fs.existsSync(THINGS_DB_DIR)) return null;

	const entries = fs.readdirSync(THINGS_DB_DIR);
	const dataDir = entries.find((e) => e.startsWith("ThingsData-"));
	if (!dataDir) return null;

	const walPath = path.join(
		THINGS_DB_DIR,
		dataDir,
		"Things Database.thingsdatabase",
		"main.sqlite-wal",
	);

	return fs.existsSync(walPath) ? walPath : null;
}

export class ThingsWatcher extends EventEmitter {
	private watcher: fs.FSWatcher | null = null;
	private debounceTimer: NodeJS.Timeout | null = null;
	private fallbackTimer: NodeJS.Timeout | null = null;
	private restartTimer: NodeJS.Timeout | null = null;
	private walPath: string | null = null;
	private lastMtime = 0;
	private running = false;

	start(debounceMs = 500, fallbackIntervalMs = 60_000): void {
		this.walPath = findWalPath();
		if (!this.walPath) {
			logWarn("Things WAL file not found. Using fallback polling only.");
			this.startFallback(fallbackIntervalMs);
			return;
		}

		logInfo(`Watching Things DB: ${this.walPath}`);
		this.running = true;

		// Initialize lastMtime so first check doesn't trigger spuriously
		try {
			const stat = fs.statSync(this.walPath, { throwIfNoEntry: false });
			if (stat) this.lastMtime = stat.mtimeMs;
		} catch {
			// ignore
		}

		this.startWatcher(debounceMs);
		this.startFallback(fallbackIntervalMs);
	}

	stop(): void {
		this.running = false;
		if (this.watcher) {
			this.watcher.close();
			this.watcher = null;
		}
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		if (this.fallbackTimer) clearInterval(this.fallbackTimer);
		if (this.restartTimer) clearTimeout(this.restartTimer);
	}

	private startWatcher(debounceMs: number): void {
		if (!this.walPath || !this.running) return;

		try {
			this.watcher = fs.watch(this.walPath, () => {
				this.scheduleCheck(debounceMs);
			});

			this.watcher.on("error", (err) => {
				logWarn(`Watcher error: ${err.message}`);
				this.watcher?.close();
				this.watcher = null;

				// WAL file may disappear during checkpoint, restart after delay
				if (this.running) {
					this.restartTimer = setTimeout(() => {
						this.walPath = findWalPath();
						if (this.walPath) {
							logInfo("Restarting watcher after error");
							this.startWatcher(debounceMs);
						}
					}, 2000);
				}
			});
		} catch (err) {
			logError("Failed to start watcher", err);
		}
	}

	private startFallback(intervalMs: number): void {
		this.fallbackTimer = setInterval(() => {
			this.checkForChanges();
		}, intervalMs);
	}

	private scheduleCheck(debounceMs: number): void {
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.debounceTimer = setTimeout(() => {
			this.checkForChanges();
		}, debounceMs);
	}

	private checkForChanges(): void {
		if (!this.walPath) {
			// No WAL path known, re-scan
			this.walPath = findWalPath();
			if (!this.walPath) {
				this.emit("change");
				return;
			}
		}

		try {
			const stat = fs.statSync(this.walPath, { throwIfNoEntry: false });
			if (!stat) {
				// WAL file gone (checkpoint), trigger anyway
				this.emit("change");
				return;
			}

			const mtime = stat.mtimeMs;
			if (mtime !== this.lastMtime) {
				this.lastMtime = mtime;
				logDebug("WAL change detected");
				this.emit("change");
			}
		} catch {
			// File might be temporarily unavailable
			this.emit("change");
		}
	}
}
