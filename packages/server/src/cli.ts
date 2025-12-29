#!/usr/bin/env node
/**
 * shared-things-server CLI
 */

import { Command } from 'commander';
import { input, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { initDatabase, createUser, listUsers, userExists, getAllTodos, getAllHeadings, type DB } from './db.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { authMiddleware } from './auth.js';
import { registerRoutes } from './routes.js';

// Data directory for server files
const DATA_DIR = process.env.DATA_DIR || path.join(os.homedir(), '.shared-things-server');
const PID_FILE = path.join(DATA_DIR, 'server.pid');
const LOG_FILE = path.join(DATA_DIR, 'server.log');

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function isServerRunning(): { running: boolean; pid?: number } {
  if (!fs.existsSync(PID_FILE)) {
    return { running: false };
  }

  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);

  try {
    // Check if process exists (signal 0 doesn't kill, just checks)
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    // Process doesn't exist, clean up stale PID file
    fs.unlinkSync(PID_FILE);
    return { running: false };
  }
}

const program = new Command();

program
  .name('shared-things-server')
  .description('Sync server for Things 3 projects')
  .version('0.1.0');

// =============================================================================
// start command
// =============================================================================
program
  .command('start')
  .description('Start the sync server')
  .option('-p, --port <port>', 'Port to listen on', '3334')
  .option('--host <host>', 'Host to bind to', '0.0.0.0')
  .option('-d, --detach', 'Run server in background (detached mode)')
  .action(async (options) => {
    const PORT = parseInt(options.port, 10);
    const HOST = options.host;
    const isChildProcess = process.env.SHARED_THINGS_DETACHED === '1';

    // Check if already running (skip for child process)
    if (!isChildProcess) {
      const status = isServerRunning();
      if (status.running) {
        console.log(chalk.yellow(`\n⚠️  Server already running (PID: ${status.pid})`));
        console.log(chalk.dim('Use "shared-things-server stop" to stop it first.\n'));
        return;
      }
    }

    // Detached mode: spawn new process in background
    if (options.detach) {
      ensureDataDir();

      // Open log file for stdout/stderr
      const logFd = fs.openSync(LOG_FILE, 'a');

      // Find the CLI script path
      const scriptPath = process.argv[1];

      const child = spawn(process.execPath, [scriptPath, 'start', '--port', String(PORT), '--host', HOST], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: { ...process.env, SHARED_THINGS_DETACHED: '1' },
      });

      // Write PID file
      fs.writeFileSync(PID_FILE, String(child.pid));

      child.unref();
      fs.closeSync(logFd);

      console.log(chalk.green(`\n✅ Server started in background`));
      console.log(`  ${chalk.dim('PID:')}  ${child.pid}`);
      console.log(`  ${chalk.dim('URL:')}  http://${HOST}:${PORT}`);
      console.log(`  ${chalk.dim('Logs:')} ${LOG_FILE}`);
      console.log(chalk.dim('\nUse "shared-things-server logs -f" to follow logs'));
      console.log(chalk.dim('Use "shared-things-server stop" to stop the server\n'));
      return;
    }

    // Foreground mode
    const db = initDatabase();

    // In detached mode, use simple logger (no pino-pretty transport)
    const app = Fastify({
      logger: isChildProcess ? true : true,
    });

    await app.register(cors, {
      origin: true,
    });

    app.addHook('preHandler', authMiddleware(db));
    registerRoutes(app, db);

    // Handle graceful shutdown
    const shutdown = async () => {
      console.log(chalk.dim('\nShutting down...'));
      await app.close();
      if (fs.existsSync(PID_FILE)) {
        fs.unlinkSync(PID_FILE);
      }
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    try {
      await app.listen({ port: PORT, host: HOST });
      if (!process.env.SHARED_THINGS_DETACHED) {
        console.log(chalk.green(`\n✅ Server running at http://${HOST}:${PORT}\n`));
      }
    } catch (err) {
      app.log.error(err);
      process.exit(1);
    }
  });

// =============================================================================
// stop command
// =============================================================================
program
  .command('stop')
  .description('Stop the background server')
  .action(() => {
    const status = isServerRunning();

    if (!status.running) {
      console.log(chalk.yellow('\n⚠️  Server is not running.\n'));
      return;
    }

    try {
      process.kill(status.pid!, 'SIGTERM');
      // Wait a bit for graceful shutdown
      setTimeout(() => {
        if (fs.existsSync(PID_FILE)) {
          fs.unlinkSync(PID_FILE);
        }
      }, 500);
      console.log(chalk.green(`\n✅ Server stopped (PID: ${status.pid})\n`));
    } catch (err) {
      console.log(chalk.red(`\n❌ Failed to stop server: ${err}\n`));
    }
  });

