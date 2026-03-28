/**
 * API routes (v3 — with WebSocket notification on push)
 */

import * as crypto from "node:crypto";
import type {
	Conflict,
	ProjectState,
	PushRequest,
	PushResponse,
	SyncDelta,
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
import type { ConnectionManager } from "./websocket.js";

export function registerRoutes(
	app: FastifyInstance,
	db: DB,
	wsManager: ConnectionManager,
) {
	app.get("/health", async () => {
		return { status: "ok", timestamp: new Date().toISOString() };
	});

	app.get("/state", async (): Promise<ProjectState> => {
		return {
			todos: getAllTodos(db) as Todo[],
			syncedAt: new Date().toISOString(),
		};
	});

	app.get<{ Querystring: { since: string } }>("/delta", async (request) => {
		const { since } = request.query;
		if (!since) {
			return { error: 'Missing "since" query parameter', code: "BAD_REQUEST" };
		}

		return {
			todos: {
				upserted: getTodosSince(db, since),
				deleted: getDeletedSince(db, since),
			},
			syncedAt: new Date().toISOString(),
		};
	});

	app.post<{ Body: PushRequest }>(
		"/push",
		async (request, reply): Promise<PushResponse> => {
			const { todos } = request.body;
			const userId = request.user.id;
			const conflicts: Conflict[] = [];
			const mappings: PushResponse["mappings"] = [];

			// Track what changed for WebSocket notification
			const changedServerIds: string[] = [];
			const deletedItems: { serverId: string; deletedAt: string }[] = [];

			try {
				const transaction = db.transaction(() => {
					// Process deletions
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
								deletedItems.push(deletion);
							}
							continue;
						}

						if (
							!shouldApplyChange(
								deletion.deletedAt,
								existing.editedAt,
								userId,
								existing.updatedBy,
							)
						) {
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
						deletedItems.push(deletion);
					}

					// Process upserts
					for (const todo of todos.upserted) {
						const serverId = todo.serverId || crypto.randomUUID();
						const position =
							typeof todo.position === "number" &&
							Number.isFinite(todo.position)
								? todo.position
								: 0;

						const existingDeletion = getDeletedByServerId(db, serverId);
						if (existingDeletion) {
							if (
								!shouldApplyChange(
									todo.editedAt,
									existingDeletion.deletedAt,
									userId,
									existingDeletion.deletedBy,
								)
							) {
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
							if (
								!shouldApplyChange(
									todo.editedAt,
									existing.editedAt,
									userId,
									existing.updatedBy,
								)
							) {
								conflicts.push({
									serverId,
									reason: "Remote edit was newer",
									serverTodo: toTodo(existing),
									clientTodo: todo,
								});
								continue;
							}
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
								projectName: todo.projectName,
								editedAt: todo.editedAt,
							},
							userId,
						);

						changedServerIds.push(serverId);

						if (!todo.serverId && todo.clientId) {
							mappings?.push({ serverId, clientId: todo.clientId });
						}
					}
				});

				transaction();
			} catch (err) {
				const error = err as Error;
				if (error.message?.includes("UNIQUE constraint failed")) {
					reply.status(409);
					return {
						error:
							'Sync conflict: Run "shared-things reset --server" to start fresh.',
						code: "SYNC_CONFLICT",
					} as any;
				}
				throw err;
			}

			const currentTodos = getAllTodos(db);
			const syncedAt = new Date().toISOString();

			// Notify other connected clients via WebSocket
			if (changedServerIds.length > 0 || deletedItems.length > 0) {
				const upserted = currentTodos.filter((t) =>
					changedServerIds.includes(t.id),
				) as Todo[];

				const delta: SyncDelta = {
					todos: { upserted, deleted: deletedItems },
					syncedAt,
				};
				wsManager.notifyOthers(userId, delta);
			}

			return {
				state: { todos: currentTodos as Todo[], syncedAt },
				conflicts,
				mappings: mappings?.length ? mappings : undefined,
			};
		},
	);

	app.delete("/reset", async (request) => {
		const result = resetUserData(db, request.user.id);
		return { success: true, deleted: { todos: result.deletedTodos } };
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
	projectName: string | null;
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
		projectName: todo.projectName,
		editedAt: todo.editedAt,
		updatedAt: todo.updatedAt,
	};
}
