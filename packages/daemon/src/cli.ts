#!/usr/bin/env node

/**
 * shared-things CLI (v3)
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { confirm, input, password, select } from "@inquirer/prompts";
import chalk from "chalk";
import { Command } from "commander";
import { ApiClient } from "./api.js";
import {
	configExists,
	getConfigDir,
	loadConfig,
	saveConfig,
} from "./config.js";
import { Daemon } from "./daemon.js";
import {
	getLaunchAgentStatus,
	installLaunchAgent,
	startLaunchAgent,
	stopLaunchAgent,
} from "./launchagent.js";
import { logError, logInfo } from "./logger.js";
import { readConflicts, writeInitialState } from "./state.js";
import { runSync } from "./sync.js";
import {
	getTodosFromArea,
	getTodosFromProject,
	isThingsRunning,
	listAreas,
	listProjects,
} from "./things.js";

/** Get the sync target name from config */
function getSyncTarget(config: {
	syncMode?: string;
	projectName?: string;
	areaName?: string;
}): string {
	if (config.syncMode === "area" && config.areaName) return config.areaName;
	return config.projectName || "Unknown";
}

const program = new Command();

program
	.name("shared-things")
	.description("Sync a Things 3 project between multiple users (v3)")
	.version("3.0.0");

// =============================================================================
// init
// =============================================================================
program
	.command("init")
	.description("Setup wizard")
	.action(async () => {
		console.log(chalk.bold("\nshared-things Setup\n"));

		if (configExists()) {
			const overwrite = await confirm({
				message: "Configuration already exists. Overwrite?",
				default: false,
			});
			if (!overwrite) {
				console.log(chalk.dim("Cancelled."));
				return;
			}
			const statePath = path.join(getConfigDir(), "state.json");
			if (fs.existsSync(statePath)) {
				fs.unlinkSync(statePath);
				console.log(chalk.dim("Old sync state cleared.\n"));
			}
		}

		if (!isThingsRunning()) {
			console.log(
				chalk.yellow("Things 3 is not running. Please start it first.\n"),
			);
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

		// Verify connection
		console.log(chalk.dim("\nVerifying connection..."));
		const api = new ApiClient(serverUrl, apiKey);
		try {
			await api.health();
			console.log(chalk.green("Server reachable"));
		} catch (error) {
			console.error(chalk.red(`Failed to connect: ${error}`));
			process.exit(1);
		}

		try {
			await api.getState();
			console.log(chalk.green("API key valid\n"));
		} catch (error) {
			console.error(chalk.red(`Invalid API key: ${error}`));
			process.exit(1);
		}

		// Step 3: Select sync mode and target
		const syncMode = await select({
			message: "What do you want to sync?",
			choices: [
				{ name: "A single project", value: "project" as const },
				{
					name: "An entire area (all projects within it)",
					value: "area" as const,
				},
			],
		});

		let projectName: string | undefined;
		let areaName: string | undefined;

		if (syncMode === "area") {
			const areas = listAreas();
			if (areas.length === 0) {
				console.error(
					chalk.red("No Things areas found. Create an area in Things first."),
				);
				process.exit(1);
			}
			areaName = await select({
				message: "Things area to sync",
				choices: areas.map((a) => ({ name: a, value: a })),
			});
			console.log(
				chalk.green(
					`\nArea "${areaName}" selected. All projects within it will sync.\n`,
				),
			);
		} else {
			const projects = listProjects();
			if (projects.length === 0) {
				console.error(
					chalk.red(
						"No Things projects found. Create a project in Things first.",
					),
				);
				process.exit(1);
			}
			projectName = await select({
				message: "Things project to sync",
				choices: projects.map((p) => ({ name: p, value: p })),
			});

			console.log(chalk.dim("\nChecking Things project..."));
			const todos = getTodosFromProject(projectName);
			if (todos.length > 0) {
				console.error(
					chalk.red(
						`Project "${projectName}" must be empty for first sync (found ${todos.length} todos).`,
					),
				);
				process.exit(1);
			}
			console.log(chalk.green(`Project "${projectName}" is empty.\n`));
		}

		// Step 4: Things Auth Token
		console.log("Find your Things Auth Token in:");
		console.log(
			chalk.dim("  Things > Settings > General > Things URLs > Manage\n"),
		);

		const thingsAuthToken = await password({
			message: "Things Auth Token",
			mask: "*",
			validate: (value) =>
				value ? true : "Auth token is required for updating tasks",
		});

		// Save config
		saveConfig({
			serverUrl,
			apiKey,
			syncMode,
			projectName,
			areaName,
			thingsAuthToken,
			fallbackPollIntervalSeconds: 60,
		});

		writeInitialState();
		console.log(chalk.green("\nConfiguration saved!\n"));

		const install = await confirm({
			message: "Install LaunchAgent to run sync automatically on login?",
			default: true,
		});
		if (install) {
			installLaunchAgent();
		}

		console.log("\nNext steps:");
		console.log('  1. Run "shared-things sync" for a one-time sync');
		console.log('  2. Or run "shared-things start" to start the daemon\n');
	});

// =============================================================================
// start / stop
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

program
	.command("stop")
	.description("Stop the sync daemon (launchd)")
	.action(() => {
		stopLaunchAgent();
	});

// =============================================================================
// target (switch sync mode)
// =============================================================================
program
	.command("target")
	.description("Change sync target (project or area)")
	.action(async () => {
		if (!configExists()) {
			console.error('Not configured. Run "shared-things init" first.');
			process.exit(1);
		}

		const config = loadConfig()!;
		console.log(
			chalk.dim(
				`\nCurrent: ${getSyncTarget(config)} (${config.syncMode || "project"})\n`,
			),
		);

		const syncMode = await select({
			message: "What do you want to sync?",
			choices: [
				{ name: "A single project", value: "project" as const },
				{
					name: "An entire area (all projects within it)",
					value: "area" as const,
				},
			],
		});

		if (syncMode === "area") {
			const areas = listAreas();
			if (areas.length === 0) {
				console.error(chalk.red("No Things areas found."));
				return;
			}
			config.syncMode = "area";
			config.areaName = await select({
				message: "Things area to sync",
				choices: areas.map((a) => ({ name: a, value: a })),
			});
		} else {
			const projects = listProjects();
			if (projects.length === 0) {
				console.error(chalk.red("No Things projects found."));
				return;
			}
			config.syncMode = "project";
			config.projectName = await select({
				message: "Things project to sync",
				choices: projects.map((p) => ({ name: p, value: p })),
			});
		}

		saveConfig(config);
		writeInitialState();
		console.log(
			chalk.green(
				`\nTarget changed to: ${getSyncTarget(config)} (${config.syncMode})`,
			),
		);
		console.log(chalk.dim('Run "shared-things sync" or restart the daemon.\n'));
	});

// =============================================================================
// status
// =============================================================================
program
	.command("status")
	.description("Show sync status")
	.action(async () => {
		if (!configExists()) {
			console.log(chalk.yellow("Not configured."));
			console.log(chalk.dim('Run "shared-things init" to get started.'));
			return;
		}

		const config = loadConfig()!;
		const daemonStatus = getLaunchAgentStatus();

		console.log(chalk.bold("\nshared-things Status\n"));

		const api = new ApiClient(config.serverUrl, config.apiKey);
		let serverReachable = false;
		try {
			await api.health();
			serverReachable = true;
		} catch {}

		console.log(
			`  ${chalk.dim("Server:")}    ${config.serverUrl} ${serverReachable ? chalk.green("connected") : chalk.red("unreachable")}`,
		);
		console.log(
			`  ${chalk.dim("Target:")}    ${getSyncTarget(config)} (${config.syncMode || "project"})`,
		);
		console.log(
			`  ${chalk.dim("Mode:")}      event-driven (file watcher + WebSocket)`,
		);
		console.log(
			`  ${chalk.dim("Daemon:")}    ${daemonStatus === "running" ? chalk.green("running") : chalk.red(daemonStatus)}`,
		);

		const statePath = path.join(getConfigDir(), "state.json");
		if (fs.existsSync(statePath)) {
			try {
				const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
				const lastSync = new Date(state.lastSyncedAt);
				const ago = formatTimeAgo(lastSync);
				console.log(`  ${chalk.dim("Last sync:")} ${ago}`);
			} catch {}
		}

		const conflicts = readConflicts();
		if (conflicts.length > 0) {
			console.log(
				`  ${chalk.dim("Conflicts:")} ${chalk.yellow(String(conflicts.length))}`,
			);
		}
		console.log();
	});

// =============================================================================
// sync
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
				console.log(chalk.yellow("Sync skipped (another sync is running)."));
				return;
			}
			if (result.isFirstSync) console.log(chalk.cyan("First sync completed!"));
			console.log(
				chalk.green(
					`Done! Pushed: ${result.pushed}, Pulled: ${result.pulled}, Conflicts: ${result.conflicts}`,
				),
			);
		} catch (error) {
			logError("Manual sync failed", error);
			console.error(chalk.red(`Sync failed: ${error}`));
			process.exit(1);
		}
	});

