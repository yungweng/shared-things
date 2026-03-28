/**
 * Sync logic between Things and server (v3)
 *
 * Key changes from v2:
 * - createTodo returns ID atomically (no findNewTodo polling)
 * - deleteTodo moves to Papierkorb (no more "manual delete required" conflicts)
 * - No polling loop here — triggered by watcher or WS events
 */

import { execSync } from "node:child_process";
import type {
	DaemonConfig,
	PushResponse,
	SyncDelta,
	Todo,
} from "@shared-things/common";
import { ApiClient } from "./api.js";
import { loadConfig } from "./config.js";
import { logDebug, logError, logInfo, logWarn } from "./logger.js";
import {
	acquireLock,
	appendConflicts,
	type ConflictEntry,
	findServerId,
	invertMapping,
	type LocalState,
	loadLocalState,
	releaseLock,
	saveLocalState,
	setMapping,
} from "./state.js";
import {
	createProjectInArea,
	createTodo,
	createTodoInArea,
	deleteTodo,
	getProjectsInArea,
	getTodosFromArea,
	getTodosFromProject,
	type ThingsTodo,
	updateTodo,
} from "./things.js";

/** Read all todos based on config sync mode */
function readCurrentTodos(config: DaemonConfig): ThingsTodo[] {
	if (config.syncMode === "area" && config.areaName) {
		return getTodosFromArea(config.areaName);
	}
	return getTodosFromProject(config.projectName!);
}

