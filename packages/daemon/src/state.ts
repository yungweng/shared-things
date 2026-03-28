/**
 * Local state management (extracted from v2 sync.ts)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ensureConfigDir, getConfigDir } from "./config.js";

const STATE_FILE = path.join(getConfigDir(), "state.json");
const STATE_BAK_FILE = path.join(getConfigDir(), "state.json.bak");
const LOCK_FILE = path.join(getConfigDir(), "sync.lock");
const CONFLICTS_FILE = path.join(getConfigDir(), "conflicts.json");

export interface LocalTodoState {
	thingsId: string;
	title: string;
	notes: string;
	dueDate: string | null;
	tags: string[];
	status: "open" | "completed" | "canceled";
	position: number;
	editedAt: string;
}

export interface DirtyState {
	upserted: string[];
	deleted: Record<string, string>; // serverId -> deletedAt
}

export interface LocalState {
	lastSyncedAt: string;
	todos: Record<string, LocalTodoState>;
	serverIdToThingsId: Record<string, string>;
	dirty: DirtyState;
}

export interface ConflictEntry {
	timestamp: string;
	serverId: string;
	title: string;
	yourVersion: { title?: string; editedAt?: string; deletedAt?: string };
	winningVersion: { title?: string; editedAt?: string; deletedAt?: string };
	reason: string;
}

export function loadLocalState(): LocalState {
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

	if (dirtyObj?.deleted && typeof dirtyObj.deleted === "object") {
		for (const [serverId, deletedAt] of Object.entries(
			dirtyObj.deleted as Record<string, unknown>,
		)) {
			if (typeof deletedAt === "string") {
				dirty.deleted[serverId] = deletedAt;
			}
		}
	}

	// Ensure todos have valid fields
	for (const [thingsId, todo] of Object.entries(todos)) {
		if (!todo.editedAt) {
			todos[thingsId] = {
				thingsId,
				title: todo.title || "",
				notes: todo.notes || "",
				dueDate: todo.dueDate ?? null,
				tags: Array.isArray(todo.tags) ? todo.tags : [],
				status: todo.status || "open",
				position:
					typeof todo.position === "number" && Number.isFinite(todo.position)
						? todo.position
						: 0,
				editedAt: lastSyncedAt,
			};
		}
	}

	return { lastSyncedAt, todos, serverIdToThingsId, dirty };
}

export function saveLocalState(state: LocalState): void {
	ensureConfigDir();
	const tempFile = `${STATE_FILE}.tmp-${process.pid}`;
	fs.writeFileSync(tempFile, JSON.stringify(state, null, 2));
	fs.renameSync(tempFile, STATE_FILE);
}

export function writeInitialState(): void {
	const state: LocalState = {
		lastSyncedAt: new Date().toISOString(),
		todos: {},
		serverIdToThingsId: {},
		dirty: { upserted: [], deleted: {} },
	};
	saveLocalState(state);
}

export function acquireLock(): boolean {
	ensureConfigDir();
	if (fs.existsSync(LOCK_FILE)) {
		const pid = Number.parseInt(fs.readFileSync(LOCK_FILE, "utf-8"), 10);
		if (pid) {
			try {
				process.kill(pid, 0);
				return false; // Process still running
			} catch {
				fs.unlinkSync(LOCK_FILE); // Stale lock
			}
		}
	}
	fs.writeFileSync(LOCK_FILE, String(process.pid));
	return true;
}

export function releaseLock(): void {
	if (fs.existsSync(LOCK_FILE)) {
		fs.unlinkSync(LOCK_FILE);
	}
}

export function appendConflicts(entries: ConflictEntry[]): void {
	if (entries.length === 0) return;
	ensureConfigDir();
	let existing: ConflictEntry[] = [];
	if (fs.existsSync(CONFLICTS_FILE)) {
		try {
			existing = JSON.parse(fs.readFileSync(CONFLICTS_FILE, "utf-8"));
		} catch {
			existing = [];
		}
	}
	const next = [...existing, ...entries];
	const tempFile = `${CONFLICTS_FILE}.tmp-${process.pid}`;
	fs.writeFileSync(tempFile, JSON.stringify(next, null, 2));
	fs.renameSync(tempFile, CONFLICTS_FILE);
}

export function readConflicts(): ConflictEntry[] {
	if (!fs.existsSync(CONFLICTS_FILE)) return [];
	try {
		return JSON.parse(fs.readFileSync(CONFLICTS_FILE, "utf-8"));
	} catch {
		return [];
	}
}

export function setMapping(
	state: LocalState,
	serverId: string,
	thingsId: string,
): void {
	state.serverIdToThingsId[serverId] = thingsId;
}

export function findServerId(
	mapping: Record<string, string>,
	thingsId: string,
): string | undefined {
	for (const [serverId, mapped] of Object.entries(mapping)) {
		if (mapped === thingsId) return serverId;
	}
	return undefined;
}

export function invertMapping(
	mapping: Record<string, string>,
): Map<string, string> {
	const result = new Map<string, string>();
	for (const [serverId, thingsId] of Object.entries(mapping)) {
		result.set(thingsId, serverId);
	}
	return result;
}
