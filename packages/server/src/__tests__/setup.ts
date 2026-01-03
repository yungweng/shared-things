/**
 * Test setup utilities
 *
 * Provides helpers to spin up an isolated test server with file-backed SQLite
 * in a temp directory. Each test file gets its own isolated database.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import cors from "@fastify/cors";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import { authMiddleware } from "../auth.js";
import { createUser, type DB } from "../db.js";
import { registerRoutes } from "../routes.js";

export interface TestContext {
	app: FastifyInstance;
	db: DB;
	baseUrl: string;
	userA: { id: string; apiKey: string; name: string };
	userB: { id: string; apiKey: string; name: string };
	cleanup: () => Promise<void>;
}

/**
 * Initialize a fresh test database (bypasses migration logic)
 */
function initTestDatabase(dbPath: string): DB {
	const db = new Database(dbPath);
	db.pragma("journal_mode = WAL");
	db.pragma("foreign_keys = ON");

	// Create tables directly (no migration needed for fresh test DB)
	db.exec(`
		CREATE TABLE IF NOT EXISTS users (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			api_key_hash TEXT NOT NULL UNIQUE,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE TABLE IF NOT EXISTS todos (
			id TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			notes TEXT NOT NULL DEFAULT '',
			due_date TEXT,
			tags TEXT NOT NULL DEFAULT '[]',
			status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'canceled')),
			position INTEGER NOT NULL DEFAULT 0,
			edited_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			created_by TEXT NOT NULL REFERENCES users(id),
			updated_by TEXT NOT NULL REFERENCES users(id)
		);

		CREATE TABLE IF NOT EXISTS deleted_items (
			id TEXT PRIMARY KEY,
			server_id TEXT NOT NULL,
			deleted_at TEXT NOT NULL,
			recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
			deleted_by TEXT NOT NULL REFERENCES users(id)
		);

		CREATE INDEX IF NOT EXISTS idx_todos_updated ON todos(updated_at);
		CREATE INDEX IF NOT EXISTS idx_deleted_recorded ON deleted_items(recorded_at);
	`);

	return db;
}

/**
 * Creates an isolated test server with its own database
 */
export async function createTestServer(): Promise<TestContext> {
	// Create temp directory for this test's database
	const testDir = path.join(
		os.tmpdir(),
		`shared-things-test-${crypto.randomUUID()}`,
	);
	fs.mkdirSync(testDir, { recursive: true });

	const dbPath = path.join(testDir, "test.db");

	// Initialize fresh test database (no migration)
	const db = initTestDatabase(dbPath);

	// Create test users
	const userAResult = createUser(db, "TestUserA");
	const userBResult = createUser(db, "TestUserB");

	// Create Fastify instance (no logging in tests)
	const app = Fastify({ logger: false });

	// Register CORS
	await app.register(cors, { origin: true });

	// Add auth middleware
	app.addHook("preHandler", authMiddleware(db));

	// Register routes
	registerRoutes(app, db);

	// Start on random available port
	await app.listen({ port: 0, host: "127.0.0.1" });

	const address = app.server.address();
	const port = typeof address === "object" && address ? address.port : 3000;
	const baseUrl = `http://127.0.0.1:${port}`;

	return {
		app,
		db,
		baseUrl,
		userA: { ...userAResult, name: "TestUserA" },
		userB: { ...userBResult, name: "TestUserB" },
		cleanup: async () => {
			await app.close();
			db.close();
			// Clean up temp directory
			fs.rmSync(testDir, { recursive: true, force: true });
		},
	};
}

/**
 * Helper to make authenticated API requests
 */
export async function apiRequest(
	ctx: TestContext,
	method: "GET" | "POST" | "DELETE",
	path: string,
	options: {
		apiKey?: string;
		body?: unknown;
	} = {},
): Promise<{ status: number; data: unknown }> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};

	if (options.apiKey) {
		headers.Authorization = `Bearer ${options.apiKey}`;
	}

	const response = await fetch(`${ctx.baseUrl}${path}`, {
		method,
		headers,
		body: options.body ? JSON.stringify(options.body) : undefined,
	});

	const data = await response.json();
	return { status: response.status, data };
}

/**
 * Creates a todo via the API and returns its server ID
 */
export async function createTodoViaApi(
	ctx: TestContext,
	apiKey: string,
	todo: {
		title: string;
		notes?: string;
		editedAt?: string;
	},
): Promise<string> {
	const clientId = crypto.randomUUID();
	const editedAt = todo.editedAt || new Date().toISOString();

	const response = await apiRequest(ctx, "POST", "/push", {
		apiKey,
		body: {
			todos: {
				upserted: [
					{
						clientId,
						title: todo.title,
						notes: todo.notes || "",
						dueDate: null,
						tags: [],
						status: "open",
						position: 0,
						editedAt,
					},
				],
				deleted: [],
			},
			lastSyncedAt: "1970-01-01T00:00:00.000Z",
		},
	});

	const data = response.data as {
		mappings?: Array<{ clientId: string; serverId: string }>;
	};

	const mapping = data.mappings?.find((m) => m.clientId === clientId);
	if (!mapping) {
		throw new Error("Failed to create todo - no mapping returned");
	}

	return mapping.serverId;
}

/**
 * ISO timestamp helper - creates timestamps with predictable ordering
 */
export function timestamp(
	offsetMs = 0,
	base = "2026-01-03T12:00:00.000Z",
): string {
	const baseTime = new Date(base).getTime();
	return new Date(baseTime + offsetMs).toISOString();
}
