/**
 * Simple file logger for shared-things (sync.log)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ensureConfigDir, getConfigDir } from "./config.js";

const LOG_FILE = "sync.log";
const MAX_LOG_SIZE = 1024 * 1024; // 1MB max log size

export type LogLevel = "ERROR" | "WARN" | "INFO" | "DEBUG";

function getLogPath(): string {
	return path.join(getConfigDir(), LOG_FILE);
}

function rotateIfNeeded(): void {
	const logPath = getLogPath();
	if (!fs.existsSync(logPath)) return;

	const stats = fs.statSync(logPath);
	if (stats.size > MAX_LOG_SIZE) {
		const oldLog = `${logPath}.1`;
		if (fs.existsSync(oldLog)) {
			fs.unlinkSync(oldLog);
		}
		fs.renameSync(logPath, oldLog);
	}
}

export function log(level: LogLevel, message: string): void {
	ensureConfigDir();
	rotateIfNeeded();

	const timestamp = new Date().toISOString();
	const line = `[${timestamp}] [${level}] ${message}\n`;

	fs.appendFileSync(getLogPath(), line);
}

export function logError(message: string, error?: unknown): void {
	const errorMsg = error instanceof Error ? error.message : String(error);
	log("ERROR", `${message}${error ? ` - ${errorMsg}` : ""}`);
}

export function logWarn(message: string): void {
	log("WARN", message);
}

export function logInfo(message: string): void {
	log("INFO", message);
}

export function logDebug(message: string): void {
	log("DEBUG", message);
}

export function logSync(
	pushed: number,
	pulled: number,
	isFirstSync: boolean,
	conflicts: number,
): void {
	if (isFirstSync) {
		logInfo(
			`Sync complete (first): pushed=${pushed}, pulled=${pulled}, conflicts=${conflicts}`,
		);
	} else if (pushed > 0 || pulled > 0 || conflicts > 0) {
		logInfo(
			`Sync complete: pushed=${pushed}, pulled=${pulled}, conflicts=${conflicts}`,
		);
	} else {
		logDebug("Sync: no changes");
	}
}

export function logMapping(serverId: string, thingsId: string): void {
	logDebug(`Mapped server ${serverId} -> local ${thingsId}`);
}

export function logTodoCreated(title: string): void {
	logInfo(`Created todo: "${title}"`);
}

export function logTodoUpdated(thingsId: string, title: string): void {
	logInfo(`Updated todo ${thingsId}: "${title}"`);
}

export function logDaemonStart(): void {
	logInfo("Daemon started");
}

export function logDaemonStop(): void {
	logInfo("Daemon stopped");
}
