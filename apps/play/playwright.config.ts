import { defineConfig, devices } from "@playwright/test";

/**
 * Local E2E harness. Starts the SvelteKit dev server against the live
 * Convex dev deployment (friendly-chameleon-175). The tests use the
 * `_dev:devSignInAs` action to skip the magic-link email and grab a
 * session token directly.
 */
export default defineConfig({
	testDir: "./tests",
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	// Node 24 undici occasionally throws `TypeError: fetch failed` on
	// SSR loads to the Convex dev deployment under parallel Playwright
	// load. We also patch convex.ts to retry once internally; this is
	// the belt-and-braces layer for cases the inner retry misses.
	retries: 2,
	workers: 1,
	reporter: [["list"]],
	timeout: 30_000,
	use: {
		baseURL: "http://localhost:5173",
		trace: "retain-on-failure",
		screenshot: "only-on-failure"
	},
	projects: [
		{ name: "chromium", use: { ...devices["Desktop Chrome"] } }
	],
	webServer: {
		command: "pnpm dev",
		port: 5173,
		reuseExistingServer: !process.env.CI,
		stdout: "pipe",
		stderr: "pipe",
		timeout: 60_000
	}
});
