import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  // Bundle @shared-things/common into the output
  noExternal: ["@shared-things/common"],
  // Don't bundle these - they're runtime dependencies
  external: [
    "better-sqlite3",
    "fastify",
    "@fastify/cors",
    "commander",
    "@inquirer/prompts",
    "chalk",
  ],
  dts: false,
  sourcemap: false,
  minify: false,
});
