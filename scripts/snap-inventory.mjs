// Crop screenshot of the inventory panel only.
import { chromium } from "playwright";
import { ConvexHttpClient } from "convex/browser";
import { api } from "/home/lilith/fun/weaver/convex/_generated/api.js";

const c = new ConvexHttpClient("https://friendly-chameleon-175.convex.cloud");
const { session_token } = await c.action(api._dev.devSignInAs, {
	email: "river.lilith@gmail.com",
});

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 720, height: 900 } });
await ctx.addCookies([
	{
		name: "weaver_session",
		value: session_token,
		url: "http://localhost:5173",
		httpOnly: false,
		secure: false,
		sameSite: "Lax",
	},
]);
const page = await ctx.newPage();
await page.goto("http://localhost:5173/play/the-office/fort-door", {
	waitUntil: "domcontentloaded",
	timeout: 20_000,
});
await page.waitForTimeout(1500);
const panel = page.locator("section.story-card").filter({ hasText: /in your bag|what you carry/ }).first();
await panel.waitFor({ state: "visible", timeout: 8_000 });
await panel.screenshot({ path: "/tmp/weaver-shots/inventory-panel.png" });
console.log("saved inventory-panel.png");
await browser.close();
