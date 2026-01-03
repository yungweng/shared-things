import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Project configurations
		projects: ["packages/server/vitest.config.ts"],
	},
});
