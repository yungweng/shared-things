#!/usr/bin/env node
/**
 * shared-things CLI
 */

import { Command } from 'commander';
import { input, select, password, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import updateNotifier from 'update-notifier';
import { loadConfig, saveConfig, configExists, ensureConfigDir, getConfigDir } from './config.js';
import { listProjects, projectExists, isThingsRunning, getTodosFromProject } from './things.js';
import { ApiClient } from './api.js';
import { runSync } from './sync.js';
import { installLaunchAgent, uninstallLaunchAgent, getLaunchAgentStatus } from './launchagent.js';
import { log, logError, logDaemonStart, logDaemonStop } from './logger.js';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

// Check for updates with immediate feedback
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
const updateCheckInterval = 1000 * 60 * 60; // 1 hour

// updateNotifier() calls check() which loads cached update into notifier.update
// and clears the cache (by design - it's a one-time read)
const notifier = updateNotifier({ pkg, updateCheckInterval });

// Validate cached update against current version (user may have upgraded)
if (notifier.update) {
  notifier.update.current = pkg.version;
  // Clear if no longer outdated
  if (notifier.update.current === notifier.update.latest) {
    notifier.update = undefined;
  }
}

// Detect first run: lastUpdateCheck was just set by constructor (within last second)
const lastCheck = notifier.config?.get('lastUpdateCheck') ?? 0;
const isFirstRun = Date.now() - lastCheck < 1000;
const intervalPassed = Date.now() - lastCheck >= updateCheckInterval;

// Fetch immediately if no cached update and (first run OR interval passed)
// This fixes the 24h delay issue where check() skips spawning on first run
if (!notifier.update && (isFirstRun || intervalPassed)) {
  try {
    const update = await notifier.fetchInfo();
    notifier.config?.set('lastUpdateCheck', Date.now());
    if (update && update.type !== 'latest') {
      notifier.update = update;
    }
  } catch {
    // Ignore network errors
  }
}

// Re-cache update for next run (check() deleted it when reading)
// Only cache if there's actually an update available
if (notifier.update && notifier.update.current !== notifier.update.latest) {
  notifier.config?.set('update', notifier.update);
} else {
  notifier.config?.delete('update');
}

// Show notification on exit (bypasses TTY check that blocks notify())
process.on('exit', () => {
  if (notifier.update && notifier.update.current !== notifier.update.latest) {
    console.error(
      chalk.yellow(`\n  Update available: ${notifier.update.current} → ${notifier.update.latest}`) +
      chalk.dim(`\n  Run: npm i -g ${pkg.name}\n`)
    );
  }
});

const program = new Command();

program
  .name('shared-things')
  .description('Sync a Things 3 project between multiple users')
  .version(pkg.version);

// =============================================================================
// init command
// =============================================================================
program
  .command('init')
  .description('Setup wizard')
  .action(async () => {
    console.log('\n🔄 shared-things Setup\n');

    // Check if already configured
    if (configExists()) {
      const overwrite = await confirm({
        message: 'Configuration already exists. Overwrite?',
        default: false,
      });
      if (!overwrite) {
        console.log(chalk.dim('Cancelled.'));
        return;
      }
      // Delete old state to start fresh
      const statePath = path.join(getConfigDir(), 'state.json');
      if (fs.existsSync(statePath)) {
        fs.unlinkSync(statePath);
        console.log(chalk.dim('Old sync state cleared.\n'));
      }
    }

    // Check Things
    if (!isThingsRunning()) {
      console.log('⚠️  Things 3 is not running. Please start it first.\n');
    }

    // Step 1: Server URL
    const serverUrl = await input({
      message: 'Server URL',
      default: 'https://things.example.com',
      validate: (value) => {
        if (!value) return 'Server URL is required';
        if (!value.startsWith('http://') && !value.startsWith('https://')) {
          return 'URL must start with http:// or https://';
        }
        return true;
      },
    });

    // Step 2: API Key
    const apiKey = await password({
      message: 'API Key',
      mask: '*',
      validate: (value) => value ? true : 'API key is required',
    });

    // Verify connection and API key
    console.log('\n⏳ Verifying connection...');
    const api = new ApiClient(serverUrl, apiKey);
    try {
      await api.health();
      console.log('✅ Server reachable');
    } catch (error) {
      console.error(`❌ Failed to connect to server: ${error}`);
      process.exit(1);
    }

    // Verify API key by calling an authenticated endpoint
    console.log('⏳ Verifying API key...');
    try {
      await api.getState();
      console.log('✅ API key valid!\n');
    } catch (error) {
      console.error(`❌ Invalid API key: ${error}`);
      process.exit(1);
    }

    // Step 3: Select Things project
    const projects = listProjects();
    if (projects.length === 0) {
      console.error('❌ No Things projects found. Create a project in Things first.');
      process.exit(1);
    }

    const projectName = await select({
      message: 'Things project to sync',
      choices: projects.map(p => ({ name: p, value: p })),
    });

    // Verify project access
    console.log('\n⏳ Checking Things project...');
    const todos = getTodosFromProject(projectName);
    console.log(`✅ Found ${todos.length} todo${todos.length === 1 ? '' : 's'} in "${projectName}"\n`);

    // Step 4: Things Auth Token
    console.log('📋 Find your Things Auth Token in:');
    console.log('   Things → Settings → General → Things URLs → Manage\n');

    const thingsAuthToken = await password({
      message: 'Things Auth Token',
      mask: '*',
      validate: (value) => value ? true : 'Auth token is required for updating tasks',
    });

    console.log(chalk.yellow('\n⚠️  Auth token will be verified on first sync.\n'));

    // Save config
    saveConfig({
      serverUrl,
      apiKey,
      projectName,
      pollInterval: 30,
      thingsAuthToken,
    });

    console.log('\n✅ Configuration saved!\n');
    console.log('Next steps:');
    console.log('  1. Run "shared-things install" to start the daemon');
    console.log('  2. Or run "shared-things sync" for a one-time sync\n');
  });

// =============================================================================
// install command
// =============================================================================
program
  .command('install')
  .description('Install launchd daemon (auto-start at login)')
  .action(() => {
    if (!configExists()) {
      console.error('Not configured. Run "shared-things init" first.');
      process.exit(1);
    }
    installLaunchAgent();
  });

// =============================================================================
// uninstall command
// =============================================================================
program
  .command('uninstall')
  .description('Remove launchd daemon')
  .action(() => {
    uninstallLaunchAgent();
  });

// =============================================================================
// status command
// =============================================================================
program
  .command('status')
  .description('Show sync status')
  .action(async () => {
    if (!configExists()) {
      console.log(chalk.yellow('⚠️  Not configured'));
      console.log(chalk.dim('Run "shared-things init" to get started.'));
      return;
    }

    const config = loadConfig()!;
    const daemonStatus = getLaunchAgentStatus();
    const isRunning = daemonStatus === 'running';

    console.log(chalk.bold('\n📊 shared-things Status\n'));

    // Check server connectivity
    const api = new ApiClient(config.serverUrl, config.apiKey);
    let serverReachable = false;
    try {
      await api.health();
      serverReachable = true;
    } catch {
      serverReachable = false;
    }

    console.log(`${chalk.dim('Server:')}    ${chalk.cyan(config.serverUrl)} ${serverReachable ? chalk.green('●') : chalk.red('○')}`);
    console.log(`${chalk.dim('Project:')}   ${chalk.white(config.projectName)}`);
    console.log(`${chalk.dim('Interval:')}  ${config.pollInterval}s`);
    console.log(`${chalk.dim('Daemon:')}    ${isRunning ? chalk.green('● running') : chalk.red('○ stopped')}`)

    // Show last sync time
    const statePath = path.join(getConfigDir(), 'state.json');
    if (fs.existsSync(statePath)) {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      const lastSync = new Date(state.lastSyncedAt);
      const ago = formatTimeAgo(lastSync);
      console.log(`${chalk.dim('Last sync:')} ${ago}`);
    } else {
      console.log(`${chalk.dim('Last sync:')} ${chalk.yellow('never')}`);
    }
    console.log();
  });

// Helper to format relative time
function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
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
  .command('sync')
  .description('Manual one-time sync')
  .action(async () => {
    if (!configExists()) {
      console.error('Not configured. Run "shared-things init" first.');
      process.exit(1);
    }

    try {
      const result = await runSync();
      if (result.isFirstSync) {
        console.log(chalk.cyan('📥 First sync completed!'));
      }
      console.log(chalk.green(`✅ Done! Pushed: ${result.pushed}, Pulled: ${result.pulled}`));
    } catch (error) {
      logError('Manual sync failed', error);
      console.error(chalk.red(`❌ Sync failed: ${error}`));
      process.exit(1);
    }
  });

// =============================================================================
// daemon command (internal, run by launchd)
// =============================================================================
program
  .command('daemon')
  .description('Run sync daemon (used by launchd)')
  .action(async () => {
    if (!configExists()) {
      console.error('Not configured. Run "shared-things init" first.');
      process.exit(1);
    }

    const config = loadConfig()!;
    logDaemonStart();
    log(`Polling interval: ${config.pollInterval}s`);
    console.log(`Daemon started. Syncing every ${config.pollInterval}s...`);

    // Handle graceful shutdown
    const shutdown = () => {
      logDaemonStop();
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    // Initial sync
    try {
      await runSync();
      log('Initial sync complete');
    } catch (error) {
      logError('Initial sync failed', error);
    }

    // Poll loop
    setInterval(async () => {
      try {
        await runSync();
      } catch (error) {
        logError('Sync failed', error);
      }
    }, config.pollInterval * 1000);
  });

// =============================================================================
// logs command
// =============================================================================
program
  .command('logs')
  .description('Show daemon logs')
  .option('-f, --follow', 'Follow log output')
  .action((options) => {
    const logPath = path.join(getConfigDir(), 'daemon.log');

    if (!fs.existsSync(logPath)) {
      console.log('No logs yet.');
      return;
    }

    if (options.follow) {
      spawn('tail', ['-f', logPath], { stdio: 'inherit' });
    } else {
      const logs = fs.readFileSync(logPath, 'utf-8');
      console.log(logs);
    }
  });

// =============================================================================
// reset command
// =============================================================================
program
  .command('reset')
  .description('Reset sync state (next sync will be a fresh start)')
  .option('-s, --server', 'Also delete all data on the server')
  .action(async (options) => {
    if (!configExists()) {
      console.log(chalk.yellow('Not configured. Nothing to reset.'));
      return;
    }

    const statePath = path.join(getConfigDir(), 'state.json');
    const hasLocalState = fs.existsSync(statePath);

    if (!hasLocalState && !options.server) {
      console.log(chalk.yellow('No sync state to reset.'));
      return;
    }

    // Build confirmation message based on options
    let message = 'This will clear your local sync state.';
    if (options.server) {
      message = 'This will clear your local sync state AND delete all your data on the server.';
    }
    message += ' Continue?';

    const confirmed = await confirm({
      message,
      default: false,
    });

    if (!confirmed) {
      console.log(chalk.dim('Cancelled.'));
      return;
    }

    // Reset server data if requested
    if (options.server) {
      const config = loadConfig()!;
      const api = new ApiClient(config.serverUrl, config.apiKey);

      try {
        console.log(chalk.dim('Deleting server data...'));
        const result = await api.reset();
        log(`Server reset: deleted ${result.deleted.todos} todos, ${result.deleted.headings} headings`);
        console.log(chalk.green(`✅ Server data deleted (${result.deleted.todos} todos, ${result.deleted.headings} headings)`));
      } catch (error) {
        logError('Server reset failed', error);
        console.error(chalk.red(`❌ Failed to reset server: ${error}`));
        return;
      }
    }

    // Reset local state
    if (hasLocalState) {
      fs.unlinkSync(statePath);
      log('Sync state reset by user');
    }

    console.log(chalk.green('✅ Reset complete. Run "shared-things sync" for a fresh sync.'));
  });

// =============================================================================
// purge command
// =============================================================================
program
  .command('purge')
  .description('Remove all local data (config, state, logs)')
  .action(async () => {
    const configDir = getConfigDir();

    if (!fs.existsSync(configDir)) {
      console.log(chalk.yellow('Nothing to purge.'));
      return;
    }

    // Check if daemon is running
    const daemonStatus = getLaunchAgentStatus();
    if (daemonStatus === 'running') {
      console.log(chalk.yellow('⚠️  Daemon is still running. Stopping it first...'));
      uninstallLaunchAgent();
    }

    const confirmed = await confirm({
      message: `This will delete all local data in ${configDir}. You will need to run "init" again. Continue?`,
      default: false,
    });

    if (!confirmed) {
      console.log(chalk.dim('Cancelled.'));
      return;
    }

    // Delete the entire config directory
    fs.rmSync(configDir, { recursive: true, force: true });
    console.log(chalk.green('✅ All local data removed. Run "shared-things init" to start fresh.'));
  });

program.parse();