export async function runSync(): Promise<{
	pushed: number;
	pulled: number;
	isFirstSync: boolean;
	skipped?: boolean;
	conflicts: number;
}> {
	const config = loadConfig();
	if (!config) {
		throw new Error('Not configured. Run "shared-things init" first.');
	}

	if (!acquireLock()) {
		logWarn("Sync skipped: another sync is running.");
		return {
			pushed: 0,
			pulled: 0,
			isFirstSync: false,
			skipped: true,
			conflicts: 0,
		};
	}

	let localState: LocalState;
	try {
		localState = loadLocalState();
	} catch (error) {
		releaseLock();
		throw error;
	}

	const api = new ApiClient(config.serverUrl, config.apiKey);
	const isFirstSync =
		Object.keys(localState.todos).length === 0 &&
		Object.keys(localState.serverIdToThingsId).length === 0;

	let pushed = 0;
	let pulled = 0;
	let conflictCount = 0;

	try {
		// 1. Read current Things state
		const currentTodos = readCurrentTodos(config);
		const positionMap = new Map(
			currentTodos.map((todo, idx) => [todo.thingsId, idx]),
		);
		const currentTodosMap = new Map(currentTodos.map((t) => [t.thingsId, t]));

		// 1b. If state was reset but Things still has todos, reconcile by matching
		//     existing Things todos against server state before detecting changes.
		//     This prevents re-pushing existing todos as new (causing duplicates).
		if (isFirstSync && currentTodos.length > 0) {
			logInfo(
				`Reconciling ${currentTodos.length} existing Things todos with server state`,
			);
			const serverState = await api.getState();
			const serverTodosByTitle = new Map<string, Todo>();
			for (const st of serverState.todos) {
				// Use first unmatched server todo per title
				if (!serverTodosByTitle.has(st.title)) {
					serverTodosByTitle.set(st.title, st);
				}
			}

			const matchedServerIds = new Set<string>();
			for (const thingsTodo of currentTodos) {
				const match = serverTodosByTitle.get(thingsTodo.title);
				if (match && !matchedServerIds.has(match.id)) {
					setMapping(localState, match.id, thingsTodo.thingsId);
					matchedServerIds.add(match.id);
					logDebug(`Reconciled "${thingsTodo.title}" -> server ${match.id}`);
				}
			}

			logInfo(
				`Reconciled ${matchedServerIds.size}/${currentTodos.length} todos with server`,
			);
		}

		// 2. Detect local changes
		const now = new Date().toISOString();
		const dirtyUpserted = new Set(localState.dirty.upserted);

		for (const [thingsId, todo] of currentTodosMap) {
			const prev = localState.todos[thingsId];
			const position = positionMap.get(thingsId) ?? 0;

			if (!prev) {
				localState.todos[thingsId] = {
					thingsId,
					title: todo.title,
					notes: todo.notes,
					dueDate: todo.dueDate,
					tags: todo.tags,
					status: todo.status,
					position,
					projectName: todo.projectName,
					editedAt: now,
				};
				dirtyUpserted.add(thingsId);
				continue;
			}

			if (hasChanged(prev, todo, position)) {
				localState.todos[thingsId] = {
					...prev,
					title: todo.title,
					notes: todo.notes,
					dueDate: todo.dueDate,
					tags: todo.tags,
					status: todo.status,
					position,
					editedAt: now,
				};
				dirtyUpserted.add(thingsId);
			}
		}

		// Detect deletions
		for (const thingsId of Object.keys(localState.todos)) {
			if (!currentTodosMap.has(thingsId)) {
				const serverId = findServerId(localState.serverIdToThingsId, thingsId);
				if (serverId && !localState.dirty.deleted[serverId]) {
					localState.dirty.deleted[serverId] = now;
				}
				delete localState.todos[thingsId];
			}
		}

		localState.dirty.upserted = Array.from(dirtyUpserted).filter((id) =>
			currentTodosMap.has(id),
		);

		// 3. Build push payload
		const thingsIdToServerId = invertMapping(localState.serverIdToThingsId);
		const pushUpserts = localState.dirty.upserted
			.map((thingsId) => {
				const stored = localState.todos[thingsId];
				if (!stored) return null;
				return {
					serverId: thingsIdToServerId.get(thingsId),
					clientId: thingsId,
					title: stored.title,
					notes: stored.notes,
					dueDate: stored.dueDate,
					tags: stored.tags,
					status: stored.status,
					position: stored.position,
					projectName: stored.projectName,
					editedAt: stored.editedAt,
				};
			})
			.filter(Boolean) as NonNullable<ReturnType<typeof Object.values>>;

		const pushDeletes: { serverId: string; deletedAt: string }[] = [];
		for (const [serverId, deletedAt] of Object.entries(
			localState.dirty.deleted,
		)) {
			const thingsId = localState.serverIdToThingsId[serverId];
			if (thingsId && currentTodosMap.has(thingsId)) {
				delete localState.dirty.deleted[serverId];
				continue;
			}
			pushDeletes.push({ serverId, deletedAt });
		}

		// 4. Push to server
		if (pushUpserts.length > 0 || pushDeletes.length > 0) {
			const pushResponse = await api.push({
				todos: { upserted: pushUpserts, deleted: pushDeletes },
				lastSyncedAt: localState.lastSyncedAt,
			});

			pushed = pushUpserts.length + pushDeletes.length;
			processMappings(localState, pushResponse);

			const conflictEntries = conflictsFromPush(pushResponse);
			conflictCount += conflictEntries.length;
			appendConflicts(conflictEntries);

			localState.dirty = { upserted: [], deleted: {} };
		}

		// 5. Pull from server
		const delta = await getServerDelta(api, localState);
		const remoteResult = applyRemoteChanges(
			config,
			delta.todos.upserted,
			delta.todos.deleted,
			currentTodosMap,
			localState,
		);
		pulled += remoteResult.applied;
		conflictCount += remoteResult.conflicts.length;
		appendConflicts(remoteResult.conflicts);

		localState.lastSyncedAt = delta.syncedAt;
		saveLocalState(localState);

		if (pushed > 0 || pulled > 0 || conflictCount > 0) {
			logInfo(
				`Sync: pushed=${pushed}, pulled=${pulled}, conflicts=${conflictCount}`,
			);
		} else {
			logDebug("Sync: no changes");
		}

		if (conflictCount > 0) {
			notifyConflicts(conflictCount);
		}
	} catch (error) {
		logError("Sync failed", error);
		saveLocalState(localState);
		throw error;
	} finally {
		releaseLock();
	}

	return { pushed, pulled, isFirstSync, conflicts: conflictCount };
}

/**
 * Apply a delta received via WebSocket (server push)
 * Lighter than runSync — no push needed, just apply incoming changes.
 */
