/**
 * Shared types for shared-things
 */

// =============================================================================
// Core Entities
// =============================================================================

export interface Todo {
	/** Server-assigned unique ID */
	id: string;
	/** Todo title */
	title: string;
	/** Notes/description */
	notes: string;
	/** Due date (ISO 8601) */
	dueDate: string | null;
	/** Tags (comma-separated in Things) */
	tags: string[];
	/** Status */
	status: "open" | "completed" | "canceled";
	/** Position within project for ordering */
	position: number;
	/** Client edit timestamp (ISO 8601) */
	editedAt: string;
	/** Server update timestamp (ISO 8601) */
	updatedAt: string;
}

export interface User {
	/** Unique user ID */
	id: string;
	/** Display name */
	name: string;
	/** API key (hashed in DB) */
	apiKey?: string;
	/** Creation timestamp */
	createdAt: string;
}

// =============================================================================
// API Types
// =============================================================================

/** Full project state for initial sync */
export interface ProjectState {
	todos: Todo[];
	/** Server timestamp for this state */
	syncedAt: string;
}

/** Changes since last sync */
export interface SyncDelta {
	/** Todos that were added or modified */
	todos: {
		upserted: Todo[];
		deleted: { serverId: string; deletedAt: string }[];
	};
	/** Server timestamp for this delta */
	syncedAt: string;
}

/** Todo data for push request - includes optional serverId for updates */
export interface PushTodo {
	/** Server ID (include for updates, omit for new items) */
	serverId?: string;
	/** Client-local ID for mapping (not stored on server) */
	clientId?: string;
	title: string;
	notes: string;
	dueDate: string | null;
	tags: string[];
	status: "open" | "completed" | "canceled";
	position: number;
	/** Client edit timestamp */
	editedAt: string;
}

/** Request to push local changes */
export interface PushRequest {
	todos: {
		upserted: PushTodo[];
		deleted: { serverId: string; deletedAt: string }[];
	};
	/** Client's last known sync timestamp */
	lastSyncedAt: string;
}

/** Response from push */
export interface PushResponse {
	/** Server's current state after applying changes */
	state: ProjectState;
	/** Conflicts that occurred (for logging/debugging) */
	conflicts: Conflict[];
	/** Server ID mappings for newly created todos */
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
	/** Server URL (e.g., https://things.example.com) */
	serverUrl: string;
	/** User's API key */
	apiKey: string;
	/** Things project name to sync */
	projectName: string;
	/** Polling interval in seconds */
	pollInterval: number;
	/** Things URL Scheme auth token (from Things → Settings → General → Things URLs) */
	thingsAuthToken: string;
}

// =============================================================================
// API Error
// =============================================================================

export interface ApiError {
	error: string;
	code: string;
	details?: unknown;
}
