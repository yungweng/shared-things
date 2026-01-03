/**
 * State endpoint tests
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	apiRequest,
	createTestServer,
	createTodoViaApi,
	type TestContext,
} from "./setup.js";

describe("GET /state", () => {
	let ctx: TestContext;

	beforeAll(async () => {
		ctx = await createTestServer();
	});

	afterAll(async () => {
		await ctx.cleanup();
	});

	it("should return empty array when no todos exist", async () => {
		const { status, data } = await apiRequest(ctx, "GET", "/state", {
			apiKey: ctx.userA.apiKey,
		});

		expect(status).toBe(200);
		const response = data as { todos: unknown[]; syncedAt: string };
		expect(response.todos).toEqual([]);
		expect(response.syncedAt).toBeDefined();
	});

	it("should return all todos", async () => {
		// Create some todos
		await createTodoViaApi(ctx, ctx.userA.apiKey, { title: "Todo 1" });
		await createTodoViaApi(ctx, ctx.userA.apiKey, { title: "Todo 2" });
		await createTodoViaApi(ctx, ctx.userB.apiKey, { title: "Todo 3 by B" });

		const { status, data } = await apiRequest(ctx, "GET", "/state", {
			apiKey: ctx.userA.apiKey,
		});

		expect(status).toBe(200);
		const response = data as {
			todos: Array<{ title: string }>;
			syncedAt: string;
		};

		// Should include all todos (shared across users)
		expect(response.todos.length).toBeGreaterThanOrEqual(3);
		expect(response.todos.some((t) => t.title === "Todo 1")).toBe(true);
		expect(response.todos.some((t) => t.title === "Todo 2")).toBe(true);
		expect(response.todos.some((t) => t.title === "Todo 3 by B")).toBe(true);
	});

	it("should include all required fields", async () => {
		const serverId = await createTodoViaApi(ctx, ctx.userA.apiKey, {
			title: "Full Todo",
			notes: "Some notes",
		});

		const { data } = await apiRequest(ctx, "GET", "/state", {
			apiKey: ctx.userA.apiKey,
		});

		const response = data as {
			todos: Array<{
				id: string;
				title: string;
				notes: string;
				dueDate: string | null;
				tags: string[];
				status: string;
				position: number;
				editedAt: string;
				updatedAt: string;
			}>;
		};

		const todo = response.todos.find((t) => t.id === serverId);
		expect(todo).toBeDefined();
		expect(todo).toMatchObject({
			id: serverId,
			title: "Full Todo",
			notes: "Some notes",
			dueDate: null,
			tags: [],
			status: "open",
			position: 0,
		});
		expect(todo?.editedAt).toBeDefined();
		expect(todo?.updatedAt).toBeDefined();
	});

	it("should return current syncedAt timestamp", async () => {
		const before = new Date().toISOString();

		const { data } = await apiRequest(ctx, "GET", "/state", {
			apiKey: ctx.userA.apiKey,
		});

		const after = new Date().toISOString();
		const response = data as { syncedAt: string };

		expect(response.syncedAt).toBeDefined();
		expect(response.syncedAt >= before).toBe(true);
		expect(response.syncedAt <= after).toBe(true);
	});
});
