/**
 * API routes
 */

import * as crypto from "node:crypto";
import type {
	Conflict,
	ProjectState,
	PushRequest,
	PushResponse,
	Todo,
} from "@shared-things/common";
import type { FastifyInstance } from "fastify";
import {
	clearDeletion,
	type DB,
	deleteTodoByServerId,
	getAllTodos,
	getDeletedByServerId,
	getDeletedSince,
	getTodoByServerId,
	getTodosSince,
	recordDeletion,
	resetUserData,
	upsertTodo,
} from "./db.js";

export function registerRoutes(app: FastifyInstance, db: DB) {
	// Health check (no auth)
	app.get("/health", async () => {
		return { status: "ok", timestamp: new Date().toISOString() };
	});

	// Get full project state
	app.get("/state", async (_request): Promise<ProjectState> => {
		const todos = getAllTodos(db);

		return {
			todos: todos as ProjectState["todos"],
			syncedAt: new Date().toISOString(),
		};
	});

	// Get changes since timestamp
	app.get<{ Querystring: { since: string } }>("/delta", async (request) => {
		const { since } = request.query;

		if (!since) {
			return { error: 'Missing "since" query parameter', code: "BAD_REQUEST" };
		}

		const todos = getTodosSince(db, since);
		const deleted = getDeletedSince(db, since);

		return {
			todos: {
				upserted: todos,
				deleted,
			},
			syncedAt: new Date().toISOString(),
		};
	});

	// Push changes
	app.post<{ Body: PushRequest }>(
		"/push",
		async (request, reply): Promise<PushResponse> => {
			const { todos } = request.body;
			const userId = request.user.id;
			const conflicts: Conflict[] = [];
			const mappings: PushResponse["mappings"] = [];

			try {
				const transaction = db.transaction(() => {
					// Process todo deletions (by server ID)
					for (const deletion of todos.deleted) {
						const existing = getTodoByServerId(db, deletion.serverId);
						if (!existing) {
							const existingDeletion = getDeletedByServerId(
								db,
								deletion.serverId,
							);
							if (
								!existingDeletion ||
								compareIso(deletion.deletedAt, existingDeletion.deletedAt) > 0
							) {
								recordDeletion(
									db,
									deletion.serverId,
									deletion.deletedAt,
									userId,
								);
							}
							continue;
						}

						const shouldDelete = shouldApplyChange(
							deletion.deletedAt,
							existing.editedAt,
							userId,
							existing.updatedBy,
						);

						if (!shouldDelete) {
							conflicts.push({
								serverId: deletion.serverId,
								reason: "Remote edit was newer",
								serverTodo: toTodo(existing),
								clientDeletedAt: deletion.deletedAt,
							});
							continue;
						}

						deleteTodoByServerId(db, deletion.serverId);
						recordDeletion(db, deletion.serverId, deletion.deletedAt, userId);
					}

					// Process todo upserts
					for (const todo of todos.upserted) {
						const serverId = todo.serverId || crypto.randomUUID();
						const position =
							typeof todo.position === "number" &&
							Number.isFinite(todo.position)
								? todo.position
								: 0;

						const existingDeletion = getDeletedByServerId(db, serverId);
						if (existingDeletion) {
							const editWins =
								compareIso(todo.editedAt, existingDeletion.deletedAt) > 0;
							if (!editWins) {
								conflicts.push({
									serverId,
									reason: "Remote delete was newer",
									serverTodo: null,
									clientTodo: todo,
								});
								continue;
							}
							clearDeletion(db, serverId);
						}

						const existing = getTodoByServerId(db, serverId);
						if (existing) {
							const shouldApply = shouldApplyChange(
								todo.editedAt,
								existing.editedAt,
								userId,
								existing.updatedBy,
							);
							if (!shouldApply) {
								conflicts.push({
									serverId,
									reason: "Remote edit was newer",
									serverTodo: toTodo(existing),
									clientTodo: todo,
								});
								continue;
							}
						} else if (todo.serverId) {
							// If serverId provided but doesn't exist, keep it for idempotency
						}

						upsertTodo(
							db,
							serverId,
							{
								title: todo.title,
								notes: todo.notes,
								dueDate: todo.dueDate,
								tags: todo.tags,
								status: todo.status,
								position,
								editedAt: todo.editedAt,
							},
							userId,
						);

						if (!todo.serverId && todo.clientId) {
							mappings?.push({ serverId, clientId: todo.clientId });
						}
					}
				});

				transaction();
			} catch (err) {
				const error = err as Error;
				// Check for UNIQUE constraint violation
				if (error.message?.includes("UNIQUE constraint failed")) {
					reply.status(409);
					return {
						error:
							'Sync conflict: Server has data that conflicts with your local state. Run "shared-things reset --server" to start fresh.',
						code: "SYNC_CONFLICT",
					} as any;
				}
				throw err;
			}

			// Return current state
			const currentTodos = getAllTodos(db);

			return {
				state: {
					todos: currentTodos as ProjectState["todos"],
					syncedAt: new Date().toISOString(),
				},
				conflicts,
				mappings: mappings?.length ? mappings : undefined,
			};
		},
	);

	// Reset user data (for clean fresh start)
	app.delete("/reset", async (request) => {
		const userId = request.user.id;
		const result = resetUserData(db, userId);

		return {
			success: true,
			deleted: {
				todos: result.deletedTodos,
			},
		};
	});
}

function compareIso(a: string, b: string): number {
	return new Date(a).getTime() - new Date(b).getTime();
}

function shouldApplyChange(
	incomingEditedAt: string,
	storedEditedAt: string,
	incomingUserId: string,
	storedUserId: string,
): boolean {
	const diff = compareIso(incomingEditedAt, storedEditedAt);
	if (diff > 0) return true;
	if (diff < 0) return false;
	return incomingUserId > storedUserId;
}

function toTodo(todo: {
	id: string;
	title: string;
	notes: string;
	dueDate: string | null;
	tags: string[];
	status: "open" | "completed" | "canceled";
	position: number;
	editedAt: string;
	updatedAt: string;
}): Todo {
	return {
		id: todo.id,
		title: todo.title,
		notes: todo.notes,
		dueDate: todo.dueDate,
		tags: todo.tags,
		status: todo.status,
		position: todo.position,
		editedAt: todo.editedAt,
		updatedAt: todo.updatedAt,
	};
}
