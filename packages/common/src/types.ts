/**
 * Shared types for shared-things v3
 */

// =============================================================================
// Core Entities
// =============================================================================

export interface Todo {
	/** Server-assigned unique ID */
	id: string;
	title: string;
	notes: string;
	dueDate: string | null;
	tags: string[];
	status: "open" | "completed" | "canceled";
	/** Position within project for ordering */
	position: number;
	/** Project name within area (null = loose todo in area root) */
	projectName: string | null;
	/** Client edit timestamp (ISO 8601) */
	editedAt: string;
	/** Server update timestamp (ISO 8601) */
	updatedAt: string;
}

export interface User {
	id: string;
	name: string;
	apiKey?: string;
	createdAt: string;
}

// =============================================================================
// API Types
// =============================================================================

/** Full project state for initial sync */
export interface ProjectState {
	todos: Todo[];
	syncedAt: string;
}

/** Changes since last sync */
export interface SyncDelta {
	todos: {
		upserted: Todo[];
		deleted: { serverId: string; deletedAt: string }[];
	};
	syncedAt: string;
}

/** Todo data sent from client to server */
export interface PushTodo {
	/** Server ID (include for updates, omit for new items) */
	serverId?: string;
	/** Client-local ID for mapping back (not stored on server) */
	clientId?: string;
	title: string;
	notes: string;
	dueDate: string | null;
	tags: string[];
	status: "open" | "completed" | "canceled";
	position: number;
	/** Project name within area (null = loose todo in area root) */
	projectName: string | null;
	editedAt: string;
}

/** Request to push local changes */
export interface PushRequest {
	todos: {
		upserted: PushTodo[];
		deleted: { serverId: string; deletedAt: string }[];
	};
	lastSyncedAt: string;
}

/** Response from push */
export interface PushResponse {
	state: ProjectState;
	conflicts: Conflict[];
	mappings?: { serverId: string; clientId: string }[];
}

export interface Conflict {
	serverId: string;
	reason: string;
	serverTodo: Todo | null;
	clientTodo?: PushTodo;
	clientDeletedAt?: string;
}

// =============================================================================
// Daemon Config
// =============================================================================

export interface DaemonConfig {
	serverUrl: string;
	apiKey: string;
	/** Sync mode: single project or entire area */
	syncMode: "project" | "area";
	/** Project name (used when syncMode = "project") */
	projectName?: string;
	/** Area name (used when syncMode = "area") */
	areaName?: string;
	thingsAuthToken: string;
	/** Fallback poll interval if file watcher fails (seconds, default: 60) */
	fallbackPollIntervalSeconds: number;
}

// =============================================================================
// API Error
// =============================================================================

export interface ApiError {
	error: string;
	code: string;
	details?: unknown;
}
