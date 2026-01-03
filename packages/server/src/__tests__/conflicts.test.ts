/**
 * Cross-user conflict resolution tests
 *
 * These tests verify the core sync logic: timestamp-based conflict resolution
 * when multiple users edit the same data.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	apiRequest,
	createTestServer,
	createTodoViaApi,
	type TestContext,
	timestamp,
} from "./setup.js";

describe("Cross-user conflict resolution", () => {
	let ctx: TestContext;

	beforeAll(async () => {
		ctx = await createTestServer();
	});

	afterAll(async () => {
		await ctx.cleanup();
	});

	describe("shared data visibility", () => {
		it("should let User B see User A's created todos", async () => {
			// User A creates a todo
			const serverId = await createTodoViaApi(ctx, ctx.userA.apiKey, {
				title: "Created by User A",
			});

			// User B should see it
			const { status, data } = await apiRequest(ctx, "GET", "/state", {
				apiKey: ctx.userB.apiKey,
			});

			expect(status).toBe(200);
			const state = data as { todos: Array<{ id: string; title: string }> };
			const found = state.todos.find((t) => t.id === serverId);
			expect(found).toBeDefined();
			expect(found?.title).toBe("Created by User A");
		});

		it("should let User B edit User A's todos", async () => {
			// User A creates
			const serverId = await createTodoViaApi(ctx, ctx.userA.apiKey, {
				title: "Original by A",
				editedAt: timestamp(0),
			});

			// User B edits with newer timestamp
			const { status, data } = await apiRequest(ctx, "POST", "/push", {
				apiKey: ctx.userB.apiKey,
				body: {
					todos: {
						upserted: [
							{
								serverId,
								clientId: serverId,
								title: "Edited by B",
								notes: "",
								dueDate: null,
								tags: [],
								status: "open",
								position: 0,
								editedAt: timestamp(60000),
							},
						],
						deleted: [],
					},
					lastSyncedAt: "1970-01-01T00:00:00.000Z",
				},
			});

			expect(status).toBe(200);
			const response = data as { conflicts: unknown[] };
			expect(response.conflicts).toHaveLength(0);

			// Verify the edit took effect
			const stateResponse = await apiRequest(ctx, "GET", "/state", {
				apiKey: ctx.userA.apiKey,
			});
			const state = stateResponse.data as {
				todos: Array<{ id: string; title: string }>;
			};
			const todo = state.todos.find((t) => t.id === serverId);
			expect(todo?.title).toBe("Edited by B");
		});
	});

	describe("edit-vs-edit conflicts", () => {
		it("should resolve by timestamp - newer wins", async () => {
			// User A creates todo
			const serverId = await createTodoViaApi(ctx, ctx.userA.apiKey, {
				title: "Original",
				editedAt: timestamp(0),
			});

			// User B edits with FUTURE timestamp (simulating "remote wins")
			await apiRequest(ctx, "POST", "/push", {
				apiKey: ctx.userB.apiKey,
				body: {
					todos: {
						upserted: [
							{
								serverId,
								clientId: serverId,
								title: "User B Edit (newer)",
								notes: "",
								dueDate: null,
								tags: [],
								status: "open",
								position: 0,
								editedAt: timestamp(120000), // 2 minutes later
							},
						],
						deleted: [],
					},
					lastSyncedAt: "1970-01-01T00:00:00.000Z",
				},
			});

			// User A tries to edit with OLDER timestamp - should conflict
			const { status, data } = await apiRequest(ctx, "POST", "/push", {
				apiKey: ctx.userA.apiKey,
				body: {
					todos: {
						upserted: [
							{
								serverId,
								clientId: serverId,
								title: "User A Edit (older)",
								notes: "",
								dueDate: null,
								tags: [],
								status: "open",
								position: 0,
								editedAt: timestamp(60000), // 1 minute (older than B's edit)
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
					clientTodo: { title: string };
					serverTodo: { title: string };
				}>;
			};

			// Should have conflict
			expect(response.conflicts).toHaveLength(1);
			expect(response.conflicts[0].serverId).toBe(serverId);
			expect(response.conflicts[0].reason).toBe("Remote edit was newer");
			expect(response.conflicts[0].clientTodo.title).toBe(
				"User A Edit (older)",
			);
			expect(response.conflicts[0].serverTodo.title).toBe(
				"User B Edit (newer)",
			);

			// Server should still have User B's version
			const stateResponse = await apiRequest(ctx, "GET", "/state", {
				apiKey: ctx.userA.apiKey,
			});
			const state = stateResponse.data as {
				todos: Array<{ id: string; title: string }>;
			};
			const todo = state.todos.find((t) => t.id === serverId);
			expect(todo?.title).toBe("User B Edit (newer)");
		});

		it("should accept edit when client timestamp is newer", async () => {
			// User A creates todo
			const serverId = await createTodoViaApi(ctx, ctx.userA.apiKey, {
				title: "Original",
				editedAt: timestamp(0),
			});

			// User B edits with older timestamp
			await apiRequest(ctx, "POST", "/push", {
				apiKey: ctx.userB.apiKey,
				body: {
					todos: {
						upserted: [
							{
								serverId,
								clientId: serverId,
								title: "User B Edit (older)",
								notes: "",
								dueDate: null,
								tags: [],
								status: "open",
								position: 0,
								editedAt: timestamp(30000), // 30 seconds
							},
						],
						deleted: [],
					},
					lastSyncedAt: "1970-01-01T00:00:00.000Z",
				},
			});

			// User A edits with NEWER timestamp - should win
			const { status, data } = await apiRequest(ctx, "POST", "/push", {
				apiKey: ctx.userA.apiKey,
				body: {
					todos: {
						upserted: [
							{
								serverId,
								clientId: serverId,
								title: "User A Edit (newer)",
								notes: "",
								dueDate: null,
								tags: [],
								status: "open",
								position: 0,
								editedAt: timestamp(60000), // 1 minute (newer)
							},
						],
						deleted: [],
					},
					lastSyncedAt: "1970-01-01T00:00:00.000Z",
				},
			});

			expect(status).toBe(200);
			const response = data as { conflicts: unknown[] };
			expect(response.conflicts).toHaveLength(0);

			// Server should have User A's version
			const stateResponse = await apiRequest(ctx, "GET", "/state", {
				apiKey: ctx.userA.apiKey,
			});
			const state = stateResponse.data as {
				todos: Array<{ id: string; title: string }>;
			};
			const todo = state.todos.find((t) => t.id === serverId);
			expect(todo?.title).toBe("User A Edit (newer)");
		});
	});

	describe("delete-vs-edit conflicts", () => {
		it("should allow deletion when deletedAt is newer than editedAt", async () => {
			// User A creates todo
			const serverId = await createTodoViaApi(ctx, ctx.userA.apiKey, {
				title: "Will be deleted",
				editedAt: timestamp(0),
			});

			// User B deletes with newer timestamp
			const { status, data } = await apiRequest(ctx, "POST", "/push", {
				apiKey: ctx.userB.apiKey,
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
					lastSyncedAt: "1970-01-01T00:00:00.000Z",
				},
			});

			expect(status).toBe(200);
			const response = data as { conflicts: unknown[] };
			expect(response.conflicts).toHaveLength(0);

			// Todo should be gone
			const stateResponse = await apiRequest(ctx, "GET", "/state", {
				apiKey: ctx.userA.apiKey,
			});
			const state = stateResponse.data as { todos: Array<{ id: string }> };
			expect(state.todos.find((t) => t.id === serverId)).toBeUndefined();
		});

		it("should reject deletion when item was edited after delete timestamp", async () => {
			// User A creates todo with recent edit
			const serverId = await createTodoViaApi(ctx, ctx.userA.apiKey, {
				title: "Recently edited",
				editedAt: timestamp(120000), // 2 minutes
			});

			// User B tries to delete with older timestamp
			const { status, data } = await apiRequest(ctx, "POST", "/push", {
				apiKey: ctx.userB.apiKey,
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

			// Todo should still exist
			const stateResponse = await apiRequest(ctx, "GET", "/state", {
				apiKey: ctx.userA.apiKey,
			});
			const state = stateResponse.data as { todos: Array<{ id: string }> };
			expect(state.todos.find((t) => t.id === serverId)).toBeDefined();
		});
	});

	describe("edit-vs-tombstone conflicts", () => {
		it("should reject edit when todo was deleted with newer timestamp", async () => {
			// User A creates todo
			const serverId = await createTodoViaApi(ctx, ctx.userA.apiKey, {
				title: "Will be deleted",
				editedAt: timestamp(0),
			});

			// User B deletes with newer timestamp
			await apiRequest(ctx, "POST", "/push", {
				apiKey: ctx.userB.apiKey,
				body: {
					todos: {
						upserted: [],
						deleted: [
							{
								serverId,
								deletedAt: timestamp(120000), // 2 minutes
							},
						],
					},
					lastSyncedAt: "1970-01-01T00:00:00.000Z",
				},
			});

			// User A tries to edit with older timestamp (after deletion exists as tombstone)
			const { status, data } = await apiRequest(ctx, "POST", "/push", {
				apiKey: ctx.userA.apiKey,
				body: {
					todos: {
						upserted: [
							{
								serverId,
								clientId: serverId,
								title: "Edited (but deleted)",
								notes: "",
								dueDate: null,
								tags: [],
								status: "open",
								position: 0,
								editedAt: timestamp(60000), // 1 minute (before delete)
							},
						],
						deleted: [],
					},
					lastSyncedAt: "1970-01-01T00:00:00.000Z",
				},
			});

			expect(status).toBe(200);
			const response = data as {
				conflicts: Array<{ serverId: string; reason: string }>;
			};
			expect(response.conflicts).toHaveLength(1);
			expect(response.conflicts[0].reason).toBe("Remote delete was newer");

			// Todo should still be deleted
			const stateResponse = await apiRequest(ctx, "GET", "/state", {
				apiKey: ctx.userA.apiKey,
			});
			const state = stateResponse.data as { todos: Array<{ id: string }> };
			expect(state.todos.find((t) => t.id === serverId)).toBeUndefined();
		});

		it("should resurrect deleted todo when edit is newer than deletion", async () => {
			// User A creates todo
			const serverId = await createTodoViaApi(ctx, ctx.userA.apiKey, {
				title: "Will be resurrected",
				editedAt: timestamp(0),
			});

			// User B deletes with older timestamp
			await apiRequest(ctx, "POST", "/push", {
				apiKey: ctx.userB.apiKey,
				body: {
					todos: {
						upserted: [],
						deleted: [
							{
								serverId,
								deletedAt: timestamp(60000), // 1 minute
							},
						],
					},
					lastSyncedAt: "1970-01-01T00:00:00.000Z",
				},
			});

			// Verify todo is deleted
			const deletedState = await apiRequest(ctx, "GET", "/state", {
				apiKey: ctx.userA.apiKey,
			});
			expect(
				(deletedState.data as { todos: Array<{ id: string }> }).todos.find(
					(t) => t.id === serverId,
				),
			).toBeUndefined();

			// User A edits with newer timestamp - should resurrect
			const { status, data } = await apiRequest(ctx, "POST", "/push", {
				apiKey: ctx.userA.apiKey,
				body: {
					todos: {
						upserted: [
							{
								serverId,
								clientId: serverId,
								title: "Resurrected!",
								notes: "",
								dueDate: null,
								tags: [],
								status: "open",
								position: 0,
								editedAt: timestamp(120000), // 2 minutes (after delete)
							},
						],
						deleted: [],
					},
					lastSyncedAt: "1970-01-01T00:00:00.000Z",
				},
			});

			expect(status).toBe(200);
			const response = data as { conflicts: unknown[] };
			expect(response.conflicts).toHaveLength(0);

			// Todo should exist again
			const stateResponse = await apiRequest(ctx, "GET", "/state", {
				apiKey: ctx.userA.apiKey,
			});
			const state = stateResponse.data as {
				todos: Array<{ id: string; title: string }>;
			};
			const todo = state.todos.find((t) => t.id === serverId);
			expect(todo).toBeDefined();
			expect(todo?.title).toBe("Resurrected!");
		});
	});

	describe("timestamp tiebreaker", () => {
		it("should use userId as tiebreaker when timestamps are equal", async () => {
			const exactTime = timestamp(0);

			// Determine which user has the higher UUID (will win tiebreaker)
			const userAWins = ctx.userA.id > ctx.userB.id;
			const winner = userAWins ? ctx.userA : ctx.userB;
			const loser = userAWins ? ctx.userB : ctx.userA;

			// Loser creates todo first
			const serverId = await createTodoViaApi(ctx, loser.apiKey, {
				title: "Original by loser",
				editedAt: exactTime,
			});

			// Winner edits with SAME timestamp - should win due to higher userId
			const { status, data } = await apiRequest(ctx, "POST", "/push", {
				apiKey: winner.apiKey,
				body: {
					todos: {
						upserted: [
							{
								serverId,
								clientId: serverId,
								title: "Winner edit",
								notes: "",
								dueDate: null,
								tags: [],
								status: "open",
								position: 0,
								editedAt: exactTime, // Same timestamp!
							},
						],
						deleted: [],
					},
					lastSyncedAt: "1970-01-01T00:00:00.000Z",
				},
			});

			expect(status).toBe(200);
			const response = data as { conflicts: unknown[] };
			// Winner should have no conflicts (higher userId wins)
			expect(response.conflicts).toHaveLength(0);

			const stateResponse = await apiRequest(ctx, "GET", "/state", {
				apiKey: ctx.userA.apiKey,
			});
			const state = stateResponse.data as {
				todos: Array<{ id: string; title: string }>;
			};
			const todo = state.todos.find((t) => t.id === serverId);
			expect(todo?.title).toBe("Winner edit");
		});

		it("should reject edit from lower userId when timestamps are equal", async () => {
			const exactTime = timestamp(0);

			// Determine which user has the higher UUID (will win tiebreaker)
			const userAWins = ctx.userA.id > ctx.userB.id;
			const winner = userAWins ? ctx.userA : ctx.userB;
			const loser = userAWins ? ctx.userB : ctx.userA;

			// Winner creates todo first
			const serverId = await createTodoViaApi(ctx, winner.apiKey, {
				title: "Original by winner",
				editedAt: exactTime,
			});

			// Loser tries to edit with SAME timestamp - should get conflict
			const { status, data } = await apiRequest(ctx, "POST", "/push", {
				apiKey: loser.apiKey,
				body: {
					todos: {
						upserted: [
							{
								serverId,
								clientId: serverId,
								title: "Loser edit",
								notes: "",
								dueDate: null,
								tags: [],
								status: "open",
								position: 0,
								editedAt: exactTime, // Same timestamp!
							},
						],
						deleted: [],
					},
					lastSyncedAt: "1970-01-01T00:00:00.000Z",
				},
			});

			expect(status).toBe(200);
			const response = data as {
				conflicts: Array<{ serverId: string; reason: string }>;
			};
			// Loser should get conflict (lower userId loses)
			expect(response.conflicts).toHaveLength(1);
			expect(response.conflicts[0].reason).toBe("Remote edit was newer");

			// Original should be preserved
			const stateResponse = await apiRequest(ctx, "GET", "/state", {
				apiKey: ctx.userA.apiKey,
			});
			const state = stateResponse.data as {
				todos: Array<{ id: string; title: string }>;
			};
			const todo = state.todos.find((t) => t.id === serverId);
			expect(todo?.title).toBe("Original by winner");
		});
	});

	describe("simultaneous edits", () => {
		it("should handle rapid concurrent edits consistently", async () => {
			// Create base todo
			const serverId = await createTodoViaApi(ctx, ctx.userA.apiKey, {
				title: "Base",
				editedAt: timestamp(0),
			});

			// Simulate rapid edits from both users
			// User B: t+1 minute
			await apiRequest(ctx, "POST", "/push", {
				apiKey: ctx.userB.apiKey,
				body: {
					todos: {
						upserted: [
							{
								serverId,
								clientId: serverId,
								title: "B at t+1",
								notes: "",
								dueDate: null,
								tags: [],
								status: "open",
								position: 0,
								editedAt: timestamp(60000),
							},
						],
						deleted: [],
					},
					lastSyncedAt: "1970-01-01T00:00:00.000Z",
				},
			});

			// User A: t+2 minutes (should win)
			await apiRequest(ctx, "POST", "/push", {
				apiKey: ctx.userA.apiKey,
				body: {
					todos: {
						upserted: [
							{
								serverId,
								clientId: serverId,
								title: "A at t+2",
								notes: "",
								dueDate: null,
								tags: [],
								status: "open",
								position: 0,
								editedAt: timestamp(120000),
							},
						],
						deleted: [],
					},
					lastSyncedAt: "1970-01-01T00:00:00.000Z",
				},
			});

			// User B: t+3 minutes (should win)
			await apiRequest(ctx, "POST", "/push", {
				apiKey: ctx.userB.apiKey,
				body: {
					todos: {
						upserted: [
							{
								serverId,
								clientId: serverId,
								title: "B at t+3 (final)",
								notes: "",
								dueDate: null,
								tags: [],
								status: "open",
								position: 0,
								editedAt: timestamp(180000),
							},
						],
						deleted: [],
					},
					lastSyncedAt: "1970-01-01T00:00:00.000Z",
				},
			});

			// Final state should be B's last edit
			const stateResponse = await apiRequest(ctx, "GET", "/state", {
				apiKey: ctx.userA.apiKey,
			});
			const state = stateResponse.data as {
				todos: Array<{ id: string; title: string }>;
			};
			const todo = state.todos.find((t) => t.id === serverId);
			expect(todo?.title).toBe("B at t+3 (final)");
		});
	});
});
