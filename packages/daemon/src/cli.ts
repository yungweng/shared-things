#!/usr/bin/env node
/**
 * shared-things CLI
 */

import { Command } from 'commander';
import { input, select, password } from '@inquirer/prompts';
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
    console.log('\n🔄 shared-things Setup\n');

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

    // Verify connection
    console.log('\n⏳ Verifying connection...');
    const api = new ApiClient(serverUrl, apiKey);
    try {
      await api.health();
      console.log('✅ Connection successful!\n');
    } catch (error) {
      console.error(`❌ Failed to connect: ${error}`);
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

    // Step 4: Things Auth Token
    console.log('\n📋 Find your Things Auth Token in:');
    console.log('   Things → Settings → General → Things URLs → Manage\n');

    const thingsAuthToken = await password({
      message: 'Things Auth Token',
      mask: '*',
      validate: (value) => value ? true : 'Auth token is required for updating tasks',
    });

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
