/**
 * Integration tests: 1 real server + 2 simulated daemons (mocked Things)
 *
 * Tests the full sync flow without requiring Things 3 installed.
 * Each "daemon" is an ApiClient + in-memory Things mock + sync logic.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	ProjectState,
	PushRequest,
	PushResponse,
	PushTodo,
	SyncDelta,
	Todo,
} from "@shared-things/common";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Set DATA_DIR before importing server modules (they read it at import time)
const tmpDir = fs.mkdtempSync(
	path.join(os.tmpdir(), `shared-things-test-${Date.now()}-`),
);
process.env.DATA_DIR = tmpDir;

const { createUser, initDatabase } = await import("../db.js");
const { createServer } = await import("../index.js");

// =============================================================================
// In-memory Things mock
// =============================================================================

interface MockTodo {
	thingsId: string;
	title: string;
	notes: string;
	dueDate: string | null;
	tags: string[];
	status: "open" | "completed" | "canceled";
	projectName: string | null;
}

class ThingsMock {
	todos = new Map<string, MockTodo>();

	getTodos(): MockTodo[] {
		return Array.from(this.todos.values());
	}

	createTodo(
		projectName: string | null,
		todo: { title: string; notes?: string; dueDate?: string; tags?: string[] },
	): string {
		const thingsId = crypto.randomUUID();
		this.todos.set(thingsId, {
			thingsId,
			title: todo.title,
			notes: todo.notes || "",
			dueDate: todo.dueDate || null,
			tags: todo.tags || [],
			status: "open",
			projectName,
		});
		return thingsId;
	}

	updateTodo(
		thingsId: string,
		updates: Partial<Pick<MockTodo, "title" | "notes" | "dueDate" | "status">>,
	): void {
		const todo = this.todos.get(thingsId);
		if (!todo) throw new Error(`Todo ${thingsId} not found`);
		Object.assign(todo, updates);
	}

	deleteTodo(thingsId: string): void {
		this.todos.delete(thingsId);
	}
}

// =============================================================================
// Simulated daemon (API client + state + mock Things)
// =============================================================================

class SimulatedDaemon {
	things = new ThingsMock();
	serverIdToThingsId: Record<string, string> = {};
	lastSyncedAt = new Date(0).toISOString();
	/** Snapshot of todos from last sync (for change detection) */
	private lastKnownTodos = new Map<string, MockTodo>();
	private baseUrl: string;
	private apiKey: string;

	constructor(baseUrl: string, apiKey: string) {
		this.baseUrl = baseUrl;
		this.apiKey = apiKey;
	}

	private async request<T>(
		path: string,
		options: RequestInit = {},
	): Promise<T> {
		const res = await fetch(`${this.baseUrl}${path}`, {
			...options,
			headers: {
				Authorization: `Bearer ${this.apiKey}`,
				"Content-Type": "application/json",
				...options.headers,
			},
		});
		if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
		return res.json() as Promise<T>;
	}

	/** Run a full sync cycle (like runSync in the daemon) */
	async sync(): Promise<{ pushed: number; pulled: number }> {
		const currentTodos = this.things.getTodos();
		const thingsIdToServerId = new Map<string, string>();
		for (const [sid, tid] of Object.entries(this.serverIdToThingsId)) {
			thingsIdToServerId.set(tid, sid);
		}

		// Build upserts: only NEW or CHANGED todos (not all)
		const upserts: PushTodo[] = [];
		for (const t of currentTodos) {
			const prev = this.lastKnownTodos.get(t.thingsId);
			const isNew = !prev;
			const isChanged =
				prev &&
				(prev.title !== t.title ||
					prev.notes !== t.notes ||
					prev.status !== t.status ||
					prev.dueDate !== t.dueDate ||
					JSON.stringify(prev.tags) !== JSON.stringify(t.tags));

			if (isNew || isChanged) {
				upserts.push({
					serverId: thingsIdToServerId.get(t.thingsId),
					clientId: t.thingsId,
					title: t.title,
					notes: t.notes,
					dueDate: t.dueDate,
					tags: t.tags,
					status: t.status,
					position: 0,
					projectName: t.projectName,
					editedAt: new Date().toISOString(),
				});
			}
		}

		// Build deletes: mappings where Things no longer has the todo
		const currentIds = new Set(currentTodos.map((t) => t.thingsId));
		const deletes: { serverId: string; deletedAt: string }[] = [];
		for (const [serverId, thingsId] of Object.entries(
			this.serverIdToThingsId,
		)) {
			if (!currentIds.has(thingsId)) {
				deletes.push({ serverId, deletedAt: new Date().toISOString() });
			}
		}

		let pushed = 0;

		// Push if there are changes
		if (upserts.length > 0 || deletes.length > 0) {
			const pushResponse = await this.request<PushResponse>("/push", {
				method: "POST",
				body: JSON.stringify({
					todos: { upserted: upserts, deleted: deletes },
					lastSyncedAt: this.lastSyncedAt,
				} satisfies PushRequest),
			});

			pushed = upserts.length + deletes.length;

			// Process mappings for new todos
			if (pushResponse.mappings) {
				for (const m of pushResponse.mappings) {
					this.serverIdToThingsId[m.serverId] = m.clientId;
				}
			}

			// Clean up deleted mappings
			for (const d of deletes) {
				delete this.serverIdToThingsId[d.serverId];
			}
		}

		// Pull changes
		const isFirstSync =
			Object.keys(this.serverIdToThingsId).length === 0 &&
			currentTodos.length === 0;
		let delta: {
			todos: { upserted: Todo[]; deleted: any[] };
			syncedAt: string;
		};

		if (isFirstSync) {
			const state = await this.request<ProjectState>("/state");
			delta = {
				todos: { upserted: state.todos, deleted: [] },
				syncedAt: state.syncedAt,
			};
		} else {
			delta = await this.request<SyncDelta>(
				`/delta?since=${encodeURIComponent(this.lastSyncedAt)}`,
			);
		}

		let pulled = 0;

		// Apply remote upserts
		for (const remoteTodo of delta.todos.upserted) {
			const localThingsId = this.serverIdToThingsId[remoteTodo.id];
			if (!localThingsId) {
				// Create new todo locally
				const newId = this.things.createTodo(remoteTodo.projectName, {
					title: remoteTodo.title,
					notes: remoteTodo.notes,
					dueDate: remoteTodo.dueDate || undefined,
					tags: remoteTodo.tags,
				});
				if (remoteTodo.status !== "open") {
					this.things.updateTodo(newId, { status: remoteTodo.status });
				}
				this.serverIdToThingsId[remoteTodo.id] = newId;
				pulled++;
			} else {
				// Update existing todo locally
				this.things.updateTodo(localThingsId, {
					title: remoteTodo.title,
					notes: remoteTodo.notes,
					dueDate: remoteTodo.dueDate,
					status: remoteTodo.status,
				});
				pulled++;
			}
		}

		// Apply remote deletes
		for (const deletion of delta.todos.deleted) {
			const localThingsId = this.serverIdToThingsId[deletion.serverId];
			if (localThingsId) {
				this.things.deleteTodo(localThingsId);
				delete this.serverIdToThingsId[deletion.serverId];
				pulled++;
			}
		}

		this.lastSyncedAt = delta.syncedAt;

		// Snapshot current state for next change detection
		this.lastKnownTodos.clear();
		for (const t of this.things.getTodos()) {
			this.lastKnownTodos.set(t.thingsId, { ...t });
		}

		return { pushed, pulled };
	}
}

