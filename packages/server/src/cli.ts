#!/usr/bin/env node

/**
 * shared-things-server CLI (v3)
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { confirm, input } from "@inquirer/prompts";
import chalk from "chalk";
import { Command } from "commander";
import {
	createUser,
	getAllTodos,
	getAllTodosWithMeta,
	initDatabase,
	listUsers,
	userExists,
} from "./db.js";

const DATA_DIR =
	process.env.DATA_DIR || path.join(os.homedir(), ".shared-things-server");
const PID_FILE = path.join(DATA_DIR, "server.pid");
const LOG_FILE = path.join(DATA_DIR, "server.log");

function ensureDataDir(): void {
	if (!fs.existsSync(DATA_DIR)) {
		fs.mkdirSync(DATA_DIR, { recursive: true });
	}
}

function isServerRunning(): { running: boolean; pid?: number } {
	if (!fs.existsSync(PID_FILE)) {
		return { running: false };
	}

	const pid = Number.parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);

	try {
		process.kill(pid, 0);
		return { running: true, pid };
	} catch {
		fs.unlinkSync(PID_FILE);
		return { running: false };
	}
}

const program = new Command();

program
	.name("shared-things-server")
	.description("Sync server for Things 3 projects (v3)")
	.version("3.0.0");

// =============================================================================
// start
// =============================================================================
program
	.command("start")
	.description("Start the sync server")
	.option("-p, --port <port>", "Port to listen on", "3334")
	.option("--host <host>", "Host to bind to", "0.0.0.0")
	.option("-d, --detach", "Run server in background")
	.action(async (options) => {
		const PORT = Number.parseInt(options.port, 10);
		const HOST = options.host;
		const isChildProcess = process.env.SHARED_THINGS_DETACHED === "1";

		if (!isChildProcess) {
			const status = isServerRunning();
			if (status.running) {
				console.log(
					chalk.yellow(`\nServer already running (PID: ${status.pid})`),
				);
				return;
			}
		}

		if (options.detach) {
			ensureDataDir();
			const logFd = fs.openSync(LOG_FILE, "a");
			const scriptPath = process.argv[1];

			const child = spawn(
				process.execPath,
				[scriptPath, "start", "--port", String(PORT), "--host", HOST],
				{
					detached: true,
					stdio: ["ignore", logFd, logFd],
					env: { ...process.env, SHARED_THINGS_DETACHED: "1" },
				},
			);

			fs.writeFileSync(PID_FILE, String(child.pid));
			child.unref();
			fs.closeSync(logFd);

			console.log(chalk.green("\nServer started in background"));
			console.log(`  ${chalk.dim("PID:")}  ${child.pid}`);
			console.log(`  ${chalk.dim("URL:")}  http://${HOST}:${PORT}`);
			console.log(`  ${chalk.dim("Logs:")} ${LOG_FILE}\n`);
			return;
		}

		// Foreground mode
		const { createServer } = await import("./index.js");
		const { app, wsManager } = await createServer({
			port: PORT,
			host: HOST,
			logger: !isChildProcess,
		});

		const shutdown = async () => {
			console.log(chalk.dim("\nShutting down..."));
			wsManager.close();
			await app.close();
			if (fs.existsSync(PID_FILE)) {
				fs.unlinkSync(PID_FILE);
			}
			process.exit(0);
		};
		process.on("SIGTERM", shutdown);
		process.on("SIGINT", shutdown);

		if (!isChildProcess) {
			console.log(chalk.green(`\nServer running at http://${HOST}:${PORT}\n`));
		}
	});

// =============================================================================
// stop
// =============================================================================
program
	.command("stop")
	.description("Stop the background server")
	.action(() => {
		const status = isServerRunning();
		if (!status.running) {
			console.log(chalk.yellow("\nServer is not running.\n"));
			return;
		}

		try {
			process.kill(status.pid!, "SIGTERM");
			setTimeout(() => {
				if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
			}, 500);
			console.log(chalk.green(`\nServer stopped (PID: ${status.pid})\n`));
		} catch (err) {
			console.log(chalk.red(`\nFailed to stop server: ${err}\n`));
		}
	});

// =============================================================================
// status
// =============================================================================
program
	.command("status")
	.description("Show server status")
	.action(() => {
		const status = isServerRunning();

		console.log(chalk.bold("\nServer Status\n"));

		if (status.running) {
			console.log(`  ${chalk.dim("Status:")}  ${chalk.green("running")}`);
			console.log(`  ${chalk.dim("PID:")}     ${status.pid}`);
		} else {
			console.log(`  ${chalk.dim("Status:")}  ${chalk.red("stopped")}`);
		}

		if (fs.existsSync(LOG_FILE)) {
			const stats = fs.statSync(LOG_FILE);
			const sizeKB = Math.round(stats.size / 1024);
			console.log(`  ${chalk.dim("Logs:")}    ${LOG_FILE} (${sizeKB}KB)`);
		}

		const dbPath = path.join(DATA_DIR, "data.db");
		if (fs.existsSync(dbPath)) {
			const db = initDatabase();
			const users = listUsers(db);
			const todos = getAllTodos(db);
			console.log(`  ${chalk.dim("Users:")}   ${users.length}`);
			console.log(`  ${chalk.dim("Todos:")}   ${todos.length}`);
		}

		console.log();
	});

// =============================================================================
// logs
// =============================================================================
program
	.command("logs")
	.description("Show server logs")
	.option("-f, --follow", "Follow log output")
	.option("-n, --lines <count>", "Number of lines to show", "50")
	.action((options) => {
		if (!fs.existsSync(LOG_FILE)) {
			console.log(chalk.yellow("\nNo logs yet.\n"));
			return;
		}

		if (options.follow) {
			console.log(chalk.dim(`Following ${LOG_FILE}... (Ctrl+C to stop)\n`));
			const tail = spawn("tail", ["-f", LOG_FILE], { stdio: "inherit" });
			process.on("SIGINT", () => {
				tail.kill();
				process.exit(0);
			});
		} else {
			const tail = spawn("tail", ["-n", options.lines, LOG_FILE], {
				stdio: "inherit",
			});
			tail.on("close", () => process.exit(0));
		}
	});

// =============================================================================
// create-user
// =============================================================================
program
	.command("create-user")
	.description("Create a new user and generate API key")
	.option("-n, --name <name>", "Username")
	.action(async (options) => {
		const db = initDatabase();
		let name = options.name;

		if (!name) {
			console.log(chalk.bold("\nCreate New User\n"));
			name = await input({
				message: "Username",
				validate: (value) => {
					if (!value.trim()) return "Username is required";
					if (userExists(db, value.trim()))
						return `User "${value.trim()}" already exists`;
					return true;
				},
			});
		}

		if (userExists(db, name.trim())) {
			console.log(chalk.red(`\nUser "${name.trim()}" already exists.\n`));
			process.exit(1);
		}

		const { id, apiKey } = createUser(db, name.trim());

		console.log(chalk.green("\nUser created!\n"));
		console.log(`  ${chalk.dim("ID:")}       ${id}`);
		console.log(`  ${chalk.dim("Name:")}     ${name}`);
		console.log(`  ${chalk.dim("API Key:")}  ${chalk.cyan(apiKey)}`);
		console.log(
			chalk.yellow("\nSave this API key - it cannot be retrieved later!\n"),
		);
	});

// =============================================================================
// list-users
// =============================================================================
program
	.command("list-users")
	.description("List all users")
	.action(() => {
		const db = initDatabase();
		const users = listUsers(db);

		if (users.length === 0) {
			console.log(chalk.yellow("\nNo users found.\n"));
			return;
		}

		console.log(chalk.bold(`\nUsers (${users.length})\n`));
		for (const user of users) {
			console.log(`  ${chalk.white(user.name)} ${chalk.dim(`(${user.id})`)}`);
			console.log(`    ${chalk.dim("Created:")} ${user.createdAt}`);
		}
		console.log();
	});

// =============================================================================
// delete-user
// =============================================================================
program
	.command("delete-user")
	.description("Delete a user and their data")
	.option("-n, --name <name>", "Username to delete")
	.action(async (options) => {
		const db = initDatabase();
		const users = listUsers(db);

		if (users.length === 0) {
			console.log(chalk.yellow("\nNo users to delete.\n"));
			return;
		}

		let name = options.name;
		if (!name) {
			console.log(chalk.bold("\nDelete User\n"));
			for (const user of users) {
				console.log(`  - ${user.name}`);
			}
			console.log();

			name = await input({
				message: "Username to delete",
				validate: (value) => {
					if (!value.trim()) return "Username is required";
					if (!users.find((u) => u.name === value.trim()))
						return "User not found";
					return true;
				},
			});
		}

		const user = users.find((u) => u.name === name);
		if (!user) {
			console.log(chalk.red(`\nUser "${name}" not found.\n`));
			return;
		}

		const confirmed = await confirm({
			message: `Delete user "${name}" and all their data?`,
			default: false,
		});

		if (!confirmed) {
			console.log(chalk.dim("Cancelled."));
			return;
		}

		db.prepare("DELETE FROM todos WHERE updated_by = ? OR created_by = ?").run(
			user.id,
			user.id,
		);
		db.prepare("DELETE FROM deleted_items WHERE deleted_by = ?").run(user.id);
		db.prepare("DELETE FROM users WHERE id = ?").run(user.id);

		console.log(chalk.green(`\nUser "${name}" deleted.\n`));
	});

// =============================================================================
// list-todos
// =============================================================================
program
	.command("list-todos")
	.description("List all todos")
	.option("-u, --user <name>", "Filter by username")
	.action((options) => {
		const db = initDatabase();
		const todos = getAllTodosWithMeta(db);
		const users = listUsers(db);
		const userMap = new Map(users.map((u) => [u.id, u.name]));

		let filtered = todos;
		if (options.user) {
			const user = users.find((u) => u.name === options.user);
			if (!user) {
				console.log(chalk.red(`\nUser "${options.user}" not found.\n`));
				return;
			}
			filtered = todos.filter((t) => t.updatedBy === user.id);
		}

		if (filtered.length === 0) {
			console.log(chalk.yellow("\nNo todos found.\n"));
			return;
		}

		console.log(chalk.bold(`\nTodos (${filtered.length})\n`));
		for (const todo of filtered) {
			const userName = userMap.get(todo.updatedBy) || "unknown";
			const icon =
				todo.status === "completed"
					? chalk.green("v")
					: todo.status === "canceled"
						? chalk.red("x")
						: chalk.white("o");

			console.log(`  ${icon} ${chalk.white(todo.title)}`);
			if (todo.notes) {
				const short =
					todo.notes.length > 50
						? `${todo.notes.substring(0, 50)}...`
						: todo.notes;
				console.log(`    ${chalk.dim("Notes:")} ${short}`);
			}
			if (todo.dueDate) console.log(`    ${chalk.dim("Due:")} ${todo.dueDate}`);
			if (todo.tags?.length)
				console.log(`    ${chalk.dim("Tags:")} ${todo.tags.join(", ")}`);
			console.log(
				`    ${chalk.dim(`${todo.status} | By: ${userName} | ${todo.updatedAt}`)}`,
			);
			console.log();
		}
	});

// =============================================================================
// reset
// =============================================================================
program
	.command("reset")
	.description("Delete all todos (keeps users)")
	.action(async () => {
		const db = initDatabase();
		const todos = getAllTodos(db);

		if (todos.length === 0) {
			console.log(chalk.yellow("\nNo data to reset.\n"));
			return;
		}

		console.log(chalk.bold("\nReset Server Data\n"));
		console.log(`  ${chalk.dim("Todos:")} ${todos.length}\n`);

		const confirmed = await confirm({
			message: "Delete all todos? Users will be kept.",
			default: false,
		});

		if (!confirmed) {
			console.log(chalk.dim("Cancelled."));
			return;
		}

		db.prepare("DELETE FROM todos").run();
		db.prepare("DELETE FROM deleted_items").run();
		console.log(chalk.green("\nAll todos deleted. Users preserved.\n"));
	});

// =============================================================================
// purge
// =============================================================================
program
	.command("purge")
	.description("Delete entire database")
	.action(async () => {
		const dbPath = path.join(DATA_DIR, "data.db");

		if (!fs.existsSync(dbPath)) {
			console.log(chalk.yellow("\nNo database to purge.\n"));
			return;
		}

		console.log(chalk.bold("\nPurge Server\n"));
		console.log(`  ${chalk.dim("Database:")} ${dbPath}\n`);

		const confirmed = await confirm({
			message: "Delete the entire database? This cannot be undone!",
			default: false,
		});

		if (!confirmed) {
			console.log(chalk.dim("Cancelled."));
			return;
		}

		fs.unlinkSync(dbPath);
		if (fs.existsSync(`${dbPath}-wal`)) fs.unlinkSync(`${dbPath}-wal`);
		if (fs.existsSync(`${dbPath}-shm`)) fs.unlinkSync(`${dbPath}-shm`);

		console.log(chalk.green("\nDatabase deleted.\n"));
	});

program.parse();
