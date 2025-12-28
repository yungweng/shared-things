/**
 * Daemon configuration management
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { DaemonConfig } from '@shared-things/common';

const CONFIG_DIR = path.join(os.homedir(), '.shared-things');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export function loadConfig(): DaemonConfig | null {
  if (!fs.existsSync(CONFIG_PATH)) {
    return null;
  }

  try {
    const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
    return JSON.parse(content) as DaemonConfig;
  } catch {
    return null;
  }
}

export function saveConfig(config: DaemonConfig): void {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

export function configExists(): boolean {
  return fs.existsSync(CONFIG_PATH);
}
