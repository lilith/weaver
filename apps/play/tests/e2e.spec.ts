/**
 * End-to-end smoke: full user journey from sign-in through a played turn.
 * Uses devSignInAs to skip email so the test is self-contained.
 */
import { expect, test } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../convex/_generated/api";

const CONVEX_URL = process.env.PUBLIC_CONVEX_URL ?? "https://friendly-chameleon-175.convex.cloud";

async function signIn(email: string): Promise<string> {
	const client = new ConvexHttpClient(CONVEX_URL);
	const { session_token } = await client.action(api._dev.devSignInAs, { email });
	return session_token;
}

test.describe("Weaver core loop", () => {
	let sessionToken: string;

	test.beforeEach(async ({ context }) => {
		sessionToken = await signIn(`e2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@theweaver.quest`);
		await context.addCookies([
			{
				name: "weaver_session",
				value: sessionToken,
				url: "http://localhost:5173"
			}
		]);
	});

	test("home → worlds → seed → play → pick option", async ({ page }) => {
		await page.goto("/");
		await expect(page.getByRole("heading", { level: 1 })).toContainText("Welcome back");

		await page.getByRole("link", { name: /worlds/i }).first().click();
		await expect(page).toHaveURL(/\/worlds$/);
		await expect(page.getByRole("heading", { name: /your worlds/i })).toBeVisible();

		// Fresh user has zero worlds — seed.
		await page.getByLabel(/character/i).fill("Testbed");
		await page.getByRole("button", { name: /begin in the quiet vale/i }).click();

		await expect(page).toHaveURL(/\/play\/quiet-vale-[a-z0-9]+\/village-square$/);
		await expect(page.getByRole("heading", { name: /village square/i })).toBeVisible();
		await expect(page.getByText(/A cobbled square/)).toBeVisible();

		// Pick a "say" option (no redirect).
		await page.getByRole("button", { name: /draw water/i }).click();
		await expect(page.getByText(/the rope is cold/i)).toBeVisible();

		// Pick a "goto" option (redirect to cottage).
		await page.getByRole("button", { name: /walk up to mara/i }).click();
		await expect(page).toHaveURL(/\/mara-cottage$/);
		await expect(page.getByText(/pine shavings/)).toBeVisible();

		// Step back out → return to village-square.
		await page.getByRole("button", { name: /step back out/i }).click();
		await expect(page).toHaveURL(/\/village-square$/);
	});

	test("logged-out home shows sign-in form", async ({ page, context }) => {
		await context.clearCookies();
		await page.goto("/");
		await expect(page.getByRole("heading", { name: "Weaver" })).toBeVisible();
		await expect(page.getByPlaceholder(/you@example/)).toBeVisible();
		await expect(page.getByRole("button", { name: /send me a sign-in link/i })).toBeVisible();
	});

	test("non-member can't read another user's world", async ({ page, context }) => {
		// Create world as user A.
		const tokenA = await signIn(`e2e-a-${Date.now()}@theweaver.quest`);
		const clientA = new ConvexHttpClient(CONVEX_URL);
		const { slug } = await clientA.mutation(api.seed.seedStarterWorld, {
			session_token: tokenA,
			template: "quiet-vale"
		});

		// Visit as user B (current test's session).
		await context.clearCookies();
		await context.addCookies([
			{ name: "weaver_session", value: sessionToken, url: "http://localhost:5173" }
		]);

		const response = await page.goto(`/play/${slug}/village-square`);
		// isolation: must 404/5xx, never render A's location data
		expect(response?.status()).toBeGreaterThanOrEqual(400);
	});
});
