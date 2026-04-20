#!/usr/bin/env node
// import-world.mjs — read a world directory (per backstory/IMPORT_CONTRACT.md),
// parse YAML frontmatter + markdown bodies, validate, and POST everything
// to Convex as one batch via import.importWorldBundle.
//
// Usage:
//   node scripts/import-world.mjs <world-dir> [--character <name>] [--rating family|teen|adult]
//
// A Convex session_token must be available — either via CONVEX_SESSION_TOKEN
// in the env, or by running `npx convex run '_dev:devSignInAs' '{"email":"..."}'`
// and piping the token in via WEAVER_SESSION_TOKEN.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import matter from "gray-matter";
import { ConvexHttpClient } from "convex/browser";
import "dotenv/config";

// ---------------------------------------------------------------
// CLI arg parsing (minimal, positional + a couple of flags)

const args = process.argv.slice(2);
if (args.length < 1 || args[0].startsWith("-")) {
	console.error(
		"usage: node scripts/import-world.mjs <world-dir> [--character <name>] [--rating family|teen|adult] [--world-slug <slug>]",
	);
	process.exit(2);
}
const worldDir = resolve(args[0]);
let characterName;
let contentRating;
let worldSlugOverride;
for (let i = 1; i < args.length; i++) {
	const flag = args[i];
	if (flag === "--character") characterName = args[++i];
	else if (flag === "--rating") contentRating = args[++i];
	else if (flag === "--world-slug") worldSlugOverride = args[++i];
}

if (!existsSync(worldDir)) {
	console.error(`world-dir not found: ${worldDir}`);
	process.exit(2);
}

const sessionToken =
	process.env.WEAVER_SESSION_TOKEN ?? process.env.CONVEX_SESSION_TOKEN;
if (!sessionToken) {
	console.error(
		"WEAVER_SESSION_TOKEN missing — run `npx convex run '_dev:devSignInAs' '{\"email\":\"you@example.com\"}'` and export WEAVER_SESSION_TOKEN=<token>",
	);
	process.exit(2);
}

const convexUrl = process.env.PUBLIC_CONVEX_URL;
if (!convexUrl) {
	console.error("PUBLIC_CONVEX_URL missing in .env");
	process.exit(2);
}

// ---------------------------------------------------------------
// Parsing

function readFrontmatterFile(path, bodyKey) {
	const raw = readFileSync(path, "utf-8");
	const parsed = matter(raw);
	return {
		...parsed.data,
		...(bodyKey ? { [bodyKey]: parsed.content.trim() } : {}),
	};
}

function listMarkdown(dir) {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".md"))
		.map((f) => ({ slug: basename(f, ".md"), path: join(dir, f) }));
}

// ---------------------------------------------------------------
// Validation (lightweight — full Zod validation would import from
// @weaver/engine/schemas but this script is a Node ESM consumer and
// the schemas are set up for Convex/SvelteKit. Minimal checks here;
// the Convex mutation does deeper shape validation via v.object).

function assertField(obj, field, path) {
	if (obj[field] === undefined || obj[field] === null || obj[field] === "") {
		throw new Error(`${path}: missing required field "${field}"`);
	}
}

const entities = [];
const issues = [];
const knownBiomes = new Set();
const knownLocations = new Set();
const knownCharacters = new Set();

// Bible
const biblePath = join(worldDir, "bible.md");
if (!existsSync(biblePath)) {
	console.error("bible.md missing");
	process.exit(1);
}
const bible = readFrontmatterFile(biblePath, "body");
assertField(bible, "name", "bible.md");
assertField(bible, "tagline", "bible.md");
assertField(bible, "tone", "bible.md");
entities.push({
	type: "bible",
	slug: "bible",
	payload: bible,
	author_pseudonym: bible.author_pseudonym,
});

// Biomes
for (const { slug, path } of listMarkdown(join(worldDir, "biomes"))) {
	const payload = readFrontmatterFile(path, "description");
	payload.slug = slug;
	assertField(payload, "name", `biomes/${slug}.md`);
	knownBiomes.add(slug);
	entities.push({ type: "biome", slug, payload });
}

// Characters
for (const { slug, path } of listMarkdown(join(worldDir, "characters"))) {
	const payload = readFrontmatterFile(path, "description");
	payload.slug = slug;
	assertField(payload, "name", `characters/${slug}.md`);
	payload.pseudonym = payload.pseudonym ?? payload.name;
	knownCharacters.add(slug);
	entities.push({
		type: "character",
		slug,
		payload,
		author_pseudonym: payload.author_pseudonym,
	});
}

