/**
 * LaunchAgent management for macOS autostart
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PLIST_NAME = "com.shared-things.daemon.plist";
const LAUNCH_AGENTS_DIR = path.join(os.homedir(), "Library", "LaunchAgents");
const PLIST_PATH = path.join(LAUNCH_AGENTS_DIR, PLIST_NAME);

export function installLaunchAgent(): void {
	// Ensure LaunchAgents directory exists
	if (!fs.existsSync(LAUNCH_AGENTS_DIR)) {
		fs.mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
	}

	// Find the installed binary path
	let binPath: string;
	try {
		binPath = execSync("which shared-things", { encoding: "utf-8" }).trim();
	} catch {
		// Fallback: assume it's in npm global bin
		const npmPrefix = execSync("npm prefix -g", { encoding: "utf-8" }).trim();
		binPath = path.join(npmPrefix, "bin", "shared-things");
	}

	const logPath = path.join(os.homedir(), ".shared-things", "daemon.log");

	// Get the directory containing the current node binary (supports nvm, fnm, etc.)
	let nodeBinDir: string;
	try {
		const nodePath = execSync("which node", { encoding: "utf-8" }).trim();
		nodeBinDir = path.dirname(nodePath);
	} catch {
		nodeBinDir = "/usr/local/bin";
	}

	// Build PATH with node's bin dir first, then standard paths
	const envPath = [
		nodeBinDir,
		"/usr/local/bin",
		"/usr/bin",
		"/bin",
		"/opt/homebrew/bin",
	]
		.filter((p, i, arr) => arr.indexOf(p) === i) // dedupe
		.join(":");

	const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.shared-things.daemon</string>

    <key>ProgramArguments</key>
    <array>
        <string>${binPath}</string>
        <string>daemon</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${logPath}</string>

    <key>StandardErrorPath</key>
    <string>${logPath}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${envPath}</string>
    </dict>

    <key>ThrottleInterval</key>
    <integer>30</integer>
</dict>
</plist>
`;

	fs.writeFileSync(PLIST_PATH, plist);
	console.log(`Created: ${PLIST_PATH}`);

	// Load the agent
	try {
		execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null || true`);
		execSync(`launchctl load "${PLIST_PATH}"`);
		console.log("LaunchAgent installed and started.");
	} catch (error) {
		console.warn(`Warning: Could not load LaunchAgent: ${error}`);
		console.warn("You may need to manually load it or restart your Mac.");
	}
}

export function uninstallLaunchAgent(): void {
	if (!fs.existsSync(PLIST_PATH)) {
		console.log("LaunchAgent not installed.");
		return;
	}

	try {
		execSync(`launchctl unload "${PLIST_PATH}"`);
	} catch {
		// Ignore if not loaded
	}

	fs.unlinkSync(PLIST_PATH);
	console.log("LaunchAgent uninstalled.");
}

export function isLaunchAgentInstalled(): boolean {
	return fs.existsSync(PLIST_PATH);
}

export function getLaunchAgentStatus():
	| "running"
	| "stopped"
	| "not-installed" {
	if (!isLaunchAgentInstalled()) {
		return "not-installed";
	}

	try {
		const result = execSync(`launchctl list | grep com.shared-things.daemon`, {
			encoding: "utf-8",
		});
		return result.includes("com.shared-things.daemon") ? "running" : "stopped";
	} catch {
		return "stopped";
	}
}