// =============================================================================
// daemon (internal, run by launchd)
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
		const daemon = new Daemon(config);
		await daemon.start();

		// Keep process alive
		await new Promise(() => {});
	});

// =============================================================================
// logs
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
// reset
// =============================================================================
program
	.command("reset")
	.description("Reset sync state")
	.option("--local", "Clear local state")
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

		const config = loadConfig()!;

		if (options.local) {
			try {
				const target = getSyncTarget(config);
				const todos =
					config.syncMode === "area" && config.areaName
						? getTodosFromArea(config.areaName)
						: getTodosFromProject(config.projectName!);
				if (todos.length > 0) {
					console.error(
						chalk.red(`"${target}" must be empty to reset local state.`),
					);
					return;
				}
			} catch (error) {
				console.error(chalk.red(`Failed to read Things project: ${error}`));
				return;
			}
		}

		const confirmed = await confirm({
			message: "This cannot be undone. Continue?",
			default: false,
		});
		if (!confirmed) {
			console.log(chalk.dim("Cancelled."));
			return;
		}

		if (options.server) {
			const api = new ApiClient(config.serverUrl, config.apiKey);
			try {
				const result = await api.reset();
				logInfo(`Server reset: deleted ${result.deleted.todos} todos`);
				console.log(
					chalk.green(`Server data deleted (${result.deleted.todos} todos)`),
				);
			} catch (error) {
				logError("Server reset failed", error);
				console.error(chalk.red(`Failed: ${error}`));
				return;
			}
		}

		if (options.local) {
			const statePath = path.join(getConfigDir(), "state.json");
			if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
			const conflictsPath = path.join(getConfigDir(), "conflicts.json");
			if (fs.existsSync(conflictsPath)) fs.unlinkSync(conflictsPath);
			writeInitialState();
			logInfo("Local state reset");
		}

		console.log(
			chalk.green('Reset complete. Run "shared-things sync" for a fresh sync.'),
		);
	});

