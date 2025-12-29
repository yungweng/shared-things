#!/usr/bin/env node
/**
 * shared-things-server CLI
 */

import { Command } from 'commander';
import { input, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { initDatabase, createUser, listUsers, userExists, type DB } from './db.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { authMiddleware } from './auth.js';
import { registerRoutes } from './routes.js';

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
  .option('-h, --host <host>', 'Host to bind to', '0.0.0.0')
  .action(async (options) => {
    const db = initDatabase();
    const PORT = parseInt(options.port, 10);
    const HOST = options.host;

    const app = Fastify({
      logger: true,
    });

    await app.register(cors, {
      origin: true,
    });

    app.addHook('preHandler', authMiddleware(db));
    registerRoutes(app, db);

    try {
      await app.listen({ port: PORT, host: HOST });
      console.log(chalk.green(`\n✅ Server running at http://${HOST}:${PORT}\n`));
    } catch (err) {
      app.log.error(err);
      process.exit(1);
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

program.parse();
