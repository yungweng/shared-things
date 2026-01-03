/**
 * Push endpoint tests
 */

import * as crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	apiRequest,
	createTestServer,
	createTodoViaApi,
	type TestContext,
	timestamp,
} from "./setup.js";

describe("POST /push", () => {
	let ctx: TestContext;

	beforeAll(async () => {
		ctx = await createTestServer();
	});

	afterAll(async () => {
		await ctx.cleanup();
	});

	describe("creating todos", () => {
		it("should create new todo and return server ID mapping", async () => {
			const clientId = crypto.randomUUID();
			const editedAt = timestamp();

			const { status, data } = await apiRequest(ctx, "POST", "/push", {
				apiKey: ctx.userA.apiKey,
				body: {
					todos: {
						upserted: [
							{
								clientId,
								title: "Test Todo",
								notes: "Test notes",
								dueDate: null,
								tags: ["test"],
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

			expect(status).toBe(200);

			const response = data as {
				mappings: Array<{ clientId: string; serverId: string }>;
				conflicts: unknown[];
			};

			expect(response.mappings).toHaveLength(1);
			expect(response.mappings[0].clientId).toBe(clientId);
			expect(response.mappings[0].serverId).toBeDefined();
			expect(response.conflicts).toHaveLength(0);

			// Verify todo exists in state
			const stateResponse = await apiRequest(ctx, "GET", "/state", {
				apiKey: ctx.userA.apiKey,
			});
			const state = stateResponse.data as {
				todos: Array<{ id: string; title: string }>;
			};
			const created = state.todos.find(
				(t) => t.id === response.mappings[0].serverId,
			);
			expect(created).toBeDefined();
			expect(created?.title).toBe("Test Todo");
		});

		it("should create multiple todos in one push", async () => {
			const clientIds = [crypto.randomUUID(), crypto.randomUUID()];

			const { status, data } = await apiRequest(ctx, "POST", "/push", {
				apiKey: ctx.userA.apiKey,
				body: {
					todos: {
						upserted: clientIds.map((clientId, i) => ({
							clientId,
							title: `Batch Todo ${i + 1}`,
							notes: "",
							dueDate: null,
							tags: [],
							status: "open",
							position: i,
							editedAt: timestamp(i * 1000),
						})),
						deleted: [],
					},
					lastSyncedAt: "1970-01-01T00:00:00.000Z",
				},
			});

			expect(status).toBe(200);
			const response = data as {
				mappings: Array<{ clientId: string; serverId: string }>;
			};
			expect(response.mappings).toHaveLength(2);
		});
	});

	describe("updating todos", () => {
		it("should update existing todo when editedAt is newer", async () => {
			// Create initial todo
			const serverId = await createTodoViaApi(ctx, ctx.userA.apiKey, {
				title: "Original Title",
				editedAt: timestamp(0),
			});

			// Update with newer timestamp
			const { status, data } = await apiRequest(ctx, "POST", "/push", {
				apiKey: ctx.userA.apiKey,
				body: {
					todos: {
						upserted: [
							{
								serverId,
								clientId: serverId,
								title: "Updated Title",
								notes: "Updated notes",
								dueDate: null,
								tags: [],
								status: "open",
								position: 0,
								editedAt: timestamp(60000), // 1 minute later
							},
						],
						deleted: [],
					},
					lastSyncedAt: timestamp(0),
				},
			});

			expect(status).toBe(200);
			const response = data as { conflicts: unknown[] };
			expect(response.conflicts).toHaveLength(0);

			// Verify update
			const stateResponse = await apiRequest(ctx, "GET", "/state", {
				apiKey: ctx.userA.apiKey,
			});
			const state = stateResponse.data as {
				todos: Array<{ id: string; title: string }>;
			};
			const updated = state.todos.find((t) => t.id === serverId);
			expect(updated?.title).toBe("Updated Title");
		});

		it("should reject update when editedAt is older (return conflict)", async () => {
			// Create initial todo with newer timestamp
			const serverId = await createTodoViaApi(ctx, ctx.userA.apiKey, {
				title: "Server Version",
				editedAt: timestamp(60000), // 1 minute after base
			});

			// Try to update with older timestamp
			const { status, data } = await apiRequest(ctx, "POST", "/push", {
				apiKey: ctx.userA.apiKey,
				body: {
					todos: {
						upserted: [
							{
								serverId,
								clientId: serverId,
								title: "Old Client Version",
								notes: "",
								dueDate: null,
								tags: [],
								status: "open",
								position: 0,
								editedAt: timestamp(0), // Earlier than server
							},
						],
						deleted: [],
					},
					lastSyncedAt: "1970-01-01T00:00:00.000Z",
				},
			});

			expect(status).toBe(200);
			const response = data as {
				conflicts: Array<{
					serverId: string;
					reason: string;
					serverTodo: { title: string };
				}>;
			};
			expect(response.conflicts).toHaveLength(1);
			expect(response.conflicts[0].serverId).toBe(serverId);
			expect(response.conflicts[0].reason).toBe("Remote edit was newer");

			// Verify server version unchanged
			const stateResponse = await apiRequest(ctx, "GET", "/state", {
				apiKey: ctx.userA.apiKey,
			});
			const state = stateResponse.data as {
				todos: Array<{ id: string; title: string }>;
			};
			const todo = state.todos.find((t) => t.id === serverId);
			expect(todo?.title).toBe("Server Version");
		});
	});

	describe("deleting todos", () => {
		it("should process deletion when deletedAt is newer than editedAt", async () => {
			// Create todo
			const serverId = await createTodoViaApi(ctx, ctx.userA.apiKey, {
				title: "To Be Deleted",
				editedAt: timestamp(0),
			});

			// Delete with newer timestamp
			const { status, data } = await apiRequest(ctx, "POST", "/push", {
				apiKey: ctx.userA.apiKey,
				body: {
					todos: {
						upserted: [],
						deleted: [
							{
								serverId,
								deletedAt: timestamp(60000), // 1 minute later
							},
						],
					},
					lastSyncedAt: timestamp(0),
				},
			});

			expect(status).toBe(200);
			const response = data as { conflicts: unknown[] };
			expect(response.conflicts).toHaveLength(0);

			// Verify deletion
			const stateResponse = await apiRequest(ctx, "GET", "/state", {
				apiKey: ctx.userA.apiKey,
			});
			const state = stateResponse.data as {
				todos: Array<{ id: string }>;
			};
			const deleted = state.todos.find((t) => t.id === serverId);
			expect(deleted).toBeUndefined();
		});

		it("should reject deletion when editedAt is newer (item was edited after delete)", async () => {
			// Create todo with newer editedAt
			const serverId = await createTodoViaApi(ctx, ctx.userA.apiKey, {
				title: "Recently Edited",
				editedAt: timestamp(120000), // 2 minutes after base
			});

			// Try to delete with older timestamp
			const { status, data } = await apiRequest(ctx, "POST", "/push", {
				apiKey: ctx.userA.apiKey,
				body: {
					todos: {
						upserted: [],
						deleted: [
							{
								serverId,
								deletedAt: timestamp(60000), // 1 minute (before edit)
							},
						],
					},
					lastSyncedAt: "1970-01-01T00:00:00.000Z",
				},
			});

			expect(status).toBe(200);
			const response = data as {
				conflicts: Array<{ serverId: string; reason: string }>;
			};
			expect(response.conflicts).toHaveLength(1);
			expect(response.conflicts[0].reason).toBe("Remote edit was newer");

			// Verify todo still exists
			const stateResponse = await apiRequest(ctx, "GET", "/state", {
				apiKey: ctx.userA.apiKey,
			});
			const state = stateResponse.data as {
				todos: Array<{ id: string }>;
			};
			const stillExists = state.todos.find((t) => t.id === serverId);
			expect(stillExists).toBeDefined();
		});
	});
});