// =============================================================================
// conflicts
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
		console.log(chalk.bold(`\nConflicts (${shown.length})\n`));
		for (const c of shown) {
			console.log(
				`${chalk.dim(c.timestamp)} ${chalk.white(c.title)} (${c.serverId})`,
			);
			console.log(`  ${chalk.dim("Reason:")} ${c.reason}`);
			if (c.yourVersion.editedAt || c.yourVersion.deletedAt) {
				console.log(
					`  ${chalk.dim("Yours:")} ${c.yourVersion.deletedAt ? `deleted at ${c.yourVersion.deletedAt}` : `edited at ${c.yourVersion.editedAt}`}`,
				);
			}
			if (c.winningVersion.editedAt || c.winningVersion.deletedAt) {
				console.log(
					`  ${chalk.dim("Winner:")} ${c.winningVersion.deletedAt ? `deleted at ${c.winningVersion.deletedAt}` : `edited at ${c.winningVersion.editedAt}`}`,
				);
			}
			console.log();
		}
	});

// =============================================================================
// doctor
// =============================================================================
program
	.command("doctor")
	.description("Comprehensive health check")
	.action(async () => {
		console.log(chalk.bold("\nshared-things Doctor\n"));

		if (!configExists()) {
			console.log(chalk.red("  Config: missing (run init)"));
			return;
		}

		const config = loadConfig()!;
		console.log(chalk.green("  Config: ok"));

		const statePath = path.join(getConfigDir(), "state.json");
		console.log(
			fs.existsSync(statePath)
				? chalk.green("  State: ok")
				: chalk.red("  State: missing"),
		);

		console.log(
			isThingsRunning()
				? chalk.green("  Things 3: running")
				: chalk.yellow("  Things 3: not running"),
		);

		const target = getSyncTarget(config);
		if (config.syncMode === "area") {
			const areas = listAreas();
			console.log(
				areas.includes(target)
					? chalk.green(`  Area: ${target}`)
					: chalk.red(`  Area: "${target}" not found`),
			);
		} else {
			const projects = listProjects();
			console.log(
				projects.includes(target)
					? chalk.green(`  Project: ${target}`)
					: chalk.red(`  Project: "${target}" not found`),
			);
		}

		const api = new ApiClient(config.serverUrl, config.apiKey);
		try {
			await api.health();
			console.log(chalk.green("  Server: reachable"));
		} catch {
			console.log(chalk.red("  Server: unreachable"));
		}

		console.log(chalk.green(`  Daemon: ${getLaunchAgentStatus()}`));
		console.log();
	});

