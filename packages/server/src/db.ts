/**
 * SQLite database setup and queries
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as crypto from 'crypto';

const DATA_DIR = process.env.DATA_DIR || path.join(os.homedir(), '.shared-things-server');
const DB_PATH = path.join(DATA_DIR, 'data.db');

export type DB = Database.Database;

export function initDatabase(): DB {
  // Ensure data directory exists
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const db = new Database(DB_PATH);

  // Enable WAL mode for better concurrency
  db.pragma('journal_mode = WAL');

  // Create tables
  db.exec(`
    -- Users table
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      api_key_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Headings table
    CREATE TABLE IF NOT EXISTS headings (
      id TEXT PRIMARY KEY,
      things_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Todos table
    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,
      things_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      due_date TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'canceled')),
      heading_id TEXT REFERENCES headings(id) ON DELETE SET NULL,
      position INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Deleted items tracking (for sync)
    CREATE TABLE IF NOT EXISTS deleted_items (
      id TEXT PRIMARY KEY,
      things_id TEXT NOT NULL,
      item_type TEXT NOT NULL CHECK (item_type IN ('todo', 'heading')),
      deleted_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_by TEXT NOT NULL REFERENCES users(id)
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_todos_updated ON todos(updated_at);
    CREATE INDEX IF NOT EXISTS idx_headings_updated ON headings(updated_at);
    CREATE INDEX IF NOT EXISTS idx_deleted_at ON deleted_items(deleted_at);
  `);

  return db;
}

// =============================================================================
// User queries
// =============================================================================

export function userExists(db: DB, name: string): boolean {
  const row = db.prepare(`SELECT 1 FROM users WHERE name = ?`).get(name);
  return !!row;
}

export function createUser(db: DB, name: string): { id: string; apiKey: string } {
  // Check for duplicate username
  if (userExists(db, name)) {
    throw new Error(`User "${name}" already exists`);
  }

  const id = crypto.randomUUID();
  const apiKey = crypto.randomBytes(32).toString('hex');
  const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');

  db.prepare(`
    INSERT INTO users (id, name, api_key_hash)
    VALUES (?, ?, ?)
  `).run(id, name, apiKeyHash);

  return { id, apiKey };
}

export function getUserByApiKey(db: DB, apiKey: string): { id: string; name: string } | null {
  const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');

  const row = db.prepare(`
    SELECT id, name FROM users WHERE api_key_hash = ?
  `).get(apiKeyHash) as { id: string; name: string } | undefined;

  return row || null;
}

export function listUsers(db: DB): { id: string; name: string; createdAt: string }[] {
  return db.prepare(`
    SELECT id, name, created_at as createdAt FROM users
  `).all() as { id: string; name: string; createdAt: string }[];
}

// =============================================================================
// Heading queries
// =============================================================================

export function getAllHeadings(db: DB) {
  return db.prepare(`
    SELECT
      id, things_id as thingsId, title, position,
      updated_at as updatedAt, updated_by as updatedBy, created_at as createdAt
    FROM headings
    ORDER BY position
  `).all();
}

export function getHeadingsSince(db: DB, since: string) {
  return db.prepare(`
    SELECT
      id, things_id as thingsId, title, position,
      updated_at as updatedAt, updated_by as updatedBy, created_at as createdAt
    FROM headings
    WHERE updated_at > ?
    ORDER BY position
  `).all(since);
}

export function upsertHeading(
  db: DB,
  thingsId: string,
  title: string,
  position: number,
  userId: string
): string {
  const now = new Date().toISOString();
  const existing = db.prepare(`SELECT id FROM headings WHERE things_id = ?`).get(thingsId) as { id: string } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE headings
      SET title = ?, position = ?, updated_at = ?, updated_by = ?
      WHERE things_id = ?
    `).run(title, position, now, userId, thingsId);
    return existing.id;
  } else {
    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO headings (id, things_id, title, position, updated_at, updated_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, thingsId, title, position, now, userId, now);
    return id;
  }
}

export function deleteHeading(db: DB, thingsId: string, userId: string): boolean {
  const existing = db.prepare(`SELECT id FROM headings WHERE things_id = ?`).get(thingsId) as { id: string } | undefined;
  if (!existing) return false;

  const now = new Date().toISOString();
  const deleteId = crypto.randomUUID();

  db.prepare(`
    INSERT INTO deleted_items (id, things_id, item_type, deleted_at, deleted_by)
    VALUES (?, ?, 'heading', ?, ?)
  `).run(deleteId, thingsId, now, userId);

  db.prepare(`DELETE FROM headings WHERE things_id = ?`).run(thingsId);
  return true;
}

// =============================================================================
// Todo queries
// =============================================================================

export function getAllTodos(db: DB) {
  const rows = db.prepare(`
    SELECT
      id, things_id as thingsId, title, notes, due_date as dueDate,
      tags, status, heading_id as headingId, position,
      updated_at as updatedAt, updated_by as updatedBy, created_at as createdAt
    FROM todos
    ORDER BY position
  `).all() as Array<{
    id: string;
    thingsId: string;
    title: string;
    notes: string;
    dueDate: string | null;
    tags: string;
    status: string;
    headingId: string | null;
    position: number;
    updatedAt: string;
    updatedBy: string;
    createdAt: string;
  }>;

  return rows.map(row => ({
    ...row,
    tags: JSON.parse(row.tags),
  }));
}

export function getTodosSince(db: DB, since: string) {
  const rows = db.prepare(`
    SELECT
      id, things_id as thingsId, title, notes, due_date as dueDate,
      tags, status, heading_id as headingId, position,
      updated_at as updatedAt, updated_by as updatedBy, created_at as createdAt
    FROM todos
    WHERE updated_at > ?
    ORDER BY position
  `).all(since) as Array<{
    id: string;
    thingsId: string;
    title: string;
    notes: string;
    dueDate: string | null;
    tags: string;
    status: string;
    headingId: string | null;
    position: number;
    updatedAt: string;
    updatedBy: string;
    createdAt: string;
  }>;

  return rows.map(row => ({
    ...row,
    tags: JSON.parse(row.tags),
  }));
}

export function upsertTodo(
  db: DB,
  thingsId: string,
  data: {
    title: string;
    notes: string;
    dueDate: string | null;
    tags: string[];
    status: 'open' | 'completed' | 'canceled';
    headingId: string | null;
    position: number;
  },
  userId: string
): string {
  const now = new Date().toISOString();
  const tagsJson = JSON.stringify(data.tags);
  const existing = db.prepare(`SELECT id FROM todos WHERE things_id = ?`).get(thingsId) as { id: string } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE todos
      SET title = ?, notes = ?, due_date = ?, tags = ?, status = ?,
          heading_id = ?, position = ?, updated_at = ?, updated_by = ?
      WHERE things_id = ?
    `).run(data.title, data.notes, data.dueDate, tagsJson, data.status,
      data.headingId, data.position, now, userId, thingsId);
    return existing.id;
  } else {
    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO todos (id, things_id, title, notes, due_date, tags, status, heading_id, position, updated_at, updated_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, thingsId, data.title, data.notes, data.dueDate, tagsJson, data.status,
      data.headingId, data.position, now, userId, now);
    return id;
  }
}

/**
 * Upsert todo using server ID (preferred for cross-device sync)
 * - If serverId provided: update existing record by serverId
 * - If no serverId: create new record
 */
