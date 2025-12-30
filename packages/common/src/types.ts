/**
 * Shared types for shared-things
 */

// =============================================================================
// Core Entities
// =============================================================================

export interface Todo {
	/** Server-assigned unique ID */
	id: string;
	/** Things-assigned ID (from AppleScript) */
	thingsId: string;
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
	/** Parent heading ID (null if directly under project) */
	headingId: string | null;
	/** Position within heading/project for ordering */
	position: number;
	/** Last modified timestamp (ISO 8601) */
	updatedAt: string;
	/** User who last modified */
	updatedBy: string;
	/** Creation timestamp (ISO 8601) */
	createdAt: string;
}

export interface Heading {
	/** Server-assigned unique ID */
	id: string;
	/** Things-assigned ID (from AppleScript) */
	thingsId: string;
	/** Heading title */
	title: string;
	/** Position for ordering */
	position: number;
	/** Last modified timestamp (ISO 8601) */
	updatedAt: string;
	/** User who last modified */
	updatedBy: string;
	/** Creation timestamp (ISO 8601) */
	createdAt: string;
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
	headings: Heading[];
	todos: Todo[];
	/** Server timestamp for this state */
	syncedAt: string;
}

/** Changes since last sync */
export interface SyncDelta {
	/** Headings that were added or modified */
	headings: {
		upserted: Heading[];
		deleted: string[]; // IDs
	};
	/** Todos that were added or modified */
	todos: {
		upserted: Todo[];
		deleted: string[]; // IDs
	};
	/** Server timestamp for this delta */
	syncedAt: string;
}

/** Todo data for push request - includes optional serverId for updates */
export interface PushTodo {
	/** Server ID (include for updates, omit for new items) */
	serverId?: string;
	/** Local Things ID */
	thingsId: string;
	title: string;
	notes: string;
	dueDate: string | null;
	tags: string[];
	status: "open" | "completed" | "canceled";
	headingId: string | null;
	position: number;
}

/** Request to push local changes */
export interface PushRequest {
	headings: {
		upserted: Omit<Heading, "id" | "updatedAt" | "updatedBy" | "createdAt">[];
		deleted: string[]; // server IDs
	};
	todos: {
		upserted: PushTodo[];
		deleted: string[]; // server IDs
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
}

export interface Conflict {
	type: "todo" | "heading";
	thingsId: string;
	/** What the client tried to set */
	clientValue: string;
	/** What the server had (which won) */
	serverValue: string;
	/** Who made the conflicting change */
	conflictingUser: string;
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
