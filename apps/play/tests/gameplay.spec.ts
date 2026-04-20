/**
 * Headless gameplay walk — exercises the Wave-2 UI surfaces in a real
 * browser against the live dev SvelteKit server.
 *
 * Covers:
 *   - new-world flow (two-step seed picker + character name)
 *   - custom seed tile reveals description textarea
 *   - choice buttons + weave textarea in one block
 *   - says / narrations render with prose, NOT between choices+weave
 *   - inventory panel appears below choices when state has items
 *   - art-curation collapse-on-nav: eye resets between locations
 *   - no "undefined" text visible anywhere after a normal play
 */

import { expect, test } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../convex/_generated/api";

const CONVEX_URL =
	process.env.PUBLIC_CONVEX_URL ?? "https://friendly-chameleon-175.convex.cloud";

async function signInWithCookie(context: any, email: string): Promise<string> {
	const client = new ConvexHttpClient(CONVEX_URL);
	const { session_token } = await client.action(api._dev.devSignInAs, {
		email,
	});
	await context.addCookies([
		{ name: "weaver_session", value: session_token, url: "http://localhost:5173" },
	]);
	return session_token;
}

test.describe("Wave-2 gameplay UI", () => {
	test("new-world flow: tile picker → character name → play", async ({
		page,
		context,
	}) => {
		await signInWithCookie(context, `gp-${Date.now()}@theweaver.quest`);
		await page.goto("/worlds");
		await expect(page.getByRole("heading", { name: /your worlds/i })).toBeVisible();

		// Step 1: no character-name field yet, just seed tiles.
		await expect(page.getByText(/what kind of world/i)).toBeVisible();
		const quietValeTile = page.getByRole("button", { name: /the quiet vale/i });
		await expect(quietValeTile).toBeVisible();
		await expect(page.getByRole("button", { name: /describe your own/i })).toBeVisible();

		// Character-name input should NOT be visible before a tile is picked.
		await expect(page.getByLabel(/character be called/i)).toHaveCount(0);

		// Pick Quiet Vale tile → character-name field appears.
		await quietValeTile.click();
		await expect(page.getByLabel(/character be called/i)).toBeVisible();

		// Name + submit.
		await page.getByLabel(/character be called/i).fill("Walker");
		await page.getByRole("button", { name: /begin in the quiet vale/i }).click();

		// Land on the play page.
		await page.waitForURL(/\/play\/quiet-vale-[a-z0-9]+\/village-square$/, {
			timeout: 10000,
		});
		await expect(page.getByRole("heading", { name: /village square/i })).toBeVisible();
	});

	test("custom-seed tile reveals description textarea", async ({
		page,
		context,
	}) => {
		await signInWithCookie(context, `gp-custom-${Date.now()}@theweaver.quest`);
		await page.goto("/worlds");
		await page.getByRole("button", { name: /describe your own/i }).click();
		await expect(page.getByPlaceholder(/walled city|lighthouse|cats/i)).toBeVisible();
		// Submit disabled while description is too short.
		const submit = page.getByRole("button", { name: /weave this world/i });
		await expect(submit).toBeDisabled();
		// Write a meaty-enough description.
		await page
			.getByPlaceholder(/walled city|lighthouse|cats/i)
			.fill("a hushed library where every book is waiting for its reader");
		await expect(submit).toBeEnabled();
		// Don't click — Opus call costs money in CI. Just confirm the flow works.
	});

	test("play page: choices + weave contiguous, inventory renders, no 'undefined' text", async ({
		page,
		context,
	}) => {
		const token = await signInWithCookie(
			context,
			`gp-play-${Date.now()}@theweaver.quest`,
		);
		const client = new ConvexHttpClient(CONVEX_URL);
		const seed = await client.mutation(api.seed.seedStarterWorld, {
			session_token: token,
			character_name: "Inv-Test",
		});
		// Give the character a canned inventory via dev — flip flag first.
		await client.mutation(api.flags.set, {
			session_token: token,
			flag_key: "flag.item_taxonomy",
			scope_kind: "world",
			scope_id: seed.slug,
			enabled: true,
		});
		await client.mutation(api.cli.setCharacterState, {
			session_token: token,
			world_slug: seed.slug,
			path: "inventory",
			value_json: JSON.stringify({
				"spare-key": { qty: 1, kind: "key" },
				"aspirin": { qty: 3, kind: "consumable", charges: 3 },
			}),
		});

		await page.goto(`/play/${seed.slug}/village-square`);
		await expect(page.getByRole("heading", { name: /village square/i })).toBeVisible();

		// Choice buttons exist.
		await expect(page.getByRole("button", { name: /draw water/i })).toBeVisible();
		await expect(
			page.getByRole("button", { name: /walk up to mara/i }),
		).toBeVisible();

		// Weave textarea is a sibling of choices (within the same <section>
		// that wraps options); verify it renders.
		await expect(page.getByPlaceholder(/or write what you do/i)).toBeVisible();

		// Inventory panel below.
		await expect(page.getByText(/what you carry/i)).toBeVisible();
		await expect(page.getByText(/spare-key/)).toBeVisible();
		await expect(page.getByText(/aspirin/)).toBeVisible();
		await expect(page.getByText(/×3/)).toBeVisible(); // aspirin qty=3

		// No literal "undefined" text anywhere on the page.
		const bodyText = await page.textContent("body");
		expect(bodyText?.includes("undefined")).toBeFalsy();

		// Pick a say-only option — says render above choices, NOT between
		// weave input and choices.
		await page.getByRole("button", { name: /draw water/i }).click();
		await expect(page.getByText(/the rope is cold/i)).toBeVisible();

		// The weave textarea should STILL be below the choice buttons after
		// the pick. Compare bounding-box y-coordinates.
		const waterButton = page.getByRole("button", { name: /draw water/i });
		const weaveTextarea = page.getByPlaceholder(/or write what you do/i);
		const btnBox = await waterButton.boundingBox();
		const taBox = await weaveTextarea.boundingBox();
		expect(btnBox).toBeTruthy();
		expect(taBox).toBeTruthy();
		expect(taBox!.y).toBeGreaterThan(btnBox!.y);
	});

	test("navigating to a new location collapses the scene art", async ({
		page,
		context,
	}) => {
		const token = await signInWithCookie(
			context,
			`gp-art-${Date.now()}@theweaver.quest`,
		);
		const client = new ConvexHttpClient(CONVEX_URL);
		const seed = await client.mutation(api.seed.seedStarterWorld, {
			session_token: token,
		});
		// Flip art_curation on for this world so the SceneArt branch renders.
		await client.mutation(api.flags.set, {
			session_token: token,
			flag_key: "flag.art_curation",
			scope_kind: "world",
			scope_id: seed.slug,
			enabled: true,
		});

		await page.goto(`/play/${seed.slug}/village-square`);
		// The eye affordance is present on a curation-on page.
		// Use a loose selector — button with aria-label about revealing art.
		const eyeCount = await page
			.locator('button[aria-expanded][aria-label*="art" i], button[aria-label*="wardrobe" i], button[aria-label*="show art" i]')
			.count();
		expect(eyeCount).toBeGreaterThan(0);

		// Navigate to mara-cottage; the {#key entity_id} wrap remounts
		// SceneArt with the eye closed (aria-expanded="false").
		await page.getByRole("button", { name: /walk up to mara/i }).click();
		await page.waitForURL(/\/mara-cottage$/);
		const stillCollapsed = await page
			.locator('button[aria-expanded="true"]')
			.count();
		expect(stillCollapsed).toBe(0);
	});
});