// NPCs
const npcs = [];
for (const { slug, path } of listMarkdown(join(worldDir, "npcs"))) {
	const payload = readFrontmatterFile(path, "description");
	payload.slug = slug;
	assertField(payload, "name", `npcs/${slug}.md`);
	assertField(payload, "lives_at", `npcs/${slug}.md`);
	npcs.push(payload);
	entities.push({
		type: "npc",
		slug,
		payload,
		author_pseudonym: payload.author_pseudonym,
	});
}

// Locations
const locations = [];
for (const { slug, path } of listMarkdown(join(worldDir, "locations"))) {
	const payload = readFrontmatterFile(path, "description_template");
	payload.slug = slug;
	payload.type = "location";
	assertField(payload, "name", `locations/${slug}.md`);
	assertField(payload, "biome", `locations/${slug}.md`);
	payload.options = payload.options ?? [];
	payload.state_keys = payload.state_keys ?? [];
	payload.tags = payload.tags ?? [];
	payload.on_enter = payload.on_enter ?? [];
	payload.on_leave = payload.on_leave ?? [];
	payload.safe_anchor = payload.safe_anchor === true;
	locations.push(payload);
	knownLocations.add(slug);
	entities.push({
		type: "location",
		slug,
		payload,
		author_pseudonym: payload.author_pseudonym,
	});
}

// Cross-reference validation (after all entities read)
for (const loc of locations) {
	if (!knownBiomes.has(loc.biome)) {
		issues.push(`locations/${loc.slug}.md: biome "${loc.biome}" not found in biomes/`);
	}
	for (const dir of Object.keys(loc.neighbors ?? {})) {
		const target = loc.neighbors[dir];
		if (!knownLocations.has(target)) {
			issues.push(
				`locations/${loc.slug}.md: neighbor "${dir}: ${target}" points to unknown location`,
			);
		}
	}
}
for (const npc of npcs) {
	if (!knownLocations.has(npc.lives_at)) {
		issues.push(`npcs/${npc.slug}.md: lives_at "${npc.lives_at}" not found in locations/`);
	}
}
for (const char of entities.filter((e) => e.type === "character")) {
	for (const rel of char.payload.relationships ?? []) {
		if (rel.with && !knownCharacters.has(rel.with)) {
			issues.push(
				`characters/${char.slug}.md: relationship with "${rel.with}" — character not in this world (prune or keep as world-external)`,
			);
		}
	}
}
const safeAnchors = locations.filter((l) => l.safe_anchor === true);
if (safeAnchors.length === 0) {
	issues.push("no location has safe_anchor: true — at least one is required");
}

if (issues.length > 0) {
	console.error("import blocked — fix these:");
	for (const i of issues) console.error(" • " + i);
	process.exit(1);
}

// ---------------------------------------------------------------
// Derive import parameters

const worldSlug =
	worldSlugOverride ??
	(bible.slug ||
		bible.name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, ""));

const rating = contentRating ?? bible.content_rating ?? "family";
if (!["family", "teen", "adult"].includes(rating)) {
	console.error(`invalid content_rating "${rating}"`);
	process.exit(1);
}

const starterLoc = safeAnchors[0].slug;

// ---------------------------------------------------------------
// Send to Convex

const client = new ConvexHttpClient(convexUrl);

console.log(`Importing world "${bible.name}" as slug "${worldSlug}"`);
console.log(
	`  ${entities.filter((e) => e.type === "biome").length} biomes · ${entities.filter((e) => e.type === "character").length} characters · ${npcs.length} npcs · ${locations.length} locations`,
);
console.log(`  rating: ${rating} · starter: ${starterLoc}`);

try {
	const result = await client.mutation(
		(await import("../convex/_generated/api.js")).api.import.importWorldBundle,
		{
			session_token: sessionToken,
			world_name: bible.name,
			world_slug: worldSlug,
			content_rating: rating,
			entities: entities.map((e) => ({
				type: e.type,
				slug: e.slug,
				payload: e.payload,
				author_pseudonym: e.author_pseudonym,
			})),
			starter_location_slug: starterLoc,
			character_name: characterName,
		},
	);
	console.log(`✓ imported. world_id=${result.world_id}, ${result.entity_count} entities`);
	console.log(`  play at: ${process.env.PUBLIC_APP_URL ?? "http://localhost:5173"}/play/${result.slug}/${starterLoc}`);
} catch (e) {
	console.error("import failed:", e.message);
	process.exit(1);
}
