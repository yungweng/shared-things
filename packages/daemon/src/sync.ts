/**
 * Sync logic between Things and server
 */

import type { ProjectState, Todo, Heading } from '@shared-things/common';
import { ApiClient } from './api.js';
import { getTodosFromProject, createTodo, updateTodo, type ThingsTodo } from './things.js';
import { loadConfig, saveConfig } from './config.js';
import * as fs from 'fs';
import * as path from 'path';
import { getConfigDir } from './config.js';

const STATE_FILE = path.join(getConfigDir(), 'state.json');

interface LocalState {
  lastSyncedAt: string;
  todos: Map<string, ThingsTodo>; // thingsId -> todo
}

function loadLocalState(): LocalState {
  if (!fs.existsSync(STATE_FILE)) {
    return {
      lastSyncedAt: new Date(0).toISOString(),
      todos: new Map(),
    };
  }

  try {
    const content = fs.readFileSync(STATE_FILE, 'utf-8');
    const data = JSON.parse(content);
    return {
      lastSyncedAt: data.lastSyncedAt,
      todos: new Map(Object.entries(data.todos || {})),
    };
  } catch {
    return {
      lastSyncedAt: new Date(0).toISOString(),
      todos: new Map(),
    };
  }
}

function saveLocalState(state: LocalState): void {
  const data = {
    lastSyncedAt: state.lastSyncedAt,
    todos: Object.fromEntries(state.todos),
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
}

export async function runSync(): Promise<{ pushed: number; pulled: number }> {
  const config = loadConfig();
  if (!config) {
    throw new Error('Not configured. Run "shared-things init" first.');
  }

  const api = new ApiClient(config.serverUrl, config.apiKey);
  const localState = loadLocalState();

  // 1. Read current Things state
  const currentTodos = getTodosFromProject(config.projectName);
  const currentTodosMap = new Map(currentTodos.map(t => [t.thingsId, t]));

  // 2. Detect local changes
  const localChanges: {
    upserted: ThingsTodo[];
    deleted: string[];
  } = {
    upserted: [],
    deleted: [],
  };

  // Find new/modified todos
  for (const [thingsId, todo] of currentTodosMap) {
    const prev = localState.todos.get(thingsId);
    if (!prev || hasChanged(prev, todo)) {
      localChanges.upserted.push(todo);
    }
  }

  // Find deleted todos
  for (const thingsId of localState.todos.keys()) {
    if (!currentTodosMap.has(thingsId)) {
      localChanges.deleted.push(thingsId);
    }
  }

  // 3. Push local changes to server
  let pushed = 0;
  if (localChanges.upserted.length > 0 || localChanges.deleted.length > 0) {
    const pushRequest = {
      headings: { upserted: [], deleted: [] },
      todos: {
        upserted: localChanges.upserted.map((t, idx) => ({
          thingsId: t.thingsId,
          title: t.title,
          notes: t.notes,
          dueDate: t.dueDate,
          tags: t.tags,
          status: t.status,
          headingId: t.headingThingsId,
          position: idx,
        })),
        deleted: localChanges.deleted,
      },
      lastSyncedAt: localState.lastSyncedAt,
    };

    await api.push(pushRequest);
    pushed = localChanges.upserted.length + localChanges.deleted.length;
  }

  // 4. Pull remote changes
  const delta = await api.getDelta(localState.lastSyncedAt);
  let pulled = 0;

  // Apply remote todo changes to Things
  for (const remoteTodo of delta.todos.upserted) {
    const localTodo = currentTodosMap.get(remoteTodo.thingsId);

    if (!localTodo) {
      // New todo from server - create locally
      createTodo(config.projectName, {
        title: remoteTodo.title,
        notes: remoteTodo.notes,
        dueDate: remoteTodo.dueDate || undefined,
        tags: remoteTodo.tags,
      });
      pulled++;
    } else if (hasRemoteChanged(localTodo, remoteTodo)) {
      // Remote changed - update locally
      // Note: This requires auth token which user must configure
      // For now, log that update is needed
      console.log(`Update needed for: ${remoteTodo.title}`);
      pulled++;
    }
  }

  // Note: Deleting todos in Things via automation is limited
  // We can log deletions but not execute them automatically
  if (delta.todos.deleted.length > 0) {
    console.log(`Remote deletions (manual action needed): ${delta.todos.deleted.join(', ')}`);
  }

  // 5. Update local state
  localState.lastSyncedAt = delta.syncedAt;
  localState.todos = currentTodosMap;
  saveLocalState(localState);

  return { pushed, pulled };
}

function hasChanged(prev: ThingsTodo, curr: ThingsTodo): boolean {
  return (
    prev.title !== curr.title ||
    prev.notes !== curr.notes ||
    prev.dueDate !== curr.dueDate ||
    prev.status !== curr.status ||
    JSON.stringify(prev.tags) !== JSON.stringify(curr.tags)
  );
}

function hasRemoteChanged(local: ThingsTodo, remote: Todo): boolean {
  return (
    local.title !== remote.title ||
    local.notes !== remote.notes ||
    local.dueDate !== remote.dueDate ||
    local.status !== remote.status ||
    JSON.stringify(local.tags) !== JSON.stringify(remote.tags)
  );
}
