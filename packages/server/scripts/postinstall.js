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

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DATA_DIR =
	process.env.DATA_DIR || path.join(os.homedir(), ".shared-things-server");
const PID_FILE = path.join(DATA_DIR, "server.pid");

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
	// Verify the command exists
	try {
		execSync("which shared-things-server", { stdio: "pipe" });
	} catch {
		// Command not in PATH, can't start
		return false;
	}

	// Use the CLI's built-in detach mode (-d flag)
	// This properly handles daemonization and PID file management
	try {
		execSync("shared-things-server start -d", {
			stdio: "pipe",
			timeout: 10000,
		});
		return true;
	} catch {
		return false;
	}
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
