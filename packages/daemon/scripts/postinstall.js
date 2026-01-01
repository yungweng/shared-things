#!/usr/bin/env node

/**
 * Postinstall script: Automatically restart the daemon if it's running.
 * This ensures users get the new version after `npm update -g shared-things-daemon`.
 *
 * Safe behaviors:
 * - Silent success if daemon is not installed/running
 * - Never fails npm install (catches all errors)
 * - Works with macOS launchd only (daemon is macOS-specific)
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const LABEL = "com.shared-things.daemon";
const PLIST_PATH = path.join(
	os.homedir(),
	"Library",
	"LaunchAgents",
	`${LABEL}.plist`,
);

function main() {
	// Only run on macOS
	if (process.platform !== "darwin") {
		return;
	}

	// Check if launchd agent is installed
	if (!fs.existsSync(PLIST_PATH)) {
		return;
	}

	// Check if agent is currently loaded/running
	try {
		const result = execSync(`launchctl list 2>/dev/null | grep ${LABEL}`, {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		if (!result.includes(LABEL)) {
			return;
		}
	} catch {
		// Not running, nothing to restart
		return;
	}

	// Restart the agent using load/unload (same as launchagent.ts)
	try {
		// Unload (stop) the agent
		execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null || true`, {
			stdio: "pipe",
		});

		// Load (start) the agent with updated binary
		execSync(`launchctl load "${PLIST_PATH}"`, {
			stdio: "pipe",
		});

		console.log("  ✅ Daemon restarted with new version");
	} catch {
		// Don't fail the install, just inform user
		console.log(
			'  ℹ️  Could not auto-restart daemon. Run "shared-things uninstall && shared-things install" manually.',
		);
	}
}

try {
	main();
} catch {
	// Never fail npm install
}