// =============================================================================
// Test suite
// =============================================================================

describe("Integration: 2 daemons + 1 server", () => {
	let server: Awaited<ReturnType<typeof createServer>>;
	let daemonA: SimulatedDaemon;
	let daemonB: SimulatedDaemon;
	let port: number;

	beforeAll(async () => {
		port = 10000 + Math.floor(Math.random() * 50000);
		server = await createServer({ port, host: "127.0.0.1", logger: false });

		const db = initDatabase();
		const userA = createUser(db, "userA");
		const userB = createUser(db, "userB");

		daemonA = new SimulatedDaemon(`http://127.0.0.1:${port}`, userA.apiKey);
		daemonB = new SimulatedDaemon(`http://127.0.0.1:${port}`, userB.apiKey);
	});

	afterAll(async () => {
		server.wsManager.close();
		await server.app.close();
	});

	beforeEach(() => {
		// Reset daemon state between tests
		daemonA.things = new ThingsMock();
		daemonA.serverIdToThingsId = {};
		daemonA.lastSyncedAt = new Date(0).toISOString();
		daemonB.things = new ThingsMock();
		daemonB.serverIdToThingsId = {};
		daemonB.lastSyncedAt = new Date(0).toISOString();

		// Clear server DB between tests
		const db = initDatabase();
		db.exec("DELETE FROM todos");
		db.exec("DELETE FROM deleted_items");
	});

	it("health check returns ok", async () => {
		const res = await fetch(`http://127.0.0.1:${port}/health`);
		const body = await res.json();
		expect(body.status).toBe("ok");
	});

	it("daemon A creates todo → daemon B receives it", async () => {
		// A creates a todo locally
		daemonA.things.createTodo("TestProject", { title: "Buy milk" });
		expect(daemonA.things.getTodos()).toHaveLength(1);

		// A syncs → pushes to server
		const syncA = await daemonA.sync();
		expect(syncA.pushed).toBeGreaterThan(0);

		// B syncs → pulls from server
		const syncB = await daemonB.sync();
		expect(syncB.pulled).toBeGreaterThan(0);

		// B should have the todo
		const bTodos = daemonB.things.getTodos();
		expect(bTodos).toHaveLength(1);
		expect(bTodos[0].title).toBe("Buy milk");
	});

	it("daemon B updates todo → daemon A receives update", async () => {
		// A creates and syncs
		daemonA.things.createTodo("TestProject", { title: "Original title" });
		await daemonA.sync();

		// B pulls
		await daemonB.sync();
		const bTodos = daemonB.things.getTodos();
		expect(bTodos).toHaveLength(1);

		// B updates the todo
		daemonB.things.updateTodo(bTodos[0].thingsId, { title: "Updated title" });

		// B syncs → pushes update
		await daemonB.sync();

		// A syncs → pulls update
		await daemonA.sync();
		const aTodos = daemonA.things.getTodos();
		expect(aTodos).toHaveLength(1);
		expect(aTodos[0].title).toBe("Updated title");
	});

	it("daemon A deletes todo → daemon B receives deletion", async () => {
		// A creates and syncs
		daemonA.things.createTodo("TestProject", { title: "Delete me" });
		await daemonA.sync();

		// B pulls
		await daemonB.sync();
		expect(daemonB.things.getTodos()).toHaveLength(1);

		// A deletes the todo
		const aTodos = daemonA.things.getTodos();
		daemonA.things.deleteTodo(aTodos[0].thingsId);
		expect(daemonA.things.getTodos()).toHaveLength(0);

		// A syncs → pushes deletion
		await daemonA.sync();

		// B syncs → pulls deletion
		await daemonB.sync();
		expect(daemonB.things.getTodos()).toHaveLength(0);
	});

	it("multiple todos sync correctly", async () => {
		// A creates 3 todos
		daemonA.things.createTodo("TestProject", { title: "Todo 1" });
		daemonA.things.createTodo("TestProject", { title: "Todo 2" });
		daemonA.things.createTodo(null, { title: "Loose todo" });
		await daemonA.sync();

		// B pulls all 3
		await daemonB.sync();
		const bTodos = daemonB.things.getTodos();
		expect(bTodos).toHaveLength(3);

		const titles = bTodos.map((t) => t.title).sort();
		expect(titles).toEqual(["Loose todo", "Todo 1", "Todo 2"]);
	});

	it("both daemons create todos simultaneously", async () => {
		// A creates a todo
		daemonA.things.createTodo("TestProject", { title: "From A" });
		await daemonA.sync();

		// B creates a todo (before pulling A's)
		daemonB.things.createTodo("TestProject", { title: "From B" });
		await daemonB.sync();

		// Now both sync again to get each other's todos
		await daemonA.sync();
		await daemonB.sync();

		// Both should have 2 todos
		expect(daemonA.things.getTodos()).toHaveLength(2);
		expect(daemonB.things.getTodos()).toHaveLength(2);

		const aTitles = daemonA.things
			.getTodos()
			.map((t) => t.title)
			.sort();
		const bTitles = daemonB.things
			.getTodos()
			.map((t) => t.title)
			.sort();
		expect(aTitles).toEqual(["From A", "From B"]);
		expect(bTitles).toEqual(["From A", "From B"]);
	});

	it("todo with notes, tags, and due date syncs correctly", async () => {
		daemonA.things.createTodo("TestProject", {
			title: "Detailed todo",
			notes: "These are some notes\nwith newlines",
			dueDate: "2026-12-25",
			tags: ["urgent", "work"],
		});
		await daemonA.sync();

		await daemonB.sync();
		const bTodos = daemonB.things.getTodos();
		expect(bTodos).toHaveLength(1);
		expect(bTodos[0].title).toBe("Detailed todo");
		expect(bTodos[0].notes).toBe("These are some notes\nwith newlines");
		expect(bTodos[0].dueDate).toBe("2026-12-25");
		expect(bTodos[0].tags).toEqual(["urgent", "work"]);
	});

	it("projectName is preserved through sync", async () => {
		daemonA.things.createTodo("Shopping", { title: "Milk" });
		daemonA.things.createTodo("Work", { title: "Meeting" });
		daemonA.things.createTodo(null, { title: "Loose" });
		await daemonA.sync();

		await daemonB.sync();
		const bTodos = daemonB.things.getTodos();
		expect(bTodos).toHaveLength(3);

		const byTitle = new Map(bTodos.map((t) => [t.title, t]));
		expect(byTitle.get("Milk")?.projectName).toBe("Shopping");
		expect(byTitle.get("Meeting")?.projectName).toBe("Work");
		expect(byTitle.get("Loose")?.projectName).toBeNull();
	});

	it("completing a todo syncs status", async () => {
		daemonA.things.createTodo("TestProject", { title: "Complete me" });
		await daemonA.sync();

		await daemonB.sync();
		const bTodos = daemonB.things.getTodos();
		expect(bTodos[0].status).toBe("open");

		// B completes the todo
		daemonB.things.updateTodo(bTodos[0].thingsId, { status: "completed" });
		await daemonB.sync();

		await daemonA.sync();
		const aTodos = daemonA.things.getTodos();
		expect(aTodos[0].status).toBe("completed");
	});

	it("conflict: both update same todo → last write wins", async () => {
		// A creates todo, both sync
		daemonA.things.createTodo("TestProject", { title: "Original" });
		await daemonA.sync();
		await daemonB.sync();

		// A updates and syncs first
		const aTodos = daemonA.things.getTodos();
		daemonA.things.updateTodo(aTodos[0].thingsId, { title: "A's version" });
		await daemonA.sync();

		// Ensure B's edit has a strictly newer timestamp
		await new Promise((r) => setTimeout(r, 50));

		// B updates and syncs (newer timestamp → B wins)
		const bTodos = daemonB.things.getTodos();
		daemonB.things.updateTodo(bTodos[0].thingsId, { title: "B's version" });
		await daemonB.sync();

		// Both sync again to converge
		await daemonA.sync();
		await daemonB.sync();

		// Both should have B's version (last write wins)
		const aFinal = daemonA.things.getTodos();
		const bFinal = daemonB.things.getTodos();
		expect(aFinal).toHaveLength(1);
		expect(bFinal).toHaveLength(1);
		expect(aFinal[0].title).toBe("B's version");
		expect(bFinal[0].title).toBe("B's version");
	});

	it("conflict: edit vs delete", async () => {
		// A creates todo, both sync
		daemonA.things.createTodo("TestProject", { title: "Contested" });
		await daemonA.sync();
		await daemonB.sync();

		// A deletes the todo
		const aTodos = daemonA.things.getTodos();
		daemonA.things.deleteTodo(aTodos[0].thingsId);

		// Small delay so B's edit has a newer timestamp
		await new Promise((r) => setTimeout(r, 10));

		// B updates the todo title (newer timestamp)
		const bTodos = daemonB.things.getTodos();
		daemonB.things.updateTodo(bTodos[0].thingsId, { title: "B edited this" });

		// A syncs first (pushes delete)
		await daemonA.sync();

		// B syncs (pushes edit with newer timestamp → edit wins over delete)
		await daemonB.sync();

		// Both sync again to converge
		await daemonA.sync();
		await daemonB.sync();

		// The newer edit should win: todo should exist with B's title
		const aFinal = daemonA.things.getTodos();
		const bFinal = daemonB.things.getTodos();
		expect(aFinal).toHaveLength(1);
		expect(bFinal).toHaveLength(1);
		expect(aFinal[0].title).toBe("B edited this");
		expect(bFinal[0].title).toBe("B edited this");
	});

	it("auth: request without API key returns 401", async () => {
		const res = await fetch(`http://127.0.0.1:${port}/state`);
		expect(res.status).toBe(401);
	});

	it("auth: invalid API key returns 401", async () => {
		const res = await fetch(`http://127.0.0.1:${port}/state`, {
			headers: { Authorization: "Bearer totally-wrong-key" },
		});
		expect(res.status).toBe(401);
	});

	it("idempotent push: syncing twice without changes pushes nothing", async () => {
		// A creates todo and syncs
		daemonA.things.createTodo("TestProject", { title: "Stable" });
		const first = await daemonA.sync();
		expect(first.pushed).toBeGreaterThan(0);

		// A syncs again with no changes → should push nothing
		const second = await daemonA.sync();
		expect(second.pushed).toBe(0);
	});

	it("re-sync after reset: daemon recovers gracefully", async () => {
		// A creates 3 todos and syncs
		daemonA.things.createTodo("TestProject", { title: "One" });
		daemonA.things.createTodo("TestProject", { title: "Two" });
		daemonA.things.createTodo("TestProject", { title: "Three" });
		await daemonA.sync();

		// B syncs (gets all 3)
		await daemonB.sync();
		expect(daemonB.things.getTodos()).toHaveLength(3);

		// Reset B's state (simulates a fresh start)
		daemonB.things = new ThingsMock();
		daemonB.serverIdToThingsId = {};
		daemonB.lastSyncedAt = new Date(0).toISOString();
		(daemonB as any).lastKnownTodos = new Map();

		// B syncs again from scratch → should pull all 3 from server
		await daemonB.sync();
		const bTodos = daemonB.things.getTodos();
		expect(bTodos).toHaveLength(3);

		const titles = bTodos.map((t) => t.title).sort();
		expect(titles).toEqual(["One", "Three", "Two"]);
	});

	it("delete non-existent todo: no crash", async () => {
		// Give A a fake mapping to a serverId that doesn't exist on the server
		const fakeServerId = crypto.randomUUID();
		const fakeThingsId = "local-only-id";
		daemonA.serverIdToThingsId[fakeServerId] = fakeThingsId;
		// The thingsId is not in Things mock, so sync will detect it as deleted
		// and push a deletion for a serverId that doesn't exist on the server

		// Should not throw
		const result = await daemonA.sync();
		expect(result.pushed).toBeGreaterThan(0);

		// Daemon should still be functional after
		daemonA.things.createTodo("TestProject", { title: "After delete" });
		const result2 = await daemonA.sync();
		expect(result2.pushed).toBeGreaterThan(0);

		const aTodos = daemonA.things.getTodos();
		expect(aTodos).toHaveLength(1);
		expect(aTodos[0].title).toBe("After delete");
	});
});
