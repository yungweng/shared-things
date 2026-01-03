/**
 * Delta endpoint tests
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	apiRequest,
	createTestServer,
	createTodoViaApi,
	type TestContext,
} from "./setup.js";

describe("GET /delta", () => {
	let ctx: TestContext;

	beforeAll(async () => {
		ctx = await createTestServer();
	});

	afterAll(async () => {
		await ctx.cleanup();
	});

	it("should return empty delta when nothing changed", async () => {
		const since = new Date().toISOString();

		const { status, data } = await apiRequest(
			ctx,
			"GET",
			`/delta?since=${encodeURIComponent(since)}`,
			{ apiKey: ctx.userA.apiKey },
		);

		expect(status).toBe(200);
		const response = data as {
			todos: { upserted: unknown[]; deleted: unknown[] };
		};
		expect(response.todos.upserted).toHaveLength(0);
		expect(response.todos.deleted).toHaveLength(0);
	});

	it("should return upserted todos modified after 'since' timestamp", async () => {
		const beforeCreate = new Date().toISOString();

		// Create a todo
		const serverId = await createTodoViaApi(ctx, ctx.userA.apiKey, {
			title: "New Todo For Delta",
		});

		// Small delay to ensure timestamp difference
		await new Promise((r) => setTimeout(r, 10));

		const { status, data } = await apiRequest(
			ctx,
			"GET",
			`/delta?since=${encodeURIComponent(beforeCreate)}`,
			{ apiKey: ctx.userA.apiKey },
		);

		expect(status).toBe(200);
		const response = data as {
			todos: { upserted: Array<{ id: string; title: string }> };
		};
		const found = response.todos.upserted.find((t) => t.id === serverId);
		expect(found).toBeDefined();
		expect(found?.title).toBe("New Todo For Delta");
	});

	it("should return deleted items after 'since' timestamp", async () => {
		// Create a todo
		const serverId = await createTodoViaApi(ctx, ctx.userA.apiKey, {
			title: "To Delete For Delta",
		});

		const beforeDelete = new Date().toISOString();

		// Delete the todo with a timestamp after beforeDelete
		const deleteTime = new Date(Date.now() + 1000).toISOString(); // 1 second in future
		await apiRequest(ctx, "POST", "/push", {
			apiKey: ctx.userA.apiKey,
			body: {
				todos: {
					upserted: [],
					deleted: [{ serverId, deletedAt: deleteTime }],
				},
				lastSyncedAt: beforeDelete,
			},
		});

		const { status, data } = await apiRequest(
			ctx,
			"GET",
			`/delta?since=${encodeURIComponent(beforeDelete)}`,
			{ apiKey: ctx.userA.apiKey },
		);

		expect(status).toBe(200);
		const response = data as {
			todos: { deleted: Array<{ serverId: string }> };
		};
		const found = response.todos.deleted.find((d) => d.serverId === serverId);
		expect(found).toBeDefined();
	});

	it("should not return items modified before 'since' timestamp", async () => {
		// Create a todo
		await createTodoViaApi(ctx, ctx.userA.apiKey, {
			title: "Old Todo",
		});

		// Wait a bit
		await new Promise((r) => setTimeout(r, 50));
		const afterCreate = new Date().toISOString();

		const { status, data } = await apiRequest(
			ctx,
			"GET",
			`/delta?since=${encodeURIComponent(afterCreate)}`,
			{ apiKey: ctx.userA.apiKey },
		);

		expect(status).toBe(200);
		const response = data as {
			todos: { upserted: Array<{ title: string }> };
		};

		// Should not include the old todo
		const found = response.todos.upserted.find((t) => t.title === "Old Todo");
		expect(found).toBeUndefined();
	});

	it("should require 'since' query parameter", async () => {
		const { status, data } = await apiRequest(ctx, "GET", "/delta", {
			apiKey: ctx.userA.apiKey,
		});

		expect(status).toBe(200); // Endpoint returns 200 with error object
		expect(data).toMatchObject({
			error: 'Missing "since" query parameter',
			code: "BAD_REQUEST",
		});
	});
});
