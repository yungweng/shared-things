/**
 * Simple file logger for shared-things
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ensureConfigDir, getConfigDir } from "./config.js";

const LOG_FILE = "sync.log";
const MAX_LOG_SIZE = 1024 * 1024; // 1MB

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
		if (fs.existsSync(oldLog)) fs.unlinkSync(oldLog);
		fs.renameSync(logPath, oldLog);
	}
}

export function log(level: LogLevel, message: string): void {
	ensureConfigDir();
	rotateIfNeeded();
	const timestamp = new Date().toISOString();
	fs.appendFileSync(getLogPath(), `[${timestamp}] [${level}] ${message}\n`);
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
