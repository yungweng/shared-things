/**
 * WebSocket protocol definitions for shared-things v3
 */

import type { SyncDelta } from "./types.js";

// =============================================================================
// Server → Client Messages
// =============================================================================

export type ServerMessage =
	| { type: "delta"; payload: SyncDelta }
	| { type: "ack"; payload: { requestId: string } }
	| { type: "error"; payload: { message: string; code: string } }
	| { type: "ping" };

// =============================================================================
// Client → Server Messages
// =============================================================================

export type ClientMessage =
	| { type: "auth"; payload: { apiKey: string } }
	| { type: "pong" };

// =============================================================================
// Helpers
// =============================================================================

export function serializeMessage(msg: ServerMessage | ClientMessage): string {
	return JSON.stringify(msg);
}

export function parseServerMessage(data: string): ServerMessage | null {
	try {
		const msg = JSON.parse(data);
		if (
			typeof msg === "object" &&
			msg !== null &&
			typeof msg.type === "string"
		) {
			return msg as ServerMessage;
		}
		return null;
	} catch {
		return null;
	}
}

export function parseClientMessage(data: string): ClientMessage | null {
	try {
		const msg = JSON.parse(data);
		if (
			typeof msg === "object" &&
			msg !== null &&
			typeof msg.type === "string"
		) {
			return msg as ClientMessage;
		}
		return null;
	} catch {
		return null;
	}
}