// =============================================================================
// status command
// =============================================================================
program
  .command('status')
  .description('Show server status')
  .action(() => {
    const status = isServerRunning();

    console.log(chalk.bold('\n📊 Server Status\n'));

    if (status.running) {
      console.log(`  ${chalk.dim('Status:')} ${chalk.green('● running')}`);
      console.log(`  ${chalk.dim('PID:')}    ${status.pid}`);
    } else {
      console.log(`  ${chalk.dim('Status:')} ${chalk.red('○ stopped')}`);
    }

    // Show log file info
    if (fs.existsSync(LOG_FILE)) {
      const stats = fs.statSync(LOG_FILE);
      const sizeKB = Math.round(stats.size / 1024);
      console.log(`  ${chalk.dim('Logs:')}   ${LOG_FILE} (${sizeKB}KB)`);
    }

    // Show database info
    const dbPath = path.join(DATA_DIR, 'data.db');
    if (fs.existsSync(dbPath)) {
      const db = initDatabase();
      const users = listUsers(db);
      const todos = getAllTodos(db);
      console.log(`  ${chalk.dim('Users:')}  ${users.length}`);
      console.log(`  ${chalk.dim('Todos:')}  ${todos.length}`);
    }

    console.log();
  });

// =============================================================================
// logs command
// =============================================================================
program
  .command('logs')
  .description('Show server logs')
  .option('-f, --follow', 'Follow log output')
  .option('-n, --lines <count>', 'Number of lines to show', '50')
  .action((options) => {
    if (!fs.existsSync(LOG_FILE)) {
      console.log(chalk.yellow('\nNo logs yet.\n'));
      return;
    }

    if (options.follow) {
      console.log(chalk.dim(`Following ${LOG_FILE}... (Ctrl+C to stop)\n`));
      const tail = spawn('tail', ['-f', LOG_FILE], { stdio: 'inherit' });
      process.on('SIGINT', () => {
        tail.kill();
        process.exit(0);
      });
    } else {
      const tail = spawn('tail', ['-n', options.lines, LOG_FILE], { stdio: 'inherit' });
      tail.on('close', () => process.exit(0));
    }
  });

// =============================================================================
// create-user command
// =============================================================================
program
  .command('create-user')
  .description('Create a new user and generate API key')
  .option('-n, --name <name>', 'Username')
  .action(async (options) => {
    const db = initDatabase();

    let name = options.name;

    if (!name) {
      // Interactive mode
      console.log(chalk.bold('\n👤 Create New User\n'));

      name = await input({
        message: 'Username',
        validate: (value) => {
          if (!value.trim()) return 'Username is required';
          if (userExists(db, value.trim())) return `User "${value.trim()}" already exists`;
          return true;
        },
      });
    }

    // Check if user exists (for non-interactive mode)
    if (userExists(db, name.trim())) {
      console.log(chalk.red(`\n❌ User "${name.trim()}" already exists.\n`));
      process.exit(1);
    }

    const { id, apiKey } = createUser(db, name.trim());

    console.log(chalk.green('\n✅ User created successfully!\n'));
    console.log(`  ${chalk.dim('ID:')}       ${id}`);
    console.log(`  ${chalk.dim('Name:')}     ${name}`);
    console.log(`  ${chalk.dim('API Key:')}  ${chalk.cyan(apiKey)}`);
    console.log(chalk.yellow('\n⚠️  Save this API key - it cannot be retrieved later!\n'));
  });

// =============================================================================
// list-users command
// =============================================================================
program
  .command('list-users')
  .description('List all users')
  .action(async () => {
    const db = initDatabase();
    const users = listUsers(db);

    if (users.length === 0) {
      console.log(chalk.yellow('\nNo users found.\n'));
      console.log(chalk.dim('Create a user with: shared-things-server create-user\n'));
    } else {
      console.log(chalk.bold(`\n👥 Users (${users.length})\n`));
      for (const user of users) {
        console.log(`  ${chalk.white(user.name)} ${chalk.dim(`(${user.id})`)}`);
        console.log(`    ${chalk.dim('Created:')} ${user.createdAt}`);
      }
      console.log();
    }
  });

// =============================================================================
// delete-user command
// =============================================================================
program
  .command('delete-user')
  .description('Delete a user')
  .option('-n, --name <name>', 'Username to delete')
  .action(async (options) => {
    const db = initDatabase();
    const users = listUsers(db);

    if (users.length === 0) {
      console.log(chalk.yellow('\nNo users to delete.\n'));
      return;
    }

    let name = options.name;

    if (!name) {
      // Show users and ask which to delete
      console.log(chalk.bold('\n🗑️  Delete User\n'));
      console.log('Available users:');
      for (const user of users) {
        console.log(`  - ${user.name}`);
      }
      console.log();

      name = await input({
        message: 'Username to delete',
        validate: (value) => {
          if (!value.trim()) return 'Username is required';
          if (!users.find(u => u.name === value.trim())) return 'User not found';
          return true;
        },
      });
    }

    const user = users.find(u => u.name === name);
    if (!user) {
      console.log(chalk.red(`\n❌ User "${name}" not found.\n`));
      return;
    }

    const confirmed = await confirm({
      message: `Delete user "${name}"? This will also delete all their data.`,
      default: false,
    });

    if (!confirmed) {
      console.log(chalk.dim('Cancelled.'));
      return;
    }

    // Delete user and their data
    db.prepare('DELETE FROM todos WHERE updated_by = ?').run(user.id);
    db.prepare('DELETE FROM headings WHERE updated_by = ?').run(user.id);
    db.prepare('DELETE FROM deleted_items WHERE deleted_by = ?').run(user.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);

    console.log(chalk.green(`\n✅ User "${name}" deleted.\n`));
  });

