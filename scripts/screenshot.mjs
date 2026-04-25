#!/usr/bin/env node
// scripts/screenshot.mjs — autonomous screenshot harness for the
// admin surfaces. Spawns a headless browser, mints a dev session,
// sets the cookie, navigates to each requested route, and writes a
// PNG to /tmp/weaver-shots/<name>.png.
//
// Usage:
//   node scripts/screenshot.mjs               (default route set)
//   node scripts/screenshot.mjs <route>...    (one or more URLs)
//   node scripts/screenshot.mjs --width 375   (mobile width)

import { chromium } from "playwright";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const CONVEX_URL =
	process.env.PUBLIC_CONVEX_URL || "https://friendly-chameleon-175.convex.cloud";
const BASE = process.env.BASE_URL || "http://localhost:5173";
const OUTDIR = process.env.SHOT_DIR || "/tmp/weaver-shots";
const EMAIL = process.env.SHOT_EMAIL || "river.lilith@gmail.com";

mkdirSync(OUTDIR, { recursive: true });

const args = process.argv.slice(2);
const widthIdx = args.indexOf("--width");
const heightIdx = args.indexOf("--height");
const fullPageIdx = args.indexOf("--no-fullpage");
const width = widthIdx !== -1 ? Number(args[widthIdx + 1]) : 1280;
const height = heightIdx !== -1 ? Number(args[heightIdx + 1]) : 900;
const fullPage = fullPageIdx === -1;
const positional = args.filter(
	(a, i) => !a.startsWith("--") && args[i - 1] !== "--width" && args[i - 1] !== "--height",
);

const DEFAULT_ROUTES = [
	{ name: "admin-hub", path: "/admin/the-office" },
	{ name: "atlases-list-empty", path: "/admin/atlases/the-office" },
];

async function mintSession() {
	const c = new ConvexHttpClient(CONVEX_URL);
	const r = await c.action(api._dev.devSignInAs, { email: EMAIL });
	return r.session_token;
}

const sessionToken = await mintSession();
console.log(`session minted for ${EMAIL}`);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
	viewport: { width, height },
	deviceScaleFactor: 2,
});
await ctx.addCookies([
	{
		name: "weaver_session",
		value: sessionToken,
		url: BASE,
		httpOnly: false,
		secure: false,
		sameSite: "Lax",
	},
]);

const page = await ctx.newPage();
page.on("pageerror", (e) => console.error(`[page error] ${e.message}`));
page.on("console", (m) => {
	if (m.type() === "error" || m.type() === "warning") {
		console.log(`[${m.type()}] ${m.text()}`);
	}
});

const routes = positional.length > 0
	? positional.map((p, i) => ({
			name: p.replace(/^\//, "").replace(/\//g, "_") || `route-${i}`,
			path: p,
	  }))
	: DEFAULT_ROUTES;

for (const r of routes) {
	const url = `${BASE}${r.path}`;
	console.log(`→ ${url}`);
	const resp = await page.goto(url, {
		waitUntil: "domcontentloaded",
		timeout: 20_000,
	});
	const status = resp?.status() ?? "?";
	// Give animations / fonts / web sockets a moment to settle. Convex's
	// websocket keeps `networkidle` from ever resolving, so we just wait
	// a fixed beat instead.
	await page.waitForLoadState("load").catch(() => {});
	await page.waitForTimeout(800);
	const out = resolve(OUTDIR, `${r.name}.png`);
	await page.screenshot({ path: out, fullPage });
	console.log(`   ${status} → ${out}`);
}

await browser.close();
console.log("done.");