export function applyDelta(delta: SyncDelta): void {
	const config = loadConfig();
	if (!config) return;

	if (!acquireLock()) {
		logWarn("Delta apply skipped: sync lock held");
		return;
	}

	try {
		const localState = loadLocalState();
		const currentTodos = readCurrentTodos(config);
		const currentTodosMap = new Map(currentTodos.map((t) => [t.thingsId, t]));

		const result = applyRemoteChanges(
			config,
			delta.todos.upserted,
			delta.todos.deleted,
			currentTodosMap,
			localState,
		);

		localState.lastSyncedAt = delta.syncedAt;
		saveLocalState(localState);

		if (result.applied > 0) {
			logInfo(`Applied delta: ${result.applied} changes`);
		}
		if (result.conflicts.length > 0) {
			appendConflicts(result.conflicts);
			notifyConflicts(result.conflicts.length);
		}
	} catch (error) {
		logError("Delta apply failed", error);
	} finally {
		releaseLock();
	}
}

// =============================================================================
// Internal helpers
// =============================================================================

function hasChanged(
	prev: {
		title: string;
		notes: string;
		dueDate: string | null;
		status: string;
		position: number;
		tags: string[];
	},
	curr: ThingsTodo,
	position: number,
): boolean {
	return (
		prev.title !== curr.title ||
		prev.notes !== curr.notes ||
		prev.dueDate !== curr.dueDate ||
		prev.status !== curr.status ||
		prev.position !== position ||
		JSON.stringify(prev.tags) !== JSON.stringify(curr.tags)
	);
}

function processMappings(state: LocalState, response: PushResponse): void {
	if (!response.mappings) return;
	for (const mapping of response.mappings) {
		if (!mapping.clientId) continue;
		setMapping(state, mapping.serverId, mapping.clientId);
	}
}

function conflictsFromPush(response: PushResponse): ConflictEntry[] {
	if (!response.conflicts?.length) return [];
	const timestamp = new Date().toISOString();
	return response.conflicts.map((c) => ({
		timestamp,
		serverId: c.serverId,
		title: c.clientTodo?.title || c.serverTodo?.title || "Unknown",
		yourVersion: c.clientTodo
			? { title: c.clientTodo.title, editedAt: c.clientTodo.editedAt }
			: c.clientDeletedAt
				? { deletedAt: c.clientDeletedAt }
				: {},
		winningVersion: c.serverTodo
			? { title: c.serverTodo.title, editedAt: c.serverTodo.editedAt }
			: {},
		reason: c.reason,
	}));
}

async function getServerDelta(api: ApiClient, state: LocalState) {
	// Bootstrap (full state fetch) when local state has no mappings, regardless
	// of whether Things already has todos.  The reconciliation step in runSync
	// will have pre-populated mappings for any matched todos, so the pull phase
	// will correctly update rather than duplicate.
	const shouldBootstrap = Object.keys(state.serverIdToThingsId).length === 0;

	if (shouldBootstrap) {
		const fullState = await api.getState();
		return {
			todos: { upserted: fullState.todos, deleted: [] },
			syncedAt: fullState.syncedAt,
		};
	}

	return api.getDelta(state.lastSyncedAt);
}

/**
 * Apply remote changes to Things (v3: supports actual deletion!)
 */