// =============================================================================
// list-todos command
// =============================================================================
program
  .command('list-todos')
  .description('List all todos')
  .option('-u, --user <name>', 'Filter by username')
  .action(async (options) => {
    const db = initDatabase();
    const todos = getAllTodos(db);
    const users = listUsers(db);

    // Create user lookup map
    const userMap = new Map(users.map(u => [u.id, u.name]));

    // Filter by user if specified
    let filteredTodos = todos;
    if (options.user) {
      const user = users.find(u => u.name === options.user);
      if (!user) {
        console.log(chalk.red(`\n❌ User "${options.user}" not found.\n`));
        return;
      }
      filteredTodos = todos.filter(t => t.updatedBy === user.id);
    }

    if (filteredTodos.length === 0) {
      console.log(chalk.yellow('\nNo todos found.\n'));
      return;
    }

    const title = options.user
      ? `📋 Todos by ${options.user} (${filteredTodos.length})`
      : `📋 Todos (${filteredTodos.length})`;
    console.log(chalk.bold(`\n${title}\n`));

    for (const todo of filteredTodos) {
      const userName = userMap.get(todo.updatedBy) || 'unknown';
      const statusIcon = todo.status === 'completed' ? '✓' : todo.status === 'canceled' ? '✗' : '○';
      const statusColor = todo.status === 'completed' ? chalk.green : todo.status === 'canceled' ? chalk.red : chalk.white;

      console.log(`  ${statusColor(statusIcon)} ${chalk.white(todo.title)}`);

      if (todo.notes) {
        const shortNotes = todo.notes.length > 50 ? todo.notes.substring(0, 50) + '...' : todo.notes;
        console.log(`    ${chalk.dim('Notes:')} ${shortNotes}`);
      }
      if (todo.dueDate) {
        console.log(`    ${chalk.dim('Due:')} ${todo.dueDate}`);
      }
      if (todo.tags && todo.tags.length > 0) {
        console.log(`    ${chalk.dim('Tags:')} ${todo.tags.join(', ')}`);
      }
      console.log(`    ${chalk.dim('Status:')} ${todo.status} ${chalk.dim('|')} ${chalk.dim('By:')} ${userName} ${chalk.dim('|')} ${todo.updatedAt}`);
      console.log();
    }
  });

// =============================================================================
// reset command
// =============================================================================
program
  .command('reset')
  .description('Delete all todos and headings (keeps users)')
  .action(async () => {
    const db = initDatabase();

    const todos = getAllTodos(db);
    const headings = getAllHeadings(db);

    if (todos.length === 0 && headings.length === 0) {
      console.log(chalk.yellow('\nNo data to reset.\n'));
      return;
    }

    console.log(chalk.bold('\n🔄 Reset Server Data\n'));
    console.log(`  ${chalk.dim('Todos:')} ${todos.length}`);
    console.log(`  ${chalk.dim('Headings:')} ${headings.length}`);
    console.log();

    const confirmed = await confirm({
      message: 'Delete all todos and headings? Users will be kept.',
      default: false,
    });

    if (!confirmed) {
      console.log(chalk.dim('Cancelled.'));
      return;
    }

    db.prepare('DELETE FROM todos').run();
    db.prepare('DELETE FROM headings').run();
    db.prepare('DELETE FROM deleted_items').run();

    console.log(chalk.green('\n✅ All todos and headings deleted. Users preserved.\n'));
  });

// =============================================================================
// purge command
// =============================================================================
program
  .command('purge')
  .description('Delete entire database (all data including users)')
  .action(async () => {
    const dataDir = process.env.DATA_DIR || path.join(os.homedir(), '.shared-things-server');
    const dbPath = path.join(dataDir, 'data.db');

    if (!fs.existsSync(dbPath)) {
      console.log(chalk.yellow('\nNo database to purge.\n'));
      return;
    }

    console.log(chalk.bold('\n⚠️  Purge Server\n'));
    console.log(`  ${chalk.dim('Database:')} ${dbPath}`);
    console.log();

    const confirmed = await confirm({
      message: 'Delete the entire database? This cannot be undone!',
      default: false,
    });

    if (!confirmed) {
      console.log(chalk.dim('Cancelled.'));
      return;
    }

    // Delete database files (including WAL and SHM)
    fs.unlinkSync(dbPath);
    if (fs.existsSync(dbPath + '-wal')) fs.unlinkSync(dbPath + '-wal');
    if (fs.existsSync(dbPath + '-shm')) fs.unlinkSync(dbPath + '-shm');

    console.log(chalk.green('\n✅ Database deleted. Run "shared-things-server create-user" to start fresh.\n'));
  });

program.parse();
