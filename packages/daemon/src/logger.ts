/**
 * Simple file logger for shared-things
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ensureConfigDir, getConfigDir } from "./config.js";

const LOG_FILE = "daemon.log";
const MAX_LOG_SIZE = 1024 * 1024; // 1MB max log size

function getLogPath(): string {
	return path.join(getConfigDir(), LOG_FILE);
}

function rotateIfNeeded(): void {
	const logPath = getLogPath();
	if (!fs.existsSync(logPath)) return;

	const stats = fs.statSync(logPath);
	if (stats.size > MAX_LOG_SIZE) {
		// Keep old log as .1, delete older
		const oldLog = `${logPath}.1`;
		if (fs.existsSync(oldLog)) {
			fs.unlinkSync(oldLog);
		}
		fs.renameSync(logPath, oldLog);
	}
}

export function log(message: string): void {
	ensureConfigDir();
	rotateIfNeeded();

	const timestamp = new Date().toISOString();
	const line = `[${timestamp}] ${message}\n`;

	fs.appendFileSync(getLogPath(), line);
}

export function logError(message: string, error?: unknown): void {
	const errorMsg = error instanceof Error ? error.message : String(error);
	log(`ERROR: ${message}${error ? ` - ${errorMsg}` : ""}`);
}

export function logSync(
	pushed: number,
	pulled: number,
	isFirstSync: boolean,
): void {
	if (isFirstSync) {
		log(`First sync completed: pushed=${pushed}, pulled=${pulled}`);
	} else if (pushed > 0 || pulled > 0) {
		log(`Sync: pushed=${pushed}, pulled=${pulled}`);
	} else {
		log("Sync: no changes");
	}
}

export function logMapping(serverId: string, thingsId: string): void {
	log(`Mapped server ${serverId} -> local ${thingsId}`);
}

export function logTodoCreated(title: string): void {
	log(`Created todo: "${title}"`);
}

export function logTodoUpdated(thingsId: string, title: string): void {
	log(`Updated todo ${thingsId}: "${title}"`);
}

export function logDaemonStart(): void {
	log("Daemon started");
}

export function logDaemonStop(): void {
	log("Daemon stopped");
}
