#!/usr/bin/env node

/**
 * Postinstall script: Automatically restart the server if it's running.
 * This ensures users get the new version after `npm update -g shared-things-server`.
 *
 * Safe behaviors:
 * - Silent success if server is not running
 * - Never fails npm install (catches all errors)
 * - Works on any platform (Linux, macOS)
 */

import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DATA_DIR =
	process.env.DATA_DIR || path.join(os.homedir(), ".shared-things-server");
const PID_FILE = path.join(DATA_DIR, "server.pid");
const LOG_FILE = path.join(DATA_DIR, "server.log");

function isServerRunning() {
	if (!fs.existsSync(PID_FILE)) {
		return { running: false };
	}

	const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);

	try {
		// Check if process exists (signal 0 doesn't kill, just checks)
		process.kill(pid, 0);
		return { running: true, pid };
	} catch {
		// Process doesn't exist, clean up stale PID file
		try {
			fs.unlinkSync(PID_FILE);
		} catch {
			// Ignore cleanup errors
		}
		return { running: false };
	}
}

function stopServer(pid) {
	try {
		process.kill(pid, "SIGTERM");
		// Wait for graceful shutdown
		let attempts = 0;
		while (attempts < 10) {
			try {
				process.kill(pid, 0);
				// Still running, wait
				execSync("sleep 0.2", { stdio: "pipe" });
				attempts++;
			} catch {
				// Process stopped
				break;
			}
		}
		// Clean up PID file if still exists
		if (fs.existsSync(PID_FILE)) {
			fs.unlinkSync(PID_FILE);
		}
		return true;
	} catch {
		return false;
	}
}

function startServer() {
	// Find the CLI script - after npm install, it should be in node_modules/.bin or global
	let cliPath;
	try {
		cliPath = execSync("which shared-things-server", {
			encoding: "utf-8",
		}).trim();
	} catch {
		// Fallback: look relative to this script
		cliPath = path.resolve(
			new URL(".", import.meta.url).pathname,
			"..",
			"dist",
			"cli.js",
		);
	}

	if (!fs.existsSync(cliPath)) {
		return false;
	}

	// Ensure data directory exists
	if (!fs.existsSync(DATA_DIR)) {
		fs.mkdirSync(DATA_DIR, { recursive: true });
	}

	// Open log file
	const logFd = fs.openSync(LOG_FILE, "a");

	const child = spawn(process.execPath, [cliPath, "start"], {
		detached: true,
		stdio: ["ignore", logFd, logFd],
		env: { ...process.env, SHARED_THINGS_DETACHED: "1" },
	});

	// Write PID file
	fs.writeFileSync(PID_FILE, String(child.pid));
	child.unref();
	fs.closeSync(logFd);

	return true;
}

function main() {
	const status = isServerRunning();

	if (!status.running) {
		// Server not running, nothing to restart
		return;
	}

	// Stop the old server
	const stopped = stopServer(status.pid);
	if (!stopped) {
		console.log(
			'  ℹ️  Could not auto-restart server. Run "shared-things-server stop && shared-things-server start -d" manually.',
		);
		return;
	}

	// Start with new version
	const started = startServer();
	if (started) {
		console.log("  ✅ Server restarted with new version");
	} else {
		console.log(
			'  ℹ️  Server stopped. Run "shared-things-server start -d" to start it again.',
		);
	}
}

try {
	main();
} catch {
	// Never fail npm install
}