export function upsertTodoByServerId(
  db: DB,
  serverId: string | undefined,
  data: {
    thingsId: string;
    title: string;
    notes: string;
    dueDate: string | null;
    tags: string[];
    status: 'open' | 'completed' | 'canceled';
    headingId: string | null;
    position: number;
  },
  userId: string
): string {
  const now = new Date().toISOString();
  const tagsJson = JSON.stringify(data.tags);

  if (serverId) {
    // Update existing by server ID
    const existing = db.prepare(`SELECT id FROM todos WHERE id = ?`).get(serverId) as { id: string } | undefined;

    if (existing) {
      db.prepare(`
        UPDATE todos
        SET title = ?, notes = ?, due_date = ?, tags = ?, status = ?,
            heading_id = ?, position = ?, updated_at = ?, updated_by = ?
        WHERE id = ?
      `).run(data.title, data.notes, data.dueDate, tagsJson, data.status,
        data.headingId, data.position, now, userId, serverId);
      return serverId;
    }
    // If serverId provided but not found, fall through to create
  }

  // Check if todo with this thingsId already exists
  const existingByThingsId = db.prepare(`SELECT id FROM todos WHERE things_id = ?`).get(data.thingsId) as { id: string } | undefined;

  if (existingByThingsId) {
    // Update existing todo found by thingsId
    db.prepare(`
      UPDATE todos
      SET title = ?, notes = ?, due_date = ?, tags = ?, status = ?,
          heading_id = ?, position = ?, updated_at = ?, updated_by = ?
      WHERE things_id = ?
    `).run(data.title, data.notes, data.dueDate, tagsJson, data.status,
      data.headingId, data.position, now, userId, data.thingsId);
    return existingByThingsId.id;
  }

  // Create new record
  const id = serverId || crypto.randomUUID();
  db.prepare(`
    INSERT INTO todos (id, things_id, title, notes, due_date, tags, status, heading_id, position, updated_at, updated_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, data.thingsId, data.title, data.notes, data.dueDate, tagsJson, data.status,
    data.headingId, data.position, now, userId, now);
  return id;
}

export function deleteTodo(db: DB, thingsId: string, userId: string): boolean {
  const existing = db.prepare(`SELECT id, things_id FROM todos WHERE things_id = ?`).get(thingsId) as { id: string; things_id: string } | undefined;
  if (!existing) return false;

  const now = new Date().toISOString();
  const deleteId = crypto.randomUUID();

  db.prepare(`
    INSERT INTO deleted_items (id, things_id, item_type, deleted_at, deleted_by)
    VALUES (?, ?, 'todo', ?, ?)
  `).run(deleteId, thingsId, now, userId);

  db.prepare(`DELETE FROM todos WHERE things_id = ?`).run(thingsId);
  return true;
}

export function deleteTodoByServerId(db: DB, serverId: string, userId: string): boolean {
  const existing = db.prepare(`SELECT id, things_id FROM todos WHERE id = ?`).get(serverId) as { id: string; things_id: string } | undefined;
  if (!existing) return false;

  const now = new Date().toISOString();
  const deleteId = crypto.randomUUID();

  // Track deletion using server ID (for sync purposes)
  db.prepare(`
    INSERT INTO deleted_items (id, things_id, item_type, deleted_at, deleted_by)
    VALUES (?, ?, 'todo', ?, ?)
  `).run(deleteId, serverId, now, userId);

  db.prepare(`DELETE FROM todos WHERE id = ?`).run(serverId);
  return true;
}

export function getDeletedSince(db: DB, since: string): { todos: string[]; headings: string[] } {
  const rows = db.prepare(`
    SELECT things_id, item_type FROM deleted_items WHERE deleted_at > ?
  `).all(since) as { things_id: string; item_type: 'todo' | 'heading' }[];

  return {
    todos: rows.filter(r => r.item_type === 'todo').map(r => r.things_id),
    headings: rows.filter(r => r.item_type === 'heading').map(r => r.things_id),
  };
}

// =============================================================================
// Reset user data
// =============================================================================

/**
 * Delete all data created/updated by a user
 * Used for clean reset when client wants to start fresh
 */
export function resetUserData(db: DB, userId: string): { deletedTodos: number; deletedHeadings: number } {
  // Delete all todos updated by this user
  const todoResult = db.prepare(`DELETE FROM todos WHERE updated_by = ?`).run(userId);

  // Delete all headings updated by this user
  const headingResult = db.prepare(`DELETE FROM headings WHERE updated_by = ?`).run(userId);

  // Clear deleted_items tracking for this user
  db.prepare(`DELETE FROM deleted_items WHERE deleted_by = ?`).run(userId);

  return {
    deletedTodos: todoResult.changes,
    deletedHeadings: headingResult.changes,
  };
}
