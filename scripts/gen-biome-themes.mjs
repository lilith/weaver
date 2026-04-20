#!/usr/bin/env node
// Generate biome-level theme palette overrides via Opus.
// Output: packages/engine/biomes/palettes.json
//
// Each palette overrides a small set of CSS variables from the
// midnight-loom base (apps/play/src/routes/layout.css) to give a
// distinct mood per biome. The location renderer injects the overrides
// as inline CSS scoped to the current location.

import Anthropic from "@anthropic-ai/sdk";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import "dotenv/config";

const BIOMES = [
	{ slug: "village", name: "Village", hint: "cozy stone cottages, chimney smoke, morning light" },
	{ slug: "forest", name: "Forest", hint: "dappled green, soft ferns, old growth" },
	{ slug: "urban-fantasy", name: "Urban Fantasy", hint: "rain-slicked neon streets with old magic bleeding through" },
	{ slug: "skyrise", name: "Skyrise", hint: "glass and chrome far above the clouds, lamp-gold city below" },
	{ slug: "city", name: "City", hint: "sodium streetlights, wet asphalt, distant sirens" },
	{ slug: "warehouse", name: "Warehouse", hint: "pale fluorescents, concrete, metal racks, something you shouldn't find" },
	{ slug: "dungeon", name: "Dungeon", hint: "damp stone, torch light, water dripping in the dark" },
	{ slug: "endless-abyss", name: "Endless Abyss", hint: "void the color of bruise, cold light from nowhere, no floor" },
	{ slug: "inn", name: "Inn", hint: "firelight on wood, the smell of bread and woodsmoke" }
];

const SYSTEM = `You design CSS palette overrides for biomes in a dark jewel-toned fantasy game.

Base palette (do not redefine — only override some):
- --color-ink-950 (bg darkest)  #0c0a18
- --color-ink-900                #141128
- --color-velvet-800 (cards)    #1f1a38
- --color-velvet-700             #2b244f
- --color-candle-300 (headings) #f9d57a
- --color-candle-400             #f3bb4a
- --color-candle-500             #e8a024
- --color-rose-400 (emphasis)   #ff86a3
- --color-rose-500               #f05080
- --color-teal-400 (hover/alive) #5ce0b5
- --color-mist-100 (body text)  #fdf7e8
- --color-mist-400 (muted text) #c6bbdb

Rules:
- Override 4-8 CSS vars per biome. Not all, just the ones that change the mood.
- Keep contrast legible: text vs background should remain comfortable.
- Shift HUE, not just luminance — each biome must be visually distinct at a glance.
- Hex only (#RRGGBB). No rgba.
- Output strict JSON — array of { slug, name, mood, overrides }. No commentary.
- "mood" is a single poetic line (≤80 chars) the UI can show to the player.`;

const USER = `Generate palettes for these biomes:
${BIOMES.map((b) => `- ${b.slug}: ${b.hint}`).join("\n")}

Return an array of ${BIOMES.length} objects in the order listed. JSON only.`;

async function main() {
	const key = process.env.ANTHROPIC_API_KEY;
	if (!key) {
		console.error("ANTHROPIC_API_KEY missing — expected in .env at repo root");
		process.exit(2);
	}
	const anthropic = new Anthropic({ apiKey: key });
	console.error(`Calling Opus 4.7 for ${BIOMES.length} biome palettes…`);
	const t0 = Date.now();
	const resp = await anthropic.messages.create({
		model: "claude-opus-4-7",
		max_tokens: 4096,
		system: SYSTEM,
		messages: [{ role: "user", content: USER }]
	});
	const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
	const text = resp.content
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("")
		.trim();
	const clean = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
	let parsed;
	try {
		parsed = JSON.parse(clean);
	} catch (e) {
		console.error("Opus output not JSON:", e.message);
		console.error(clean.slice(0, 500));
		process.exit(1);
	}
	if (!Array.isArray(parsed)) {
		console.error("Expected array, got:", typeof parsed);
		process.exit(1);
	}
	const out = { generated_at: new Date().toISOString(), model: "claude-opus-4-7", palettes: parsed };
	const path = "packages/engine/biomes/palettes.json";
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
	console.error(`Wrote ${path} (${parsed.length} palettes, ${elapsed}s)`);
	console.error(
		`Tokens: in=${resp.usage.input_tokens} out=${resp.usage.output_tokens} · cost ≈ $${(
			(resp.usage.input_tokens * 5 + resp.usage.output_tokens * 25) /
			1_000_000
		).toFixed(4)}`
	);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
