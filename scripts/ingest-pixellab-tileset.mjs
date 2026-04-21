#!/usr/bin/env node
// Pixellab tileset → tile_library ingest.
//
// Usage:
//   node scripts/ingest-pixellab-tileset.mjs <tileset-id> <b2-base-prefix> \
//     --style cozy-watercolor-pixel \
//     --layout "cottage:0-3,well:4-7,meadow:8-11,path:12-15" \
//     --kind-for "cottage=building,well=building,meadow=biome_tile,path=path" \
//     --subjects-for "cottage=village,cottage=cottage;well=village,well=stone;meadow=meadow,meadow=flowers;path=path,path=dirt"
//
// Simpler form — when each numbered prompt's layout follows 4-variant chunks:
//   node scripts/ingest-pixellab-tileset.mjs <tileset-id> <b2-base> \
//     --style <style> --subjects "cottage,well,meadow,path"
// and each subject gets 4 variants.

import { ConvexHttpClient } from "convex/browser";
import { api } from "../apps/play/convex/_generated/api.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

// Load .env for CONVEX_URL + session token.
function loadEnv() {
  const envPath = join(repoRoot, ".env");
  const envs = {};
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf-8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.+?)"?\s*$/);
      if (m) envs[m[1]] = m[2];
    }
  }
  return envs;
}
function loadCli() {
  const cfgPath = join(process.env.HOME ?? "", ".weaver-cli.json");
  if (!existsSync(cfgPath)) return {};
  return JSON.parse(readFileSync(cfgPath, "utf-8"));
}

const envs = loadEnv();
const cli = loadCli();

const CONVEX_URL =
  process.env.CONVEX_URL ??
  envs.PUBLIC_CONVEX_URL ??
  cli.convex_url;
if (!CONVEX_URL) {
  console.error("missing convex url — set PUBLIC_CONVEX_URL in .env or run `weaver login`");
  process.exit(2);
}
const SESSION_TOKEN = process.env.WEAVER_SESSION ?? cli.session_token;
if (!SESSION_TOKEN) {
  console.error("missing session token — run `weaver login <email>` first");
  process.exit(2);
}

const args = process.argv.slice(2);
const tilesetId = args[0];
const b2Base = args[1];
if (!tilesetId || !b2Base) {
  console.error("usage: ingest-pixellab-tileset <tileset-id> <b2-base-prefix> [--style S] [--subjects a,b,c,d] [--variants N] [--kind K] [--size 64]");
  process.exit(2);
}
const flag = (k, def) => {
  const idx = args.indexOf(`--${k}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : def;
};

const STYLE = flag("style", "cozy-watercolor-pixel");
const SUBJECTS = flag("subjects", "cottage,well,meadow,path").split(",").map((s) => s.trim());
const VARIANTS = Number(flag("variants", "4"));
const KIND_OVERRIDE = flag("kind", null); // if set, every tile uses this kind
const TILE_SIZE = Number(flag("size", "64"));

// Per-subject default kind mapping. Owner can override via --kind.
const KIND_BY_SUBJECT = {
  cottage: "building",
  inn: "building",
  tower: "building",
  tavern: "building",
  well: "building",
  bridge: "bridge",
  path: "path",
  corridor: "path",
  stair: "path",
  forest: "biome_tile",
  meadow: "biome_tile",
  village: "biome_tile",
  water: "biome_tile",
  mountain: "biome_tile",
  "office-corridor": "biome_tile",
  office: "biome_tile",
  desk: "map_object",
  tree: "map_object",
  rock: "map_object",
  stone: "map_object",
  lamp: "map_object",
};

const client = new ConvexHttpClient(CONVEX_URL);

async function ingestAll() {
  let idx = 0;
  const results = [];
  for (const subject of SUBJECTS) {
    const kind = KIND_OVERRIDE ?? KIND_BY_SUBJECT[subject] ?? "biome_tile";
    for (let v = 0; v < VARIANTS; v++, idx++) {
      const url = `${b2Base}/tile_${idx}.png`;
      process.stdout.write(`[${idx}/${SUBJECTS.length * VARIANTS}] ${subject} v${v + 1} ← ${url} ... `);
      try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buf = Buffer.from(await resp.arrayBuffer());
        const b64 = buf.toString("base64");
        const res = await client.action(api.tile_library.ingestPixellabAsset, {
          session_token: SESSION_TOKEN,
          kind,
          style_tag: STYLE,
          subject_tags: [subject, STYLE.split("-")[0]],
          name: `${subject} ${v + 1}`,
          png_base64: b64,
          width: TILE_SIZE,
          height: TILE_SIZE,
          view: "high top-down",
          pixellab_asset_id: `${tilesetId}:tile_${idx}`,
          pixellab_parent_id: tilesetId,
          generation: { source: "pixellab.create_tiles_pro", tile_index: idx },
        });
        console.log(res.deduped ? `deduped (${res.hash.slice(0, 8)})` : `ok (${res.hash.slice(0, 8)})`);
        results.push({ idx, subject, variant: v + 1, ...res });
      } catch (e) {
        console.log(`FAIL ${e.message}`);
        results.push({ idx, subject, variant: v + 1, error: String(e?.message ?? e) });
      }
    }
  }
  const ok = results.filter((r) => r.tile_id).length;
  const failed = results.filter((r) => r.error).length;
  const deduped = results.filter((r) => r.deduped).length;
  console.log(`\ningested ${ok} (${deduped} deduped); ${failed} failed`);
}

ingestAll().then(() => process.exit(0));
