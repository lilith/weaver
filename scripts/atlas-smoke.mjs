#!/usr/bin/env node
// scripts/atlas-smoke.mjs — non-destructive E2E sanity for the atlas
// authoring surface. Creates a throwaway atlas, drives the click-to-
// place interaction in a real (headless) browser, asserts that a row
// landed in module_overrides->map_placements, then deletes the atlas.
//
// Skips if PUBLIC_CONVEX_URL is unset (run after `pnpm run push-convex`).

import { chromium } from "playwright";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const CONVEX_URL =
	process.env.PUBLIC_CONVEX_URL || "https://friendly-chameleon-175.convex.cloud";
const BASE = process.env.BASE_URL || "http://localhost:5173";
const EMAIL = process.env.SHOT_EMAIL || "river.lilith@gmail.com";
const WORLD = process.env.WORLD_SLUG || "the-office";

const c = new ConvexHttpClient(CONVEX_URL);

const sessionRes = await c.action(api._dev.devSignInAs, { email: EMAIL });
const session_token = sessionRes.session_token;

const created = await c.mutation(api.atlases.createAtlas, {
	session_token,
	world_slug: WORLD,
	name: `smoke-${Date.now()}`,
	layer_mode: "solo",
});
console.log(`created atlas: ${created.slug}`);

let placementsBefore = 0;
{
	const det = await c.query(api.atlases.getAtlas, {
		session_token,
		world_slug: WORLD,
		atlas_slug: created.slug,
	});
	placementsBefore = Object.values(det.placements).flat().length;
}

const browser = await chromium.launch({ headless: true });
try {
	const ctx = await browser.newContext({
		viewport: { width: 1280, height: 900 },
		deviceScaleFactor: 1,
	});
	await ctx.addCookies([
		{
			name: "weaver_session",
			value: session_token,
			url: BASE,
			httpOnly: false,
			secure: false,
			sameSite: "Lax",
		},
	]);
	const page = await ctx.newPage();
	page.on("pageerror", (e) => console.error(`[page error] ${e.message}`));
	await page.goto(`${BASE}/admin/atlases/${WORLD}/${created.slug}`, {
		waitUntil: "domcontentloaded",
		timeout: 20_000,
	});
	await page.waitForLoadState("load").catch(() => {});
	await page.waitForTimeout(600);

	// Tap the first place in the rail.
	const railFirst = page.locator(".rail-item").first();
	await railFirst.waitFor({ state: "visible", timeout: 5_000 });
	const railName = (await railFirst.locator(".rail-item-name").textContent()) ?? "?";
	await railFirst.click();
	console.log(`armed rail item: ${railName.trim()}`);

	// Tap somewhere in the canvas.
	const canvas = page.locator(".atlas-canvas").first();
	await canvas.waitFor({ state: "visible", timeout: 5_000 });
	const box = await canvas.boundingBox();
	if (!box) throw new Error("canvas bounding box unavailable");
	await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.5);
	console.log(`tapped canvas at (40%, 50%)`);

	// Give the action time to round-trip + invalidate.
	await page.waitForTimeout(1500);

	// Re-read state.
	const det = await c.query(api.atlases.getAtlas, {
		session_token,
		world_slug: WORLD,
		atlas_slug: created.slug,
	});
	const placementsAfter = Object.values(det.placements).flat().length;
	console.log(`placements before=${placementsBefore} after=${placementsAfter}`);
	if (placementsAfter !== placementsBefore + 1) {
		throw new Error(
			`expected +1 placement, got +${placementsAfter - placementsBefore}`,
		);
	}
	console.log("✓ click-to-place round-trip works");
} finally {
	await browser.close();
	// Clean up the throwaway atlas.
	try {
		await c.mutation(api.atlases.deleteAtlas, {
			session_token,
			world_slug: WORLD,
			atlas_slug: created.slug,
		});
		console.log(`deleted atlas: ${created.slug}`);
	} catch (e) {
		console.error(`cleanup failed: ${e.message}`);
	}
}
