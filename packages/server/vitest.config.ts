import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		name: "server",
		include: ["src/__tests__/**/*.test.ts"],
		// Sequential execution to avoid race conditions
		fileParallelism: false,
		// Longer timeout for integration tests
		testTimeout: 10000,
	},
});
