/**
 * Authentication tests
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiRequest, createTestServer, type TestContext } from "./setup.js";

describe("Authentication", () => {
	let ctx: TestContext;

	beforeAll(async () => {
		ctx = await createTestServer();
	});

	afterAll(async () => {
		await ctx.cleanup();
	});

	describe("GET /health", () => {
		it("should allow requests without API key", async () => {
			const { status, data } = await apiRequest(ctx, "GET", "/health");

			expect(status).toBe(200);
			expect(data).toMatchObject({ status: "ok" });
		});
	});

	describe("GET /state", () => {
		it("should reject requests without API key", async () => {
			const { status, data } = await apiRequest(ctx, "GET", "/state");

			expect(status).toBe(401);
			expect(data).toMatchObject({
				error: "Missing or invalid authorization header",
				code: "UNAUTHORIZED",
			});
		});

		it("should reject requests with invalid API key", async () => {
			const { status, data } = await apiRequest(ctx, "GET", "/state", {
				apiKey: "invalid-key-12345",
			});

			expect(status).toBe(401);
			expect(data).toMatchObject({
				error: "Invalid API key",
				code: "UNAUTHORIZED",
			});
		});

		it("should allow requests with valid API key", async () => {
			const { status, data } = await apiRequest(ctx, "GET", "/state", {
				apiKey: ctx.userA.apiKey,
			});

			expect(status).toBe(200);
			expect(data).toHaveProperty("todos");
			expect(data).toHaveProperty("syncedAt");
		});
	});

	describe("POST /push", () => {
		it("should reject requests without API key", async () => {
			const { status } = await apiRequest(ctx, "POST", "/push", {
				body: { todos: { upserted: [], deleted: [] }, lastSyncedAt: "" },
			});

			expect(status).toBe(401);
		});
	});

	describe("GET /delta", () => {
		it("should reject requests without API key", async () => {
			const { status } = await apiRequest(
				ctx,
				"GET",
				"/delta?since=2026-01-01T00:00:00.000Z",
			);

			expect(status).toBe(401);
		});
	});
});