function applyRemoteChanges(
	config: DaemonConfig,
	upserted: Todo[],
	deleted: { serverId: string; deletedAt: string }[],
	currentTodosMap: Map<string, ThingsTodo>,
	state: LocalState,
): { applied: number; conflicts: ConflictEntry[] } {
	let applied = 0;
	const conflicts: ConflictEntry[] = [];
	const authToken = config.thingsAuthToken;

	// Track known local projects (for area mode — create missing projects on demand)
	let knownProjects: Set<string> | null = null;
	if (config.syncMode === "area" && config.areaName) {
		knownProjects = new Set(getProjectsInArea(config.areaName));
	}

	for (const remoteTodo of upserted) {
		const localThingsId = state.serverIdToThingsId[remoteTodo.id];
		const localTodo = localThingsId
			? currentTodosMap.get(localThingsId)
			: undefined;
		const localStateTodo = localThingsId
			? state.todos[localThingsId]
			: undefined;

		if (!localTodo || !localThingsId) {
			try {
				let newThingsId: string;

				if (
					config.syncMode === "area" &&
					config.areaName &&
					!remoteTodo.projectName
				) {
					// Loose todo in area
					newThingsId = createTodoInArea(config.areaName, {
						title: remoteTodo.title,
						notes: remoteTodo.notes,
						dueDate: remoteTodo.dueDate || undefined,
						tags: remoteTodo.tags,
					});
				} else {
					// Todo in a project
					const targetProject = remoteTodo.projectName || config.projectName!;

					// In area mode, ensure the project exists
					if (
						config.syncMode === "area" &&
						config.areaName &&
						knownProjects &&
						!knownProjects.has(targetProject)
					) {
						createProjectInArea(targetProject, config.areaName);
						knownProjects.add(targetProject);
						logInfo(`Created project: "${targetProject}"`);
					}

					newThingsId = createTodo(targetProject, {
						title: remoteTodo.title,
						notes: remoteTodo.notes,
						dueDate: remoteTodo.dueDate || undefined,
						tags: remoteTodo.tags,
					});
				}

				setMapping(state, remoteTodo.id, newThingsId);
				state.todos[newThingsId] = {
					thingsId: newThingsId,
					title: remoteTodo.title,
					notes: remoteTodo.notes,
					dueDate: remoteTodo.dueDate,
					tags: remoteTodo.tags,
					status: remoteTodo.status,
					position: remoteTodo.position,
					projectName: remoteTodo.projectName,
					editedAt: remoteTodo.editedAt,
				};

				if (remoteTodo.status !== "open") {
					try {
						updateTodo(authToken, newThingsId, {
							completed: remoteTodo.status === "completed",
							canceled: remoteTodo.status === "canceled",
						});
					} catch (error) {
						logWarn(`Failed to set status for ${newThingsId}: ${error}`);
					}
				}

				logInfo(`Created todo: "${remoteTodo.title}"`);
			} catch (error) {
				logError(`Failed to create todo "${remoteTodo.title}"`, error);
				continue;
			}
			applied += 1;
			continue;
		}

		// Update existing todo
		if (
			!localStateTodo ||
			compareIso(remoteTodo.editedAt, localStateTodo.editedAt) >= 0
		) {
			updateTodo(authToken, localTodo.thingsId, {
				title: remoteTodo.title,
				notes: remoteTodo.notes,
				dueDate: remoteTodo.dueDate || undefined,
				completed: remoteTodo.status === "completed",
				canceled: remoteTodo.status === "canceled",
			});

			state.todos[localTodo.thingsId] = {
				thingsId: localTodo.thingsId,
				title: remoteTodo.title,
				notes: remoteTodo.notes,
				dueDate: remoteTodo.dueDate,
				tags: remoteTodo.tags,
				status: remoteTodo.status,
				position: remoteTodo.position,
				projectName: remoteTodo.projectName,
				editedAt: remoteTodo.editedAt,
			};

			logInfo(`Updated todo: "${remoteTodo.title}"`);
			applied += 1;
		}
	}

	// v3: Actually delete todos (move to Papierkorb)
	for (const deletion of deleted) {
		const localThingsId = state.serverIdToThingsId[deletion.serverId];
		if (!localThingsId) {
			delete state.serverIdToThingsId[deletion.serverId];
			continue;
		}

		const localStateTodo = state.todos[localThingsId];
		if (!localStateTodo) {
			delete state.serverIdToThingsId[deletion.serverId];
			continue;
		}

		// Skip if local edit is newer
		if (compareIso(deletion.deletedAt, localStateTodo.editedAt) < 0) {
			continue;
		}

		// Actually delete in Things!
		if (currentTodosMap.has(localThingsId)) {
			try {
				deleteTodo(localThingsId);
				logInfo(`Deleted todo: "${localStateTodo.title}"`);
			} catch (error) {
				logWarn(`Failed to delete todo ${localThingsId}: ${error}`);
				conflicts.push({
					timestamp: new Date().toISOString(),
					serverId: deletion.serverId,
					title: localStateTodo.title,
					yourVersion: {
						title: localStateTodo.title,
						editedAt: localStateTodo.editedAt,
					},
					winningVersion: { deletedAt: deletion.deletedAt },
					reason: "Delete failed (manual delete required)",
				});
				continue;
			}
		}

		delete state.todos[localThingsId];
		delete state.serverIdToThingsId[deletion.serverId];
		applied += 1;
	}

	return { applied, conflicts };
}

function compareIso(a: string, b: string): number {
	return new Date(a).getTime() - new Date(b).getTime();
}

function notifyConflicts(count: number): void {
	if (count <= 0) return;
	try {
		const message = `${count} sync conflict${count === 1 ? "" : "s"} resolved.`;
		execSync(
			`osascript -e 'display notification "${message}" with title "shared-things"'`,
		);
	} catch {
		// ignore
	}
}
