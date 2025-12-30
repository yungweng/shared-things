/**
 * Validation utilities
 */

import type { Heading, PushRequest, Todo } from "./types.js";

export function isValidTodo(obj: unknown): obj is Partial<Todo> {
	if (typeof obj !== "object" || obj === null) return false;
	const todo = obj as Record<string, unknown>;

	if (todo.title !== undefined && typeof todo.title !== "string") return false;
	if (todo.notes !== undefined && typeof todo.notes !== "string") return false;
	if (
		todo.status !== undefined &&
		!["open", "completed", "canceled"].includes(todo.status as string)
	)
		return false;
	if (todo.tags !== undefined && !Array.isArray(todo.tags)) return false;

	return true;
}

export function isValidHeading(obj: unknown): obj is Partial<Heading> {
	if (typeof obj !== "object" || obj === null) return false;
	const heading = obj as Record<string, unknown>;

	if (heading.title !== undefined && typeof heading.title !== "string")
		return false;
	if (heading.position !== undefined && typeof heading.position !== "number")
		return false;

	return true;
}

export function isValidPushRequest(obj: unknown): obj is PushRequest {
	if (typeof obj !== "object" || obj === null) return false;
	const req = obj as Record<string, unknown>;

	if (typeof req.lastSyncedAt !== "string") return false;
	if (typeof req.headings !== "object" || req.headings === null) return false;
	if (typeof req.todos !== "object" || req.todos === null) return false;

	return true;
}

/** Sanitize string input */
export function sanitizeString(input: string, maxLength = 10000): string {
	return input.slice(0, maxLength).trim();
}

/** Validate ISO 8601 date string */
export function isValidISODate(dateString: string): boolean {
	const date = new Date(dateString);
	return !Number.isNaN(date.getTime());
}
