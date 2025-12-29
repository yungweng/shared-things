/**
 * Sync logic between Things and server
 */

import type { ProjectState, Todo, Heading } from '@shared-things/common';
import { ApiClient } from './api.js';
import { getTodosFromProject, createTodo, updateTodo, type ThingsTodo } from './things.js';
import { loadConfig, saveConfig } from './config.js';
import { log, logError, logSync, logMapping, logTodoCreated, logTodoUpdated } from './logger.js';
import * as fs from 'fs';
import * as path from 'path';
import { getConfigDir } from './config.js';

const STATE_FILE = path.join(getConfigDir(), 'state.json');

interface LocalState {
  lastSyncedAt: string;
  todos: Map<string, ThingsTodo>; // thingsId -> todo
  /** Maps server ID to local thingsId (critical for cross-device sync) */
  serverIdToThingsId: Map<string, string>;
}

function loadLocalState(): LocalState {
  if (!fs.existsSync(STATE_FILE)) {
    return {
      lastSyncedAt: new Date(0).toISOString(),
      todos: new Map(),
      serverIdToThingsId: new Map(),
    };
  }

  try {
    const content = fs.readFileSync(STATE_FILE, 'utf-8');
    const data = JSON.parse(content);
    return {
      lastSyncedAt: data.lastSyncedAt,
      todos: new Map(Object.entries(data.todos || {})),
      serverIdToThingsId: new Map(Object.entries(data.serverIdToThingsId || {})),
    };
  } catch {
    return {
      lastSyncedAt: new Date(0).toISOString(),
      todos: new Map(),
      serverIdToThingsId: new Map(),
    };
  }
}

function saveLocalState(state: LocalState): void {
  const data = {
    lastSyncedAt: state.lastSyncedAt,
    todos: Object.fromEntries(state.todos),
    serverIdToThingsId: Object.fromEntries(state.serverIdToThingsId),
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
}

export async function runSync(): Promise<{ pushed: number; pulled: number; isFirstSync: boolean }> {
  const config = loadConfig();
  if (!config) {
    throw new Error('Not configured. Run "shared-things init" first.');
  }

  const api = new ApiClient(config.serverUrl, config.apiKey);
  const localState = loadLocalState();
  const isFirstSync = localState.lastSyncedAt === new Date(0).toISOString();

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

  // Build reverse mapping: thingsId -> serverId
  const thingsIdToServerId = new Map<string, string>();
  for (const [serverId, thingsId] of localState.serverIdToThingsId) {
    thingsIdToServerId.set(thingsId, serverId);
  }

  // 3. Push local changes to server
  let pushed = 0;
  if (localChanges.upserted.length > 0 || localChanges.deleted.length > 0) {
    const pushRequest = {
      headings: { upserted: [], deleted: [] },
      todos: {
        upserted: localChanges.upserted.map((t, idx) => ({
          // Include serverId if we know it (for updates)
          serverId: thingsIdToServerId.get(t.thingsId),
          thingsId: t.thingsId,
          title: t.title,
          notes: t.notes,
          dueDate: t.dueDate,
          tags: t.tags,
          status: t.status,
          headingId: t.headingThingsId,
          position: idx,
        })),
        // Convert thingsIds to serverIds for deletions
        deleted: localChanges.deleted
          .map(thingsId => thingsIdToServerId.get(thingsId))
          .filter((id): id is string => id !== undefined),
      },
      lastSyncedAt: localState.lastSyncedAt,
    };

    const pushResponse = await api.push(pushRequest);
    pushed = localChanges.upserted.length + localChanges.deleted.length;

    // Record server ID mappings for all todos in the response
    // This handles both our pushed todos and existing server todos
    for (const serverTodo of pushResponse.state.todos) {
      // Check if we have this todo locally (by matching thingsId)
      const localTodo = currentTodosMap.get(serverTodo.thingsId);
      if (localTodo) {
        localState.serverIdToThingsId.set(serverTodo.id, localTodo.thingsId);
      }
    }
  }

  // 4. Pull remote changes
  const delta = await api.getDelta(localState.lastSyncedAt);
  let pulled = 0;

  // Apply remote todo changes to Things
  for (const remoteTodo of delta.todos.upserted) {
    // Look up by SERVER ID, not thingsId!
    const localThingsId = localState.serverIdToThingsId.get(remoteTodo.id);
    const localTodo = localThingsId ? currentTodosMap.get(localThingsId) : null;

    if (!localTodo) {
      // New todo from server - create locally
      // First, get current todos to detect the new one after creation
      const beforeTodos = new Set(currentTodosMap.keys());

      createTodo(config.projectName, {
        title: remoteTodo.title,
        notes: remoteTodo.notes,
        dueDate: remoteTodo.dueDate || undefined,
        tags: remoteTodo.tags,
      });
      logTodoCreated(remoteTodo.title);

      // Wait for Things to process the URL scheme (with retry)
      let newTodo: ThingsTodo | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 500));

        // Re-read todos to find the new one
        const afterTodos = getTodosFromProject(config.projectName);

        // Match by title AND not being in beforeTodos (more reliable)
        newTodo = afterTodos.find(t =>
          !beforeTodos.has(t.thingsId) &&
          t.title === remoteTodo.title
        );

        // Fallback: any new todo if title match fails
        if (!newTodo) {
          newTodo = afterTodos.find(t => !beforeTodos.has(t.thingsId));
        }

        if (newTodo) break;
      }

      if (newTodo) {
        // Record the mapping: serverId -> local thingsId
        localState.serverIdToThingsId.set(remoteTodo.id, newTodo.thingsId);
        currentTodosMap.set(newTodo.thingsId, newTodo);
        logMapping(remoteTodo.id, newTodo.thingsId);
      } else {
        logError(`Failed to find newly created todo for server ${remoteTodo.id}`, remoteTodo.title);
      }

      pulled++;
    } else if (hasRemoteChanged(localTodo, remoteTodo)) {
      // Remote changed - update locally
      updateTodo(config.thingsAuthToken, localTodo.thingsId, {
        title: remoteTodo.title,
        notes: remoteTodo.notes,
        dueDate: remoteTodo.dueDate || undefined,
        completed: remoteTodo.status === 'completed',
        canceled: remoteTodo.status === 'canceled',
      });
      logTodoUpdated(localTodo.thingsId, remoteTodo.title);
      pulled++;
    }
  }

  // Note: Deleting todos in Things via automation is limited
  // We can log deletions but not execute them automatically
  if (delta.todos.deleted.length > 0) {
    log(`Remote deletions (manual action needed): ${delta.todos.deleted.join(', ')}`);
  }

  // 5. Update local state
  localState.lastSyncedAt = delta.syncedAt;
  localState.todos = currentTodosMap;
  saveLocalState(localState);

  // Log sync summary
  logSync(pushed, pulled, isFirstSync);

  return { pushed, pulled, isFirstSync };
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
