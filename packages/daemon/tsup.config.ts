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
  external: ["commander", "@inquirer/prompts", "chalk", "update-notifier"],
  dts: false,
  sourcemap: false,
  minify: false,
});
