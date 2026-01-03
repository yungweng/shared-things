/**
 * Reset endpoint tests
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	apiRequest,
	createTestServer,
	createTodoViaApi,
	type TestContext,
} from "./setup.js";

describe("DELETE /reset", () => {
	let ctx: TestContext;

	beforeAll(async () => {
		ctx = await createTestServer();
	});

	afterAll(async () => {
		await ctx.cleanup();
	});

	it("should reject requests without API key", async () => {
		const { status } = await apiRequest(ctx, "DELETE", "/reset");

		expect(status).toBe(401);
	});

	it("should delete all todos created by the user", async () => {
		// Create some todos as User A
		await createTodoViaApi(ctx, ctx.userA.apiKey, { title: "A's Todo 1" });
		await createTodoViaApi(ctx, ctx.userA.apiKey, { title: "A's Todo 2" });

		// Verify they exist
		const beforeReset = await apiRequest(ctx, "GET", "/state", {
			apiKey: ctx.userA.apiKey,
		});
		const stateBefore = beforeReset.data as { todos: Array<{ title: string }> };
		expect(stateBefore.todos.some((t) => t.title === "A's Todo 1")).toBe(true);
		expect(stateBefore.todos.some((t) => t.title === "A's Todo 2")).toBe(true);

		// Reset User A's data
		const { status, data } = await apiRequest(ctx, "DELETE", "/reset", {
			apiKey: ctx.userA.apiKey,
		});

		expect(status).toBe(200);
		const response = data as { success: boolean; deleted: { todos: number } };
		expect(response.success).toBe(true);
		expect(response.deleted.todos).toBeGreaterThanOrEqual(2);

		// Verify todos are gone
		const afterReset = await apiRequest(ctx, "GET", "/state", {
			apiKey: ctx.userA.apiKey,
		});
		const stateAfter = afterReset.data as { todos: Array<{ title: string }> };
		expect(stateAfter.todos.some((t) => t.title === "A's Todo 1")).toBe(false);
		expect(stateAfter.todos.some((t) => t.title === "A's Todo 2")).toBe(false);
	});

	it("should only delete the requesting user's todos", async () => {
		// Create todos as both users
		await createTodoViaApi(ctx, ctx.userA.apiKey, { title: "A's Reset Test" });
		await createTodoViaApi(ctx, ctx.userB.apiKey, { title: "B's Reset Test" });

		// Reset User A's data
		await apiRequest(ctx, "DELETE", "/reset", {
			apiKey: ctx.userA.apiKey,
		});

		// User B's todo should still exist
		const stateResponse = await apiRequest(ctx, "GET", "/state", {
			apiKey: ctx.userB.apiKey,
		});
		const state = stateResponse.data as { todos: Array<{ title: string }> };
		expect(state.todos.some((t) => t.title === "B's Reset Test")).toBe(true);
		expect(state.todos.some((t) => t.title === "A's Reset Test")).toBe(false);
	});
});
