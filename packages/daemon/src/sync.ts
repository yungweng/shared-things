/**
 * Sync logic between Things and server (v2)
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PushResponse, Todo } from "@shared-things/common";
import { ApiClient } from "./api.js";
import { ensureConfigDir, getConfigDir, loadConfig } from "./config.js";
import {
	logDebug,
	logError,
	logInfo,
	logMapping,
	logSync,
	logTodoCreated,
	logTodoUpdated,
	logWarn,
} from "./logger.js";
import {
	createTodo,
	getTodosFromProject,
	type ThingsTodo,
	updateTodo,
} from "./things.js";

const STATE_FILE = path.join(getConfigDir(), "state.json");
const STATE_BAK_FILE = path.join(getConfigDir(), "state.json.bak");
const LOCK_FILE = path.join(getConfigDir(), "sync.lock");
const CONFLICTS_FILE = path.join(getConfigDir(), "conflicts.json");

interface LocalTodoState {
	thingsId: string;
	title: string;
	notes: string;
	dueDate: string | null;
	tags: string[];
	status: "open" | "completed" | "canceled";
	position: number;
	editedAt: string;
}

interface DirtyState {
	upserted: string[];
	// serverId -> deletedAt
	deleted: Record<string, string>;
}

interface LocalState {
	lastSyncedAt: string;
	todos: Record<string, LocalTodoState>;
	serverIdToThingsId: Record<string, string>;
	dirty: DirtyState;
}

interface ConflictEntry {
	timestamp: string;
	serverId: string;
	title: string;
	yourVersion: { title?: string; editedAt?: string; deletedAt?: string };
	winningVersion: { title?: string; editedAt?: string; deletedAt?: string };
	reason: string;
}

function loadLocalState(): LocalState {
	if (!fs.existsSync(STATE_FILE)) {
		throw new Error('State file missing. Run "shared-things init" first.');
	}

	ensureConfigDir();
	fs.copyFileSync(STATE_FILE, STATE_BAK_FILE);

	const raw = fs.readFileSync(STATE_FILE, "utf-8");
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		throw new Error("State file is corrupted (invalid JSON).");
	}

	if (typeof data !== "object" || data === null) {
		throw new Error("State file is corrupted (invalid structure).");
	}
	const obj = data as Record<string, unknown>;

	const lastSyncedAt =
		typeof obj.lastSyncedAt === "string" ? obj.lastSyncedAt : null;
	const todos =
		typeof obj.todos === "object" && obj.todos !== null
			? (obj.todos as Record<string, LocalTodoState>)
			: null;
	const serverIdToThingsId =
		typeof obj.serverIdToThingsId === "object" &&
		obj.serverIdToThingsId !== null
			? (obj.serverIdToThingsId as Record<string, string>)
			: null;
	const dirtyObj =
		typeof obj.dirty === "object" && obj.dirty !== null
			? (obj.dirty as Record<string, unknown>)
			: null;

	if (!lastSyncedAt || !todos || !serverIdToThingsId) {
		throw new Error("State file is corrupted (missing fields).");
	}

	const dirty: DirtyState = {
		upserted: Array.isArray(dirtyObj?.upserted)
			? (dirtyObj?.upserted as string[])
			: [],
		deleted: {},
	};

	if (dirtyObj?.deleted) {
		if (Array.isArray(dirtyObj.deleted)) {
			for (const serverId of dirtyObj.deleted) {
				if (typeof serverId === "string") {
					dirty.deleted[serverId] = new Date().toISOString();
				}
			}
		} else if (
			typeof dirtyObj.deleted === "object" &&
			dirtyObj.deleted !== null
		) {
			for (const [serverId, deletedAt] of Object.entries(
				dirtyObj.deleted as Record<string, unknown>,
			)) {
				if (typeof deletedAt === "string") {
					dirty.deleted[serverId] = deletedAt;
				}
			}
		}
	}

	// Ensure todos have editedAt (migrate from v1 if missing)
	for (const [thingsId, todo] of Object.entries(todos)) {
		if (!todo.editedAt) {
			todos[thingsId] = {
				thingsId,
				title: todo.title || "",
				notes: todo.notes || "",
				dueDate: todo.dueDate ?? null,
				tags: Array.isArray(todo.tags) ? todo.tags : [],
				status: (todo.status as LocalTodoState["status"]) || "open",
				position:
					typeof todo.position === "number" && Number.isFinite(todo.position)
						? todo.position
						: 0,
				editedAt: lastSyncedAt,
			};
		} else if (
			typeof todo.position !== "number" ||
			!Number.isFinite(todo.position)
		) {
			todos[thingsId] = {
				...todo,
				position: 0,
			};
		}
	}

	validateMapping(todos, serverIdToThingsId);

	return {
		lastSyncedAt,
		todos,
		serverIdToThingsId,
		dirty,
	};
}

function saveLocalState(state: LocalState): void {
	ensureConfigDir();
	const tempFile = `${STATE_FILE}.tmp-${process.pid}`;
	const data = JSON.stringify(state, null, 2);
	fs.writeFileSync(tempFile, data);
	fs.renameSync(tempFile, STATE_FILE);
}

function acquireLock(): boolean {
	ensureConfigDir();
	if (fs.existsSync(LOCK_FILE)) {
		const pid = parseInt(fs.readFileSync(LOCK_FILE, "utf-8"), 10);
		if (pid) {
			try {
				process.kill(pid, 0);
				return false;
			} catch {
				fs.unlinkSync(LOCK_FILE);
			}
		}
	}
	fs.writeFileSync(LOCK_FILE, String(process.pid));
	return true;
}

function releaseLock(): void {
	if (fs.existsSync(LOCK_FILE)) {
		fs.unlinkSync(LOCK_FILE);
	}
}

function appendConflicts(entries: ConflictEntry[]): void {
	if (entries.length === 0) return;
	ensureConfigDir();
	let existing: ConflictEntry[] = [];
	if (fs.existsSync(CONFLICTS_FILE)) {
		try {
			const raw = fs.readFileSync(CONFLICTS_FILE, "utf-8");
			existing = JSON.parse(raw) as ConflictEntry[];
		} catch {
			existing = [];
		}
	}
	const next = [...existing, ...entries];
	const tempFile = `${CONFLICTS_FILE}.tmp-${process.pid}`;
	fs.writeFileSync(tempFile, JSON.stringify(next, null, 2));
	fs.renameSync(tempFile, CONFLICTS_FILE);
}

function notifyConflicts(count: number): void {
	if (count <= 0) return;
	try {
		const message = `Sync complete. ${count} conflict${
			count === 1 ? "" : "s"
		} resolved (your edits were older).`;
		const safeMessage = message.replace(/"/g, '\\"');
		const cmd = `osascript -e 'display notification "${safeMessage}" with title "shared-things"'`;
		execSync(cmd);
	} catch {
		// ignore notification errors
	}
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
		logWarn("Sync skipped: another sync process is running.");
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
	logDebug(
		`Loaded state: todos=${Object.keys(localState.todos).length}, mappings=${Object.keys(localState.serverIdToThingsId).length}, dirtyUpserted=${localState.dirty.upserted.length}, dirtyDeleted=${Object.keys(localState.dirty.deleted).length}`,
	);
	logInfo("Sync started");

	const api = new ApiClient(config.serverUrl, config.apiKey);
	const isFirstSync =
		Object.keys(localState.todos).length === 0 &&
		Object.keys(localState.serverIdToThingsId).length === 0;

	let pushed = 0;
	let pulled = 0;
	let conflictCount = 0;

	try {
		// 1. Read current Things state
		const currentTodos = getTodosFromProject(config.projectName);
		logDebug(`Read Things: todos=${currentTodos.length}`);
		const positionMap = new Map(
			currentTodos.map((todo, idx) => [todo.thingsId, idx]),
		);
		const currentTodosMap = new Map(currentTodos.map((t) => [t.thingsId, t]));

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

		for (const thingsId of Object.keys(localState.todos)) {
			if (!currentTodosMap.has(thingsId)) {
				const serverId = findServerId(localState.serverIdToThingsId, thingsId);
				if (serverId) {
					if (!localState.dirty.deleted[serverId]) {
						localState.dirty.deleted[serverId] = now;
					}
				}
				delete localState.todos[thingsId];
			}
		}

		localState.dirty.upserted = Array.from(dirtyUpserted);
		localState.dirty.upserted = localState.dirty.upserted.filter((id) =>
			currentTodosMap.has(id),
		);
		logDebug(
			`Local changes: upserted=${localState.dirty.upserted.length}, deleted=${Object.keys(localState.dirty.deleted).length}`,
		);

		// 3. Build push payload
		const pushUpserts = buildUpserts(currentTodosMap, localState);
		const pushDeletes = buildDeletes(currentTodosMap, localState);
		logDebug(
			`Push payload: upserted=${pushUpserts.length}, deleted=${pushDeletes.length}`,
		);
		if (pushUpserts.length > 0 || pushDeletes.length > 0) {
			logDebug(
				`Push payload body: ${JSON.stringify({
					todos: { upserted: pushUpserts, deleted: pushDeletes },
					lastSyncedAt: localState.lastSyncedAt,
				})}`,
			);
		}

		// 4. Push to server
		if (pushUpserts.length > 0 || pushDeletes.length > 0) {
			const pushResponse = await api.push({
				todos: {
					upserted: pushUpserts,
					deleted: pushDeletes,
				},
				lastSyncedAt: localState.lastSyncedAt,
			});

			pushed = pushUpserts.length + pushDeletes.length;
			processPushMappings(localState, pushResponse);

			const conflictEntries = conflictsFromPush(pushResponse);
			logDebug(
				`Push response: conflicts=${conflictEntries.length}, mappings=${pushResponse.mappings?.length ?? 0}`,
			);
			conflictCount += conflictEntries.length;
			appendConflicts(conflictEntries);

			localState.dirty = { upserted: [], deleted: {} };
		}

		// 5. Pull from server
		const delta = await getServerDelta(api, localState, currentTodos);
		logDebug(
			`Delta response: upserted=${delta.todos.upserted.length}, deleted=${delta.todos.deleted.length}, syncedAt=${delta.syncedAt}`,
		);
		const remoteResult = await applyRemoteChanges(
			config.thingsAuthToken,
			config.projectName,
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
		logSync(pushed, pulled, isFirstSync, conflictCount);
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

function hasChanged(
	prev: LocalTodoState,
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

function buildUpserts(
	currentTodosMap: Map<string, ThingsTodo>,
	state: LocalState,
) {
	const thingsIdToServerId = invertMapping(state.serverIdToThingsId);

	const upserts: Array<{
		serverId?: string;
		clientId?: string;
		title: string;
		notes: string;
		dueDate: string | null;
		tags: string[];
		status: "open" | "completed" | "canceled";
		position: number;
		editedAt: string;
	}> = [];

	for (const thingsId of state.dirty.upserted) {
		const todo = currentTodosMap.get(thingsId);
		const stored = state.todos[thingsId];
		if (!todo || !stored) continue;

		upserts.push({
			serverId: thingsIdToServerId.get(thingsId),
			clientId: thingsId,
			title: stored.title,
			notes: stored.notes,
			dueDate: stored.dueDate,
			tags: stored.tags,
			status: stored.status,
			position: stored.position,
			editedAt: stored.editedAt,
		});
	}

	return upserts;
}

function buildDeletes(
	currentTodosMap: Map<string, ThingsTodo>,
	state: LocalState,
) {
	const deletes: Array<{ serverId: string; deletedAt: string }> = [];

	for (const [serverId, deletedAt] of Object.entries(state.dirty.deleted)) {
		const thingsId = state.serverIdToThingsId[serverId];
		if (thingsId && currentTodosMap.has(thingsId)) {
			// Todo reappeared locally; drop pending delete
			delete state.dirty.deleted[serverId];
			continue;
		}
		deletes.push({ serverId, deletedAt });
	}

	return deletes;
}

function processPushMappings(state: LocalState, response: PushResponse): void {
	if (!response.mappings) return;
	for (const mapping of response.mappings) {
		if (!mapping.clientId) continue;
		setMapping(state, mapping.serverId, mapping.clientId);
	}
}

function conflictsFromPush(response: PushResponse): ConflictEntry[] {
	if (!response.conflicts || response.conflicts.length === 0) return [];
	const timestamp = new Date().toISOString();

	return response.conflicts.map((conflict) => ({
		timestamp,
		serverId: conflict.serverId,
		title:
			conflict.clientTodo?.title || conflict.serverTodo?.title || "Unknown",
		yourVersion: conflict.clientTodo
			? {
					title: conflict.clientTodo.title,
					editedAt: conflict.clientTodo.editedAt,
				}
			: conflict.clientDeletedAt
				? { deletedAt: conflict.clientDeletedAt }
				: {},
		winningVersion: conflict.serverTodo
			? {
					title: conflict.serverTodo.title,
					editedAt: conflict.serverTodo.editedAt,
				}
			: conflict.clientDeletedAt
				? { deletedAt: conflict.clientDeletedAt }
				: {},
		reason: conflict.reason,
	}));
}

async function getServerDelta(
	api: ApiClient,
	state: LocalState,
	currentTodos: ThingsTodo[],
) {
	const shouldBootstrap =
		Object.keys(state.todos).length === 0 &&
		Object.keys(state.serverIdToThingsId).length === 0 &&
		currentTodos.length === 0;

	if (shouldBootstrap) {
		const fullState = await api.getState();
		return {
			todos: {
				upserted: fullState.todos,
				deleted: [],
			},
			syncedAt: fullState.syncedAt,
		};
	}

	return api.getDelta(state.lastSyncedAt);
}

async function applyRemoteChanges(
	authToken: string,
	projectName: string,
	upserted: Todo[],
	deleted: { serverId: string; deletedAt: string }[],
	currentTodosMap: Map<string, ThingsTodo>,
	state: LocalState,
): Promise<{ applied: number; conflicts: ConflictEntry[] }> {
	let applied = 0;
	const conflicts: ConflictEntry[] = [];

	for (const remoteTodo of upserted) {
		const localThingsId = state.serverIdToThingsId[remoteTodo.id];
		const localTodo = localThingsId
			? currentTodosMap.get(localThingsId)
			: undefined;
		const localStateTodo = localThingsId
			? state.todos[localThingsId]
			: undefined;

		if (!localTodo || !localThingsId) {
			const before = new Set(currentTodosMap.keys());
			createTodo(projectName, {
				title: remoteTodo.title,
				notes: remoteTodo.notes,
				dueDate: remoteTodo.dueDate || undefined,
				tags: remoteTodo.tags,
			});
			logTodoCreated(remoteTodo.title);

			const newTodo = await findNewTodo(projectName, before, remoteTodo.title);
			if (newTodo) {
				setMapping(state, remoteTodo.id, newTodo.thingsId);
				state.todos[newTodo.thingsId] = {
					thingsId: newTodo.thingsId,
					title: remoteTodo.title,
					notes: remoteTodo.notes,
					dueDate: remoteTodo.dueDate,
					tags: remoteTodo.tags,
					status: remoteTodo.status,
					position: remoteTodo.position,
					editedAt: remoteTodo.editedAt,
				};
				currentTodosMap.set(newTodo.thingsId, newTodo);
				if (remoteTodo.status !== "open") {
					try {
						updateTodo(authToken, newTodo.thingsId, {
							completed: remoteTodo.status === "completed",
							canceled: remoteTodo.status === "canceled",
						});
					} catch (error) {
						logWarn(
							`Failed to set status for ${newTodo.thingsId}: ${String(error)}`,
						);
					}
				}
			} else {
				logWarn(`Failed to locate created todo for server ${remoteTodo.id}`);
			}
			applied += 1;
			continue;
		}

		// Apply remote update if:
		// - No local state (first sync of this item), OR
		// - Remote editedAt >= local editedAt (server already resolved ties via userId)
		// The server only sends items in delta that should be applied.
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
			logTodoUpdated(localTodo.thingsId, remoteTodo.title);
			state.todos[localTodo.thingsId] = {
				thingsId: localTodo.thingsId,
				title: remoteTodo.title,
				notes: remoteTodo.notes,
				dueDate: remoteTodo.dueDate,
				tags: remoteTodo.tags,
				status: remoteTodo.status,
				position: remoteTodo.position,
				editedAt: remoteTodo.editedAt,
			};
			applied += 1;
		}
	}

	for (const deletion of deleted) {
		const localThingsId = state.serverIdToThingsId[deletion.serverId];
		if (!localThingsId) continue;
		const existsInThings = currentTodosMap.has(localThingsId);
		const localStateTodo = state.todos[localThingsId];
		if (!existsInThings && !localStateTodo) {
			delete state.serverIdToThingsId[deletion.serverId];
			continue;
		}
		if (!localStateTodo) continue;

		// Skip if local edit is strictly newer than the delete timestamp
		// (If equal, server already resolved via tiebreaker - trust server's delta)
		if (compareIso(deletion.deletedAt, localStateTodo.editedAt) < 0) {
			continue;
		}

		conflicts.push({
			timestamp: new Date().toISOString(),
			serverId: deletion.serverId,
			title: localStateTodo.title,
			yourVersion: {
				title: localStateTodo.title,
				editedAt: localStateTodo.editedAt,
			},
			winningVersion: { deletedAt: deletion.deletedAt },
			reason: "Remote delete was newer (manual delete required)",
		});
	}

	return { applied, conflicts };
}

function invertMapping(mapping: Record<string, string>): Map<string, string> {
	const result = new Map<string, string>();
	for (const [serverId, thingsId] of Object.entries(mapping)) {
		result.set(thingsId, serverId);
	}
	return result;
}

function findServerId(
	mapping: Record<string, string>,
	thingsId: string,
): string | undefined {
	for (const [serverId, mappedThingsId] of Object.entries(mapping)) {
		if (mappedThingsId === thingsId) return serverId;
	}
	return undefined;
}

function setMapping(
	state: LocalState,
	serverId: string,
	thingsId: string,
): void {
	const existing = state.serverIdToThingsId[serverId];
	if (existing && existing !== thingsId) {
		if (state.todos[existing]) {
			throw new Error(
				`Duplicate mapping detected for serverId ${serverId} (${existing} vs ${thingsId})`,
			);
		}
	}
	for (const [sid, tid] of Object.entries(state.serverIdToThingsId)) {
		if (tid === thingsId && sid !== serverId) {
			throw new Error(
				`Duplicate mapping detected for thingsId ${thingsId} (${sid} vs ${serverId})`,
			);
		}
	}
	state.serverIdToThingsId[serverId] = thingsId;
	logMapping(serverId, thingsId);
}

function validateMapping(
	todos: Record<string, LocalTodoState>,
	mapping: Record<string, string>,
): void {
	const thingsIds = new Set(Object.values(mapping));
	if (thingsIds.size !== Object.values(mapping).length) {
		throw new Error("Invalid mapping detected: duplicate thingsId entries.");
	}
	for (const thingsId of Object.values(mapping)) {
		if (!todos[thingsId]) {
		}
	}
}

function compareIso(a: string, b: string): number {
	return new Date(a).getTime() - new Date(b).getTime();
}

async function findNewTodo(
	projectName: string,
	before: Set<string>,
	title: string,
): Promise<ThingsTodo | undefined> {
	for (let attempt = 0; attempt < 3; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 500));
		const after = getTodosFromProject(projectName);
		const found = after.find(
			(t) => !before.has(t.thingsId) && t.title === title,
		);
		if (found) return found;
	}
	return undefined;
}
