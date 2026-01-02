#!/usr/bin/env node

/**
 * shared-things CLI
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { confirm, input, password, select } from "@inquirer/prompts";
import chalk from "chalk";
import { Command } from "commander";
import updateNotifier from "update-notifier";
import { ApiClient } from "./api.js";
import {
	configExists,
	getConfigDir,
	loadConfig,
	saveConfig,
} from "./config.js";
import {
	getLaunchAgentStatus,
	installLaunchAgent,
	startLaunchAgent,
	stopLaunchAgent,
	uninstallLaunchAgent,
} from "./launchagent.js";
import { logError, logInfo } from "./logger.js";
import { runSync } from "./sync.js";
import {
	getTodosFromProject,
	isThingsRunning,
	listProjects,
} from "./things.js";

// Check for updates with immediate feedback
const pkg = JSON.parse(
	fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
);
const updateCheckInterval = 1000 * 60 * 60; // 1 hour

// updateNotifier() calls check() which loads cached update into notifier.update
// and clears the cache (by design - it's a one-time read)
const notifier = updateNotifier({ pkg, updateCheckInterval });

// Validate cached update against current version (user may have upgraded)
// Note: We intentionally mutate read-only properties here because update-notifier
// caches updates and we need to correct stale data when the user has upgraded
if (notifier.update) {
	(notifier.update as { current: string }).current = pkg.version;
	// Clear if no longer outdated
	if (notifier.update.current === notifier.update.latest) {
		(notifier as { update: undefined }).update = undefined;
	}
}

// Detect first run: lastUpdateCheck was just set by constructor (within last second)
const lastCheck = notifier.config?.get("lastUpdateCheck") ?? 0;
const isFirstRun = Date.now() - lastCheck < 1000;
const intervalPassed = Date.now() - lastCheck >= updateCheckInterval;

// Fetch immediately if no cached update and (first run OR interval passed)
// This fixes the 24h delay issue where check() skips spawning on first run
if (!notifier.update && (isFirstRun || intervalPassed)) {
	try {
		const update = await notifier.fetchInfo();
		notifier.config?.set("lastUpdateCheck", Date.now());
		if (update && update.type !== "latest") {
			(notifier as { update: typeof update }).update = update;
		}
	} catch {
		// Ignore network errors
	}
}

// Re-cache update for next run (check() deleted it when reading)
// Only cache if there's actually an update available
if (notifier.update && notifier.update.current !== notifier.update.latest) {
	notifier.config?.set("update", notifier.update);
} else {
	notifier.config?.delete("update");
}

// Show notification on exit (bypasses TTY check that blocks notify())
process.on("exit", () => {
	if (notifier.update && notifier.update.current !== notifier.update.latest) {
		console.error(
			chalk.yellow(
				`\n  Update available: ${notifier.update.current} → ${notifier.update.latest}`,
			) + chalk.dim(`\n  Run: npm i -g ${pkg.name}\n`),
		);
	}
});

const program = new Command();

program
	.name("shared-things")
	.description("Sync a Things 3 project between multiple users")
	.version(pkg.version);

// =============================================================================
// init command
// =============================================================================
program
	.command("init")
	.description("Setup wizard")
	.action(async () => {
		console.log("\n🔄 shared-things Setup\n");

		// Check if already configured
		if (configExists()) {
			const overwrite = await confirm({
				message: "Configuration already exists. Overwrite?",
				default: false,
			});
			if (!overwrite) {
				console.log(chalk.dim("Cancelled."));
				return;
			}
			// Delete old state to start fresh
			const statePath = path.join(getConfigDir(), "state.json");
			if (fs.existsSync(statePath)) {
				fs.unlinkSync(statePath);
				console.log(chalk.dim("Old sync state cleared.\n"));
			}
		}

		// Check Things
		if (!isThingsRunning()) {
			console.log("⚠️  Things 3 is not running. Please start it first.\n");
		}

		// Step 1: Server URL
		const serverUrl = await input({
			message: "Server URL",
			default: "https://things.example.com",
			validate: (value) => {
				if (!value) return "Server URL is required";
				if (!value.startsWith("http://") && !value.startsWith("https://")) {
					return "URL must start with http:// or https://";
				}
				return true;
			},
		});

		// Step 2: API Key
		const apiKey = await password({
			message: "API Key",
			mask: "*",
			validate: (value) => (value ? true : "API key is required"),
		});

		// Verify connection and API key
		console.log("\n⏳ Verifying connection...");
		const api = new ApiClient(serverUrl, apiKey);
		try {
			await api.health();
			console.log("✅ Server reachable");
		} catch (error) {
			console.error(`❌ Failed to connect to server: ${error}`);
			process.exit(1);
		}

		// Verify API key by calling an authenticated endpoint
		console.log("⏳ Verifying API key...");
		try {
			await api.getState();
			console.log("✅ API key valid!\n");
		} catch (error) {
			console.error(`❌ Invalid API key: ${error}`);
			process.exit(1);
		}

		// Step 3: Select Things project
		const projects = listProjects();
		if (projects.length === 0) {
			console.error(
				"❌ No Things projects found. Create a project in Things first.",
			);
			process.exit(1);
		}

		const projectName = await select({
			message: "Things project to sync",
			choices: projects.map((p) => ({ name: p, value: p })),
		});

		// Verify project access
		console.log("\n⏳ Checking Things project...");
		const todos = getTodosFromProject(projectName);
		if (todos.length > 0) {
			console.error(
				`❌ Project "${projectName}" must be empty for first sync (found ${todos.length}).`,
			);
			process.exit(1);
		}
		console.log(`✅ Project "${projectName}" is empty.\n`);

		// Step 4: Things Auth Token
		console.log("📋 Find your Things Auth Token in:");
		console.log("   Things → Settings → General → Things URLs → Manage\n");

		const thingsAuthToken = await password({
			message: "Things Auth Token",
			mask: "*",
			validate: (value) =>
				value ? true : "Auth token is required for updating tasks",
		});

		console.log(
			chalk.yellow("\n⚠️  Auth token will be verified on first sync.\n"),
		);

		// Save config
		saveConfig({
			serverUrl,
			apiKey,
			projectName,
			pollInterval: 30,
			thingsAuthToken,
		});

		// Initialize state.json
		writeState({
			lastSyncedAt: new Date().toISOString(),
			todos: {},
			serverIdToThingsId: {},
			dirty: { upserted: [], deleted: {} },
		});

		console.log("\n✅ Configuration saved!\n");

		const install = await confirm({
			message: "Install LaunchAgent to run sync automatically on login?",
			default: true,
		});
		if (install) {
			installLaunchAgent();
		}

		console.log("\nNext steps:");
		console.log('  1. Run "shared-things sync" for a one-time sync');
		console.log('  2. Or run "shared-things start" to run the daemon\n');
	});

// =============================================================================
// install command
// =============================================================================
program
	.command("start")
	.description("Start the sync daemon (launchd)")
	.action(() => {
		if (!configExists()) {
			console.error('Not configured. Run "shared-things init" first.');
			process.exit(1);
		}
		startLaunchAgent();
	});

// =============================================================================
// uninstall command
// =============================================================================
program
	.command("stop")
	.description("Stop the sync daemon (launchd)")
	.action(() => {
		stopLaunchAgent();
	});

// Backwards compatible commands
program
	.command("install")
	.description("Install launchd daemon (deprecated)")
	.action(() => {
		if (!configExists()) {
			console.error('Not configured. Run "shared-things init" first.');
			process.exit(1);
		}
		installLaunchAgent();
	});

program
	.command("uninstall")
	.description("Remove launchd daemon (deprecated)")
	.action(() => {
		uninstallLaunchAgent();
	});

// =============================================================================
// status command
// =============================================================================
program
	.command("status")
	.description("Show sync status")
	.action(async () => {
		if (!configExists()) {
			console.log(chalk.yellow("⚠️  Not configured"));
			console.log(chalk.dim('Run "shared-things init" to get started.'));
			return;
		}

		const config = loadConfig()!;
		const daemonStatus = getLaunchAgentStatus();
		const isRunning = daemonStatus === "running";

		console.log(chalk.bold("\n📊 shared-things Status\n"));

		// Check server connectivity
		const api = new ApiClient(config.serverUrl, config.apiKey);
		let serverReachable = false;
		try {
			await api.health();
			serverReachable = true;
		} catch {
			serverReachable = false;
		}

		console.log(
			`${chalk.dim("Server:")}    ${chalk.cyan(config.serverUrl)} ${serverReachable ? chalk.green("●") : chalk.red("○")}`,
		);
		console.log(
			`${chalk.dim("Project:")}   ${chalk.white(config.projectName)}`,
		);
		console.log(`${chalk.dim("Interval:")}  ${config.pollInterval}s`);
		console.log(
			`${chalk.dim("Daemon:")}    ${isRunning ? chalk.green("● running") : chalk.red("○ stopped")}`,
		);

		const state = readState();
		if (state) {
			const lastSync = new Date(state.lastSyncedAt);
			const ago = formatTimeAgo(lastSync);
			console.log(`${chalk.dim("Last sync:")} ${ago}`);
			console.log(
				`${chalk.dim("Dirty:")}    upserted=${state.dirty.upserted.length}, deleted=${Object.keys(state.dirty.deleted).length}`,
			);
		} else {
			console.log(`${chalk.dim("Last sync:")} ${chalk.yellow("never")}`);
		}

		const conflicts = readConflicts();
		if (conflicts.length > 0) {
			console.log(
				`${chalk.dim("Conflicts:")} ${chalk.yellow(conflicts.length)} (run "shared-things conflicts")`,
			);
		}
		console.log();
	});

// Helper to format relative time
function formatTimeAgo(date: Date): string {
	const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
	if (seconds < 60) return "just now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

// =============================================================================
// sync command
// =============================================================================
program
	.command("sync")
	.description("Manual one-time sync")
	.action(async () => {
		if (!configExists()) {
			console.error('Not configured. Run "shared-things init" first.');
			process.exit(1);
		}

		try {
			const result = await runSync();
			if (result.skipped) {
				console.log(chalk.yellow("⚠️  Sync skipped (another sync is running)."));
				return;
			}
			if (result.isFirstSync)
				console.log(chalk.cyan("📥 First sync completed!"));
			console.log(
				chalk.green(
					`✅ Done! Pushed: ${result.pushed}, Pulled: ${result.pulled}, Conflicts: ${result.conflicts}`,
				),
			);
		} catch (error) {
			logError("Manual sync failed", error);
			console.error(chalk.red(`❌ Sync failed: ${error}`));
			process.exit(1);
		}
	});

// =============================================================================
// daemon command (internal, run by launchd)
// =============================================================================
program
	.command("daemon")
	.description("Run sync daemon (used by launchd)")
	.action(async () => {
		if (!configExists()) {
			console.error('Not configured. Run "shared-things init" first.');
			process.exit(1);
		}

		const config = loadConfig()!;
		logInfo("Daemon started");
		logInfo(`Polling interval: ${config.pollInterval}s`);
		console.log(`Daemon started. Syncing every ${config.pollInterval}s...`);

		// Handle graceful shutdown
		const shutdown = () => {
			logInfo("Daemon stopped");
			process.exit(0);
		};
		process.on("SIGTERM", shutdown);
		process.on("SIGINT", shutdown);

		// Initial sync
		try {
			await runSync();
			logInfo("Initial sync complete");
		} catch (error) {
			logError("Initial sync failed", error);
		}

		// Poll loop
		setInterval(async () => {
			try {
				await runSync();
			} catch (error) {
				logError("Sync failed", error);
			}
		}, config.pollInterval * 1000);
	});

// =============================================================================
// logs command
// =============================================================================
program
	.command("logs")
	.description("Show sync logs")
	.option("-f, --follow", "Follow log output")
	.action((options) => {
		const logPath = path.join(getConfigDir(), "sync.log");

		if (!fs.existsSync(logPath)) {
			console.log("No logs yet.");
			return;
		}

		if (options.follow) {
			spawn("tail", ["-f", logPath], { stdio: "inherit" });
		} else {
			const logs = fs.readFileSync(logPath, "utf-8");
			console.log(logs);
		}
	});

// =============================================================================
// reset command
// =============================================================================
program
	.command("reset")
	.description("Reset sync state")
	.option("--local", "Clear local state (re-sync from server)")
	.option("--server", "Clear server data for this user")
	.action(async (options) => {
		if (!configExists()) {
			console.log(chalk.yellow("Not configured. Nothing to reset."));
			return;
		}

		if (!options.local && !options.server) {
			console.log(chalk.yellow("Specify --local and/or --server to reset."));
			return;
		}

		const statePath = path.join(getConfigDir(), "state.json");
		const hasLocalState = fs.existsSync(statePath);

		const confirmed = await confirm({
			message: "This action cannot be undone. Continue?",
			default: false,
		});

		if (!confirmed) {
			console.log(chalk.dim("Cancelled."));
			return;
		}

		// Reset server data if requested
		if (options.server) {
			const config = loadConfig()!;
			const api = new ApiClient(config.serverUrl, config.apiKey);

			try {
				console.log(chalk.dim("Deleting server data..."));
				const result = await api.reset();
				logInfo(`Server reset: deleted ${result.deleted.todos} todos`);
				console.log(
					chalk.green(`✅ Server data deleted (${result.deleted.todos} todos)`),
				);
			} catch (error) {
				logError("Server reset failed", error);
				console.error(chalk.red(`❌ Failed to reset server: ${error}`));
				return;
			}
		}

		if (options.local) {
			if (hasLocalState) {
				fs.unlinkSync(statePath);
			}
			const conflictsPath = path.join(getConfigDir(), "conflicts.json");
			if (fs.existsSync(conflictsPath)) fs.unlinkSync(conflictsPath);
			writeState({
				lastSyncedAt: new Date(0).toISOString(),
				todos: {},
				serverIdToThingsId: {},
				dirty: { upserted: [], deleted: {} },
			});
			logInfo("Local sync state reset by user");
		}

		console.log(
			chalk.green(
				'✅ Reset complete. Run "shared-things sync" for a fresh sync.',
			),
		);
	});

// =============================================================================
// conflicts command
// =============================================================================
program
	.command("conflicts")
	.description("Show conflict history")
	.option("--all", "Show all conflicts")
	.action((options) => {
		const conflicts = readConflicts();
		if (conflicts.length === 0) {
			console.log("No conflicts recorded.");
			return;
		}

		const shown = options.all ? conflicts : conflicts.slice(-10);
		console.log(chalk.bold(`\n⚠️  Conflicts (${shown.length})\n`));
		for (const conflict of shown) {
			console.log(
				`${chalk.dim(conflict.timestamp)} ${chalk.white(conflict.title)} (${conflict.serverId})`,
			);
			console.log(`  ${chalk.dim("Reason:")} ${conflict.reason}`);
			if (conflict.yourVersion.editedAt || conflict.yourVersion.deletedAt) {
				console.log(
					`  ${chalk.dim("Yours:")} ${formatConflictVersion(conflict.yourVersion)}`,
				);
			}
			if (
				conflict.winningVersion.editedAt ||
				conflict.winningVersion.deletedAt
			) {
				console.log(
					`  ${chalk.dim("Winner:")} ${formatConflictVersion(conflict.winningVersion)}`,
				);
			}
			console.log();
		}
	});

// =============================================================================
// repair command
// =============================================================================
program
	.command("repair")
	.description("Diagnose state issues (no auto-fix)")
	.action(() => {
		const issues: string[] = [];
		if (!configExists()) {
			issues.push("Missing config.json (run init)");
		}
		const state = readState();
		if (!state) {
			issues.push("Missing or invalid state.json");
		}
		if (issues.length === 0) {
			console.log(chalk.green("No issues detected."));
		} else {
			console.log(chalk.yellow("Issues detected:"));
			for (const issue of issues) {
				console.log(`- ${issue}`);
			}
		}
	});

// =============================================================================
// doctor command
// =============================================================================
program
	.command("doctor")
	.description("Comprehensive health check")
	.action(async () => {
		console.log(chalk.bold("\n🩺 shared-things Doctor\n"));

		if (!configExists()) {
			console.log(chalk.red("Config: missing (run init)"));
			return;
		}

		const config = loadConfig()!;
		console.log(chalk.green("Config: ok"));

		const state = readState();
		console.log(
			state ? chalk.green("State: ok") : chalk.red("State: missing/invalid"),
		);

		if (!isThingsRunning()) {
			console.log(chalk.yellow("Things 3: not running"));
		} else {
			console.log(chalk.green("Things 3: running"));
		}

		const projects = listProjects();
		if (!projects.includes(config.projectName)) {
			console.log(chalk.red(`Project: "${config.projectName}" not found`));
		} else {
			console.log(chalk.green(`Project: ${config.projectName}`));
		}

		const api = new ApiClient(config.serverUrl, config.apiKey);
		try {
			await api.health();
			console.log(chalk.green("Server: reachable"));
		} catch {
			console.log(chalk.red("Server: unreachable"));
		}

		const daemonStatus = getLaunchAgentStatus();
		console.log(chalk.green(`Daemon: ${daemonStatus}`));
		console.log();
	});

function readState(): {
	lastSyncedAt: string;
	dirty: { upserted: string[]; deleted: Record<string, string> };
} | null {
	const statePath = path.join(getConfigDir(), "state.json");
	if (!fs.existsSync(statePath)) return null;
	try {
		const raw = fs.readFileSync(statePath, "utf-8");
		const data = JSON.parse(raw) as {
			lastSyncedAt: string;
			dirty?: { upserted?: string[]; deleted?: Record<string, string> };
		};
		return {
			lastSyncedAt: data.lastSyncedAt,
			dirty: {
				upserted: data.dirty?.upserted ?? [],
				deleted: data.dirty?.deleted ?? {},
			},
		};
	} catch {
		return null;
	}
}

function readConflicts(): Array<{
	timestamp: string;
	serverId: string;
	title: string;
	yourVersion: { editedAt?: string; deletedAt?: string };
	winningVersion: { editedAt?: string; deletedAt?: string };
	reason: string;
}> {
	const conflictsPath = path.join(getConfigDir(), "conflicts.json");
	if (!fs.existsSync(conflictsPath)) return [];
	try {
		return JSON.parse(fs.readFileSync(conflictsPath, "utf-8"));
	} catch {
		return [];
	}
}

function formatConflictVersion(version: {
	title?: string;
	editedAt?: string;
	deletedAt?: string;
}): string {
	if (version.deletedAt) return `deletedAt=${version.deletedAt}`;
	if (version.editedAt) return `editedAt=${version.editedAt}`;
	return "unknown";
}

function writeState(state: {
	lastSyncedAt: string;
	todos: Record<string, unknown>;
	serverIdToThingsId: Record<string, string>;
	dirty: { upserted: string[]; deleted: Record<string, string> };
}) {
	const statePath = path.join(getConfigDir(), "state.json");
	const temp = `${statePath}.tmp-${process.pid}`;
	fs.writeFileSync(temp, JSON.stringify(state, null, 2));
	fs.renameSync(temp, statePath);
}

program.parse();
