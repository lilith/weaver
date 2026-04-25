import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
	test: {
		// Two suites:
		// 1. unit/*  — pure-logic tests (no Convex, no network)
		// 2. convex/* — convex-test in-memory DB integration
		include: ["tests/**/*.test.ts", "tests/**/*.test.js"],
		environment: "node",
		// Slow tests here are a smell; if a unit test needs >2s it's
		// probably hitting a network. Bump only if intentional.
		testTimeout: 8_000,
		hookTimeout: 10_000,
	},
	resolve: {
		alias: {
			"@weaver/engine": resolve(root, "packages/engine/src"),
			"@weaver/engine/flows": resolve(root, "packages/engine/src/flows/index.ts"),
			"@weaver/engine/flags": resolve(root, "packages/engine/src/flags/index.ts"),
			"@weaver/engine/blobs": resolve(root, "packages/engine/src/blobs/index.ts"),
			"@weaver/engine/clock": resolve(root, "packages/engine/src/clock/index.ts"),
			"@weaver/engine/effects": resolve(root, "packages/engine/src/effects/index.ts"),
			"@weaver/engine/template": resolve(root, "packages/engine/src/template/index.ts"),
			"@weaver/engine/schemas": resolve(root, "packages/engine/src/schemas/index.ts"),
			"@weaver/engine/biomes": resolve(root, "packages/engine/src/biomes/index.ts"),
			"@weaver/engine/diagnostics": resolve(
				root,
				"packages/engine/src/diagnostics/index.ts",
			),
			"@weaver/engine/graph-layout": resolve(
				root,
				"packages/engine/src/graph-layout/index.ts",
			),
			"@weaver/engine/stats": resolve(
				root,
				"packages/engine/src/stats/index.ts",
			),
			"@weaver/engine/art": resolve(root, "packages/engine/src/art/prompts.ts"),
		},
	},
});