// =============================================================================
// update
// =============================================================================
program
	.command("update")
	.description("Pull latest changes, rebuild, and restart daemon")
	.option("--reset", "Also reset state (keeps config, re-syncs from server)")
	.action(async (options) => {
		const { execSync: exec } = await import("node:child_process");

		// Find repo root from the CLI script location
		// dist/cli.js -> packages/daemon/dist/cli.js -> ../../.. = repo root
		const cliPath = new URL(import.meta.url).pathname;
		let repoRoot = path.dirname(cliPath);
		// Walk up until we find pnpm-workspace.yaml
		for (let i = 0; i < 5; i++) {
			if (fs.existsSync(path.join(repoRoot, "pnpm-workspace.yaml"))) break;
			repoRoot = path.dirname(repoRoot);
		}
		if (!fs.existsSync(path.join(repoRoot, "pnpm-workspace.yaml"))) {
			console.error(
				chalk.red("Could not find repo root. Are you running from the repo?"),
			);
			process.exit(1);
		}

		// 1. Stop daemon
		const wasRunning = getLaunchAgentStatus() === "running";
		if (wasRunning) {
			console.log(chalk.dim("Stopping daemon..."));
			try {
				stopLaunchAgent();
			} catch {}
		}

		// 2. Git pull
		console.log(chalk.dim("Pulling latest changes..."));
		try {
			const pullOutput = exec("git pull", {
				cwd: repoRoot,
				encoding: "utf-8",
			}).trim();
			if (pullOutput.includes("Already up to date")) {
				console.log(`  ${chalk.green("Already up to date")}`);
			} else {
				console.log(`  ${chalk.green("Updated")}`);
			}
		} catch (error) {
			console.error(chalk.red(`Git pull failed: ${error}`));
			process.exit(1);
		}

		// 3. Build
		console.log(chalk.dim("Building..."));
		try {
			exec("pnpm install --frozen-lockfile 2>/dev/null || pnpm install", {
				cwd: repoRoot,
				stdio: "pipe",
			});
			exec("pnpm build", { cwd: repoRoot, stdio: "pipe" });
			console.log(`  ${chalk.green("Build complete")}`);
		} catch (error) {
			console.error(chalk.red(`Build failed: ${error}`));
			process.exit(1);
		}

		// 4. Reset state if requested (keeps config)
		if (options.reset) {
			console.log(chalk.dim("Resetting state..."));
			const configDir = getConfigDir();
			for (const file of ["state.json", "conflicts.json", "sync.log"]) {
				const p = path.join(configDir, file);
				if (fs.existsSync(p)) fs.unlinkSync(p);
			}
			writeInitialState();
			console.log(`  ${chalk.green("State reset (config preserved)")}`);
		}

		// 5. Check if config needs new fields
		if (configExists()) {
			const config = loadConfig()!;
			let configChanged = false;

			if (!config.syncMode) {
				config.syncMode = "project";
				configChanged = true;
			}
			if (
				config.fallbackPollIntervalSeconds === undefined ||
				config.fallbackPollIntervalSeconds === null
			) {
				config.fallbackPollIntervalSeconds = 60;
				configChanged = true;
			}

			if (configChanged) {
				saveConfig(config);
				console.log(`  ${chalk.yellow("Config migrated with new defaults")}`);
			}
		}

		// 6. Restart daemon
		if (wasRunning || options.reset) {
			console.log(chalk.dim("Starting daemon..."));
			installLaunchAgent();
		}

		console.log(chalk.green("\nUpdate complete!\n"));
	});

// =============================================================================
// helpers
// =============================================================================
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

program.parse();
