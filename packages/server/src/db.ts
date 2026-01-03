/**
 * SQLite database setup and queries (v2)
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";

const DATA_DIR =
	process.env.DATA_DIR || path.join(os.homedir(), ".shared-things-server");
const DB_PATH = path.join(DATA_DIR, "data.db");

export type DB = Database.Database;

type DbTodoRow = {
	id: string;
	title: string;
	notes: string;
	due_date: string | null;
	tags: string;
	status: "open" | "completed" | "canceled";
	position: number;
	edited_at: string;
	updated_at: string;
	updated_by: string;
};

export function initDatabase(): DB {
	if (!fs.existsSync(DATA_DIR)) {
		fs.mkdirSync(DATA_DIR, { recursive: true });
	}

	const db = new Database(DB_PATH);
	db.pragma("journal_mode = WAL");
	db.pragma("foreign_keys = ON");

	migrateDatabase(db);

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

function migrateDatabase(db: DB): void {
	db.pragma("foreign_keys = OFF");
	const hasTodos = db
		.prepare(
			`SELECT name FROM sqlite_master WHERE type='table' AND name='todos'`,
		)
		.get();

	if (hasTodos) {
		const columns = db.prepare(`PRAGMA table_info(todos)`).all() as Array<{
			name: string;
		}>;
		const hasThingsId = columns.some((col) => col.name === "things_id");
		const hasEditedAt = columns.some((col) => col.name === "edited_at");

		if (hasThingsId || !hasEditedAt) {
			db.exec(`
        CREATE TABLE IF NOT EXISTS todos_new (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          notes TEXT NOT NULL DEFAULT '',
          due_date TEXT,
          tags TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'canceled')),
          position INTEGER NOT NULL DEFAULT 0,
          edited_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          created_by TEXT NOT NULL,
          updated_by TEXT NOT NULL
        );
      `);

			// Best-effort migration: use updated_at as edited_at and updated_by as created_by.
			db.exec(`
        INSERT INTO todos_new (id, title, notes, due_date, tags, status, position, edited_at, updated_at, created_by, updated_by)
        SELECT id, title, notes, due_date, tags, status, position, updated_at, updated_at, updated_by, updated_by
        FROM todos;
      `);

			db.exec(`
        DROP TABLE todos;
        ALTER TABLE todos_new RENAME TO todos;
      `);
		}
	}

	const hasDeleted = db
		.prepare(
			`SELECT name FROM sqlite_master WHERE type='table' AND name='deleted_items'`,
		)
		.get();
	if (hasDeleted) {
		const columns = db
			.prepare(`PRAGMA table_info(deleted_items)`)
			.all() as Array<{ name: string }>;
		const hasServerId = columns.some((col) => col.name === "server_id");
		const hasRecordedAt = columns.some((col) => col.name === "recorded_at");

		if (!hasServerId) {
			// v1 -> v2 migration: rename things_id to server_id, add recorded_at
			db.exec(`
        CREATE TABLE IF NOT EXISTS deleted_items_new (
          id TEXT PRIMARY KEY,
          server_id TEXT NOT NULL,
          deleted_at TEXT NOT NULL,
          recorded_at TEXT NOT NULL,
          deleted_by TEXT NOT NULL
        );
      `);

			// Use deleted_at as recorded_at for historical records
			db.exec(`
        INSERT INTO deleted_items_new (id, server_id, deleted_at, recorded_at, deleted_by)
        SELECT id, things_id, deleted_at, deleted_at, deleted_by
        FROM deleted_items
        WHERE item_type = 'todo';
      `);

			db.exec(`
        DROP TABLE deleted_items;
        ALTER TABLE deleted_items_new RENAME TO deleted_items;
      `);
		} else if (!hasRecordedAt) {
			// v2 -> v2.1 migration: add recorded_at column
			db.exec(`
        ALTER TABLE deleted_items ADD COLUMN recorded_at TEXT;
        UPDATE deleted_items SET recorded_at = deleted_at WHERE recorded_at IS NULL;
      `);
		}
	}

	const hasHeadings = db
		.prepare(
			`SELECT name FROM sqlite_master WHERE type='table' AND name='headings'`,
		)
		.get();
	if (hasHeadings) {
		db.exec(`DROP TABLE headings;`);
	}
	db.pragma("foreign_keys = ON");
}

// =============================================================================
// User queries
// =============================================================================

export function userExists(db: DB, name: string): boolean {
	const row = db.prepare(`SELECT 1 FROM users WHERE name = ?`).get(name);
	return !!row;
}

export function createUser(
	db: DB,
	name: string,
): { id: string; apiKey: string } {
	if (userExists(db, name)) {
		throw new Error(`User "${name}" already exists`);
	}

	const id = crypto.randomUUID();
	const apiKey = crypto.randomBytes(32).toString("hex");
	const apiKeyHash = crypto.createHash("sha256").update(apiKey).digest("hex");

	db.prepare(`
    INSERT INTO users (id, name, api_key_hash)
    VALUES (?, ?, ?)
  `).run(id, name, apiKeyHash);

	return { id, apiKey };
}

export function getUserByApiKey(
	db: DB,
	apiKey: string,
): { id: string; name: string } | null {
	const apiKeyHash = crypto.createHash("sha256").update(apiKey).digest("hex");

	const row = db
		.prepare(`SELECT id, name FROM users WHERE api_key_hash = ?`)
		.get(apiKeyHash) as { id: string; name: string } | undefined;

	return row || null;
}

export function listUsers(
	db: DB,
): { id: string; name: string; createdAt: string }[] {
	return db
		.prepare(`SELECT id, name, created_at as createdAt FROM users`)
		.all() as { id: string; name: string; createdAt: string }[];
}

// =============================================================================
// Todo queries
// =============================================================================

export function getAllTodos(db: DB) {
	const rows = db
		.prepare(
			`
    SELECT id, title, notes, due_date, tags, status, position,
           edited_at, updated_at, updated_by
    FROM todos
    ORDER BY position
  `,
		)
		.all() as DbTodoRow[];

	return rows.map((row) => ({
		id: row.id,
		title: row.title,
		notes: row.notes,
		dueDate: row.due_date,
		tags: JSON.parse(row.tags),
		status: row.status,
		position: row.position,
		editedAt: row.edited_at,
		updatedAt: row.updated_at,
	}));
}

export function getAllTodosWithMeta(db: DB) {
	const rows = db
		.prepare(
			`
    SELECT id, title, notes, due_date, tags, status, position,
           edited_at, updated_at, updated_by
    FROM todos
    ORDER BY position
  `,
		)
		.all() as DbTodoRow[];

	return rows.map((row) => ({
		id: row.id,
		title: row.title,
		notes: row.notes,
		dueDate: row.due_date,
		tags: JSON.parse(row.tags),
		status: row.status,
		position: row.position,
		editedAt: row.edited_at,
		updatedAt: row.updated_at,
		updatedBy: row.updated_by,
	}));
}

export function getTodosSince(db: DB, since: string) {
	const rows = db
		.prepare(
			`
    SELECT id, title, notes, due_date, tags, status, position,
           edited_at, updated_at, updated_by
    FROM todos
    WHERE updated_at > ?
    ORDER BY position
  `,
		)
		.all(since) as DbTodoRow[];

	return rows.map((row) => ({
		id: row.id,
		title: row.title,
		notes: row.notes,
		dueDate: row.due_date,
		tags: JSON.parse(row.tags),
		status: row.status,
		position: row.position,
		editedAt: row.edited_at,
		updatedAt: row.updated_at,
	}));
}

export function getTodoByServerId(db: DB, serverId: string) {
	const row = db
		.prepare(
			`
    SELECT id, title, notes, due_date, tags, status, position,
           edited_at, updated_at, updated_by
    FROM todos
    WHERE id = ?
  `,
		)
		.get(serverId) as DbTodoRow | undefined;

	if (!row) return null;
	return {
		id: row.id,
		title: row.title,
		notes: row.notes,
		dueDate: row.due_date,
		tags: JSON.parse(row.tags),
		status: row.status,
		position: row.position,
		editedAt: row.edited_at,
		updatedAt: row.updated_at,
		updatedBy: row.updated_by,
	};
}

export function upsertTodo(
	db: DB,
	serverId: string,
	data: {
		title: string;
		notes: string;
		dueDate: string | null;
		tags: string[];
		status: "open" | "completed" | "canceled";
		position: number;
		editedAt: string;
	},
	userId: string,
): void {
	const now = new Date().toISOString();
	const tagsJson = JSON.stringify(data.tags);

	const existing = db
		.prepare(`SELECT id FROM todos WHERE id = ?`)
		.get(serverId) as { id: string } | undefined;

	if (existing) {
		db.prepare(
			`
      UPDATE todos
      SET title = ?, notes = ?, due_date = ?, tags = ?, status = ?,
          position = ?, edited_at = ?, updated_at = ?, updated_by = ?
      WHERE id = ?
    `,
		).run(
			data.title,
			data.notes,
			data.dueDate,
			tagsJson,
			data.status,
			data.position,
			data.editedAt,
			now,
			userId,
			serverId,
		);
		return;
	}

	db.prepare(
		`
    INSERT INTO todos (id, title, notes, due_date, tags, status, position, edited_at, updated_at, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
	).run(
		serverId,
		data.title,
		data.notes,
		data.dueDate,
		tagsJson,
		data.status,
		data.position,
		data.editedAt,
		now,
		userId,
		userId,
	);
}

export function deleteTodoByServerId(db: DB, serverId: string): boolean {
	const existing = db
		.prepare(`SELECT id FROM todos WHERE id = ?`)
		.get(serverId) as { id: string } | undefined;
	if (!existing) return false;

	db.prepare(`DELETE FROM todos WHERE id = ?`).run(serverId);
	return true;
}

export function getDeletedByServerId(
	db: DB,
	serverId: string,
): { deletedAt: string; deletedBy: string } | null {
	const row = db
		.prepare(
			`SELECT deleted_at as deletedAt, deleted_by as deletedBy FROM deleted_items WHERE server_id = ? ORDER BY deleted_at DESC LIMIT 1`,
		)
		.get(serverId) as { deletedAt: string; deletedBy: string } | undefined;
	return row || null;
}

export function recordDeletion(
	db: DB,
	serverId: string,
	deletedAt: string,
	userId: string,
): void {
	// Keep only the latest deletion record per serverId
	db.prepare(`DELETE FROM deleted_items WHERE server_id = ?`).run(serverId);
	const deleteId = crypto.randomUUID();
	const recordedAt = new Date().toISOString();
	db.prepare(
		`
    INSERT INTO deleted_items (id, server_id, deleted_at, recorded_at, deleted_by)
    VALUES (?, ?, ?, ?, ?)
  `,
	).run(deleteId, serverId, deletedAt, recordedAt, userId);
}

export function clearDeletion(db: DB, serverId: string): void {
	db.prepare(`DELETE FROM deleted_items WHERE server_id = ?`).run(serverId);
}

export function getDeletedSince(
	db: DB,
	since: string,
): { serverId: string; deletedAt: string }[] {
	// Filter by recorded_at (server time) not deleted_at (client time)
	// This ensures deletions are propagated even if client clock was behind
	return db
		.prepare(
			`
    SELECT server_id as serverId, deleted_at as deletedAt
    FROM deleted_items
    WHERE recorded_at > ?
  `,
		)
		.all(since) as { serverId: string; deletedAt: string }[];
}

// =============================================================================
// Reset user data
// =============================================================================

export function resetUserData(
	db: DB,
	userId: string,
): { deletedTodos: number } {
	const todoResult = db
		.prepare(`DELETE FROM todos WHERE updated_by = ? OR created_by = ?`)
		.run(userId, userId);

	db.prepare(`DELETE FROM deleted_items WHERE deleted_by = ?`).run(userId);

	return {
		deletedTodos: todoResult.changes,
	};
}
