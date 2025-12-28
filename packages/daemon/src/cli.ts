#!/usr/bin/env node
/**
 * shared-things CLI
 */

import { Command } from 'commander';
import * as readline from 'readline';
import { loadConfig, saveConfig, configExists, ensureConfigDir, getConfigDir } from './config.js';
import { listProjects, projectExists, isThingsRunning } from './things.js';
import { ApiClient } from './api.js';
import { runSync } from './sync.js';
import { installLaunchAgent, uninstallLaunchAgent, getLaunchAgentStatus } from './launchagent.js';
import * as fs from 'fs';
import * as path from 'path';

const program = new Command();

program
  .name('shared-things')
  .description('Sync a Things 3 project between multiple users')
  .version('0.1.0');

// =============================================================================
// init command
// =============================================================================
program
  .command('init')
  .description('Setup wizard')
  .action(async () => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const ask = (question: string): Promise<string> =>
      new Promise(resolve => rl.question(question, resolve));

    console.log('shared-things Setup\n');

    // Check Things
    if (!isThingsRunning()) {
      console.log('Note: Things 3 is not running. Please start it first.\n');
    }

    // Server URL
    const serverUrl = await ask('Server URL (e.g., https://things.example.com): ');
    if (!serverUrl) {
      console.error('Server URL is required.');
      rl.close();
      process.exit(1);
    }

    // API Key
    const apiKey = await ask('Your API key: ');
    if (!apiKey) {
      console.error('API key is required.');
      rl.close();
      process.exit(1);
    }

    // Verify connection
    console.log('\nVerifying connection...');
    const api = new ApiClient(serverUrl, apiKey);
    try {
      await api.health();
      console.log('Connection successful!');
    } catch (error) {
      console.error(`Failed to connect: ${error}`);
      rl.close();
      process.exit(1);
    }

    // List projects
    console.log('\nAvailable Things projects:');
    const projects = listProjects();
    if (projects.length === 0) {
      console.log('  (no projects found)');
    } else {
      projects.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
    }

    const projectName = await ask('\nProject to sync: ');
    if (!projectExists(projectName)) {
      console.error(`Project "${projectName}" not found in Things.`);
      rl.close();
      process.exit(1);
    }

    // Save config
    saveConfig({
      serverUrl,
      apiKey,
      projectName,
      pollInterval: 30,
    });

    console.log('\nConfiguration saved!');
    console.log(`\nNext steps:`);
    console.log('  1. Run "shared-things install" to start the daemon');
    console.log('  2. Or run "shared-things sync" for a one-time sync');

    rl.close();
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
  .action(() => {
    if (!configExists()) {
      console.log('Status: Not configured');
      console.log('Run "shared-things init" to get started.');
      return;
    }

    const config = loadConfig()!;
    const daemonStatus = getLaunchAgentStatus();

    console.log('shared-things Status\n');
    console.log(`Server:    ${config.serverUrl}`);
    console.log(`Project:   ${config.projectName}`);
    console.log(`Interval:  ${config.pollInterval}s`);
    console.log(`Daemon:    ${daemonStatus}`);

    // Show last sync time
    const statePath = path.join(getConfigDir(), 'state.json');
    if (fs.existsSync(statePath)) {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      console.log(`Last sync: ${state.lastSyncedAt}`);
    }
  });

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

    console.log('Syncing...');
    try {
      const result = await runSync();
      console.log(`Done! Pushed: ${result.pushed}, Pulled: ${result.pulled}`);
    } catch (error) {
      console.error(`Sync failed: ${error}`);
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
    console.log(`Daemon started. Syncing every ${config.pollInterval}s...`);

    // Initial sync
    try {
      await runSync();
      console.log(`[${new Date().toISOString()}] Initial sync complete.`);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Sync error: ${error}`);
    }

    // Poll loop
    setInterval(async () => {
      try {
        const result = await runSync();
        if (result.pushed > 0 || result.pulled > 0) {
          console.log(`[${new Date().toISOString()}] Pushed: ${result.pushed}, Pulled: ${result.pulled}`);
        }
      } catch (error) {
        console.error(`[${new Date().toISOString()}] Sync error: ${error}`);
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
      const { spawn } = require('child_process');
      spawn('tail', ['-f', logPath], { stdio: 'inherit' });
    } else {
      const logs = fs.readFileSync(logPath, 'utf-8');
      console.log(logs);
    }
  });

program.parse();
