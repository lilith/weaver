#!/usr/bin/env node
// scripts/weaver.mjs — non-interactive CLI for driving Weaver from an LLM
// tool-call loop. One subcommand per invocation; output structured and
// predictable; --json everywhere for machine reads.
//
// Modes (auto-detected from world ownership on `world use`):
//   - author:  your own sandbox world; full rwx (weave, pick, clock, state, …)
//   - observer: someone else's world; read + narrow fix caps only
//                (look, where, entity show, cost, bible, fix)
//
// Session state persisted to ~/.weaver-cli.json — override with
// WEAVER_CLI_CONFIG=/path.
//
// Usage:
//   weaver login <email>                 sign in, cache session_token
//   weaver whoami                        show who/which world/which mode
//   weaver worlds                        list worlds you're a member of
//   weaver world use <slug>              set current world; detect mode
//   weaver world create <name> [flags]   create a sandbox world (author mode)
//   weaver world delete <slug>           delete owned world (author mode)
//   weaver world import <dir>            run importer (author mode)
//   weaver where                         compact: current loc + clock + stats
//   weaver look [--json]                 full location dump w/ hidden options
//   weaver go <loc_slug>                 teleport (author mode)
//   weaver pick <index|label>            apply option (author mode)
//   weaver weave "text"                  free-text expansion (author mode)
//   weaver wait                          take a no-op tick (author mode)
//   weaver clock                         show clock
//   weaver clock +<delta>                advance by e.g. 30m, 2h, 1d (author)
//   weaver clock set <dow> <hh:mm>       jump to next slot (author)
//   weaver state                         dump character state
//   weaver state set <path> <json>       author-mode: mutate state
//   weaver state inc <path> <n>          author-mode: numeric delta
//   weaver journey list                  list journeys for your character
//   weaver journey show <id>             full journey detail
//   weaver journey resolve <id> <slugs>  save selected drafts
//   weaver journey dismiss <id>          hide journey from journal
//   weaver entity list [--type T]        list entities
//   weaver entity show <type> <slug>     full payload
//   weaver entity versions <entity_id>   edit history
//   weaver bible [--full]                world bible (truncated by default)
//   weaver cost                          7-day cost summary
//   weaver fix <type> <slug> <field> <json>   non-destructive edit (member)
//   weaver help [command]
//
// Global flags: --json (machine output), --world <slug> (override current),
// --url <convex-url> (override PUBLIC_CONVEX_URL).

import { ConvexHttpClient } from "convex/browser";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { resolve, join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import matter from "gray-matter";
import "dotenv/config";

const HERE = dirname(fileURLToPath(import.meta.url));
const { api } = await import(resolve(HERE, "../convex/_generated/api.js"));

// Field naming rules per AUTHORING_AND_SYNC.md §"Per-type reference".
// For each entity type: which payload field becomes the markdown body,
// and which fields are purely runtime (never written to files).
const BODY_FIELD_BY_TYPE = {
  bible: null,
  biome: "description",
  character: "description",
  location: "description_template",
  npc: "description",
  item: "description",
};
const RUNTIME_OMIT_FIELDS = new Set([
  "created_at",
  "updated_at",
  "version",
  "schema_version",
  "author_user_id",
  "art_status",
  "chat_thread_id",
  "discovered_by",
  "_id",
]);
// Ref helper: "cli.getOwnership" -> api.cli.getOwnership. Keeps call
// sites readable while using typed FunctionReferences under the hood.
function ref(path) {
  return path.split(".").reduce((o, k) => o[k], api);
}

// ---------------------------------------------------------------
// Config + CLI argv

const CONFIG_PATH =
  process.env.WEAVER_CLI_CONFIG ?? join(homedir(), ".weaver-cli.json");

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}
function saveConfig(cfg) {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

const argv = process.argv.slice(2);
const flags = { json: false, help: false, world: null, url: null, full: false, limit: null, type: null, as: null };
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--json") flags.json = true;
  else if (a === "--help" || a === "-h") flags.help = true;
  else if (a === "--full") flags.full = true;
  else if (a === "--world") flags.world = argv[++i];
  else if (a === "--url") flags.url = argv[++i];
  else if (a === "--limit") flags.limit = parseInt(argv[++i], 10);
  else if (a === "--type") flags.type = argv[++i];
  else if (a === "--as") flags.as = argv[++i];
  else positional.push(a);
}

if (positional.length === 0 || flags.help && positional.length === 0) {
  usage();
  process.exit(positional.length === 0 ? 2 : 0);
}

const [cmd, ...rest] = positional;
let cfg = loadConfig();

// Ephemeral --as <email> sudo: impersonate via devSignInAs for this one
// invocation; do NOT touch the on-disk config. For owner-gated ops
// against worlds we don't own.
async function maybeImpersonate() {
  if (!flags.as) return;
  const url = flags.url ?? cfg.convex_url ?? process.env.PUBLIC_CONVEX_URL ?? process.env.CONVEX_URL;
  if (!url) err("PUBLIC_CONVEX_URL missing — required for --as", 2);
  const client = new ConvexHttpClient(url);
  const { session_token, user_id } = await client.action(ref("_dev.devSignInAs"), {
    email: flags.as,
  });
  cfg = {
    ...cfg,
    session_token,
    user_id,
    email: flags.as,
    convex_url: url,
    // Drop stale world context — caller must re-select if needed.
    world_slug: null,
    world_id: null,
    world_name: null,
    mode: null,
  };
}
await maybeImpersonate();

// ---------------------------------------------------------------
// Output helpers

function out(obj, textRender) {
  if (flags.json) {
    process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
    return;
  }
  if (typeof textRender === "function") {
    const txt = textRender(obj);
    if (txt !== null && txt !== undefined) process.stdout.write(txt + "\n");
    return;
  }
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}
function err(msg, code = 1) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(code);
}
function die(e, code = 1) {
  const m = e?.message ?? String(e);
  // Convex errors are wrapped in boilerplate. Pull out the useful bit:
  // prefer the last "Error: <msg>" line, strip request id + stack frames.
  let cleaned = m
    .replace(/^\[CONVEX[^\]]+\]\s*/g, "")
    .replace(/\s+Called by client$/, "");
  const errMatch = cleaned.match(/(?:Uncaught )?Error:\s*([^\n]+)/);
  if (errMatch) cleaned = errMatch[1];
  cleaned = cleaned
    .split("\n")
    .filter((l) => !/^\s*at\s/.test(l))
    .filter((l) => !/^\[Request ID:/.test(l))
    .join("\n")
    .trim();
  process.stderr.write(`error: ${cleaned}\n`);
  process.exit(code);
}

// ---------------------------------------------------------------
// Convex client

function getClient() {
  const url =
    flags.url ??
    cfg.convex_url ??
    process.env.PUBLIC_CONVEX_URL ??
    process.env.CONVEX_URL;
  if (!url) err("PUBLIC_CONVEX_URL missing — set it in .env or pass --url", 2);
  return new ConvexHttpClient(url);
}
function needSession() {
  if (!cfg.session_token) err("not logged in — run: weaver login <email>", 2);
}
function currentWorld() {
  const slug = flags.world ?? cfg.world_slug;
  if (!slug) err("no current world — run: weaver world use <slug>", 2);
  return slug;
}

// ---------------------------------------------------------------
// Dispatch

try {
  await dispatch();
} catch (e) {
  die(e);
}

async function dispatch() {
  switch (cmd) {
    case "help":
      return usage(rest[0]);
    case "login":
      return cmdLogin(rest);
    case "logout":
      return cmdLogout();
    case "whoami":
      return cmdWhoami();
    case "worlds":
      return cmdWorlds();
    case "world":
      return cmdWorld(rest);
    case "char":
      return cmdChar(rest);
    case "where":
      return cmdWhere();
    case "look":
      return cmdLook(rest);
    case "go":
      return cmdGo(rest);
    case "pick":
      return cmdPick(rest);
    case "weave":
      return cmdWeave(rest);
    case "wait":
      return cmdWait();
    case "clock":
      return cmdClock(rest);
    case "state":
      return cmdState(rest);
    case "journey":
      return cmdJourney(rest);
    case "entity":
      return cmdEntity(rest);
    case "bible":
      return cmdBible();
    case "cost":
      return cmdCost();
    case "fix":
      return cmdFix(rest);
    case "flag":
      return cmdFlag(rest);
    case "prefetch":
      return cmdPrefetch(rest);
    case "export":
      return cmdExport(rest);
    case "validate":
      return cmdValidate(rest);
    case "push":
      return cmdPush(rest);
    case "sync":
      return cmdSync(rest);
    case "memory":
      return cmdMemory(rest);
    case "flow":
      return cmdFlow(rest);
    case "art":
      return cmdArt(rest);
    default:
      err(`unknown command: ${cmd}. run: weaver help`);
  }
}

// ---------------------------------------------------------------
// Commands: session

async function cmdLogin([email]) {
  if (!email) err("usage: weaver login <email>", 2);
  const client = getClient();
  const { session_token, user_id } = await client.action(ref("_dev.devSignInAs"), {
    email,
  });
  const next = {
    ...cfg,
    session_token,
    user_id,
    email,
    convex_url: flags.url ?? cfg.convex_url ?? process.env.PUBLIC_CONVEX_URL,
  };
  saveConfig(next);
  out(
    { email, user_id, config_path: CONFIG_PATH },
    (o) => `logged in as ${o.email} (user_id=${o.user_id})`,
  );
}

function cmdLogout() {
  const next = { ...cfg };
  delete next.session_token;
  delete next.user_id;
  delete next.email;
  delete next.world_slug;
  delete next.world_id;
  delete next.mode;
  saveConfig(next);
  out({ ok: true }, () => "logged out");
}

async function cmdWhoami() {
  if (!cfg.session_token)
    return out({ logged_in: false }, () => "not logged in");
  const base = {
    logged_in: true,
    email: cfg.email,
    user_id: cfg.user_id,
    world_slug: cfg.world_slug ?? null,
    world_name: cfg.world_name ?? null,
    mode: cfg.mode ?? null,
    convex_url: cfg.convex_url,
  };
  out(
    base,
    (o) =>
      `email=${o.email}  user_id=${o.user_id}\n` +
      `world=${o.world_slug ?? "(none)"}  mode=${o.mode ?? "-"}\n` +
      `convex=${o.convex_url}`,
  );
}

// ---------------------------------------------------------------
// Commands: worlds

async function cmdWorlds() {
  needSession();
  const client = getClient();
  const worlds = await client.query(ref("worlds.listMine"), {
    session_token: cfg.session_token,
  });
  out(worlds, (ws) =>
    ws.length === 0
      ? "(no worlds)"
      : ws
          .map(
            (w) =>
              `${w.slug.padEnd(28)} ${w.role.padEnd(10)} ${w.name}  (${w.visited_count}/${w.location_count} visited)`,
          )
          .join("\n"),
  );
}

async function cmdWorld([sub, ...a]) {
  needSession();
  const client = getClient();
  if (sub === "use") {
    const [slug] = a;
    if (!slug) err("usage: weaver world use <slug>", 2);
    const own = await client.query(ref("cli.getOwnership"), {
      session_token: cfg.session_token,
      world_slug: slug,
    });
    const mode = own.is_owner ? "author" : "observer";
    saveConfig({
      ...cfg,
      world_slug: own.world_slug,
      world_id: own.world_id,
      world_name: own.world_name,
      mode,
    });
    out(
      { ...own, mode },
      (o) =>
        `using ${o.world_slug} (${o.world_name}) — mode=${mode}, role=${o.role}`,
    );
  } else if (sub === "create") {
    const [name, ...more] = a;
    if (!name) err("usage: weaver world create <name>", 2);
    const ratingIdx = more.indexOf("--rating");
    const suffixIdx = more.indexOf("--slug");
    const charIdx = more.indexOf("--character");
    const rating = ratingIdx >= 0 ? more[ratingIdx + 1] : undefined;
    const slug_suffix = suffixIdx >= 0 ? more[suffixIdx + 1] : undefined;
    const character_name = charIdx >= 0 ? more[charIdx + 1] : undefined;
    const r = await client.mutation(ref("cli.createSandboxWorld"), {
      session_token: cfg.session_token,
      name,
      slug_suffix,
      content_rating: rating,
      character_name,
    });
    // Auto-switch into it.
    saveConfig({
      ...cfg,
      world_slug: r.slug,
      world_id: r.world_id,
      world_name: name,
      mode: "author",
    });
    out(
      r,
      (o) => `created ${o.slug} (world_id=${o.world_id}) — now in author mode`,
    );
  } else if (sub === "delete") {
    const [slug, confirm] = a;
    if (!slug) err("usage: weaver world delete <slug> --yes", 2);
    if (confirm !== "--yes")
      err("destructive: append --yes to confirm", 2);
    // Use the existing _dev mutation. Requires convex admin token via npx
    // convex run OR the caller is owner. We call via `_dev:deleteWorld` as
    // an internalMutation, which has to be run via `npx convex run`.
    const r = spawnSync(
      "npx",
      [
        "convex",
        "run",
        "_dev:deleteWorld",
        JSON.stringify({ world_slug: slug, confirm: "yes-delete-please" }),
      ],
      { cwd: resolve(import.meta.dirname, ".."), encoding: "utf-8" },
    );
    if (r.status !== 0)
      err(`convex run failed: ${r.stderr || r.stdout}`, r.status ?? 1);
    // If this was the current world, clear it.
    if (cfg.world_slug === slug) {
      saveConfig({ ...cfg, world_slug: null, world_id: null, world_name: null, mode: null });
    }
    out({ deleted: slug, stdout: r.stdout.trim() }, (o) => `deleted ${o.deleted}\n${o.stdout}`);
  } else if (sub === "import") {
    const [dir, ...more] = a;
    if (!dir) err("usage: weaver world import <dir> [--character N] [--rating R]", 2);
    const importScript = resolve(import.meta.dirname, "import-world.mjs");
    const env = {
      ...process.env,
      WEAVER_SESSION_TOKEN: cfg.session_token,
      PUBLIC_CONVEX_URL: cfg.convex_url ?? process.env.PUBLIC_CONVEX_URL,
    };
    const r = spawnSync("node", [importScript, dir, ...more], {
      env,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (r.status !== 0)
      err(`import failed: ${r.stderr || r.stdout}`, r.status ?? 1);
    out(
      { ok: true, stdout: r.stdout.trim() },
      (o) => o.stdout,
    );
  } else {
    err("usage: weaver world use|create|delete|import ...", 2);
  }
}

// ---------------------------------------------------------------
// Commands: char

async function cmdChar([sub, ...a]) {
  needSession();
  const client = getClient();
  const world_slug = currentWorld();
  if (!sub || sub === "show") {
    const info = await client.query(ref("cli.whereAmI"), {
      session_token: cfg.session_token,
      world_slug,
    });
    out(
      info,
      (o) =>
        o.character
          ? `name=${o.character.name}  pseudonym=${o.character.pseudonym}\nat=${o.character.current_location_slug ?? "-"}\nstate=${JSON.stringify(o.character.state ?? {})}`
          : "(no character in this world for you)",
    );
  } else {
    err("usage: weaver char show", 2);
  }
}

// ---------------------------------------------------------------
// Commands: where / look / navigate / play

async function cmdWhere() {
  needSession();
  const client = getClient();
  const world_slug = currentWorld();
  const info = await client.query(ref("cli.whereAmI"), {
    session_token: cfg.session_token,
    world_slug,
  });
  out(info, renderWhere);
}

function renderWhere(info) {
  const t = info.branch?.state?.time;
  const tstr = t
    ? `${t.day_of_week} ${t.hhmm}  (day ${t.day_counter}, week ${t.week_counter})`
    : "-";
  const ch = info.character;
  const stateStr = ch?.state
    ? Object.entries(ch.state)
        .filter(([k]) => k !== "this")
        .map(([k, v]) => `${k}=${summarizeValue(v)}`)
        .join(" ")
    : "-";
  return [
    `world=${info.world.slug}  ${info.is_owner ? "[author]" : "[observer]"}`,
    `loc=${ch?.current_location_slug ?? "-"}  turn=${info.branch?.state?.turn ?? 0}  time=${tstr}`,
    `char=${ch?.name ?? "-"}  ${stateStr}`,
  ].join("\n");
}

function summarizeValue(v) {
  if (Array.isArray(v)) return `[${v.length}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).length}}`;
  return JSON.stringify(v);
}

async function cmdLook([maybeSlug]) {
  needSession();
  const client = getClient();
  const world_slug = currentWorld();
  // Determine current loc if not provided.
  let loc_slug = maybeSlug;
  if (!loc_slug) {
    const info = await client.query(ref("cli.whereAmI"), {
      session_token: cfg.session_token,
      world_slug,
    });
    loc_slug = info.character?.current_location_slug;
    if (!loc_slug) err("character has no current location", 1);
  }
  const dump = await client.query(ref("cli.dumpLocation"), {
    session_token: cfg.session_token,
    world_slug,
    loc_slug,
  });
  if (!dump) err(`location not found: ${loc_slug}`, 3);
  out(dump, renderLook);
}

function renderLook(d) {
  const lines = [];
  lines.push(
    `[${d.slug}]  ${d.name ?? ""}  ${d.draft ? "(DRAFT)" : ""}`.trim(),
  );
  lines.push(`biome=${d.biome ?? "-"}  tags=${(d.tags ?? []).join(",") || "-"}  author=${d.author_pseudonym ?? "-"}`);
  if (d.prose) lines.push(`\n${d.prose}`);
  else if (d.description_template)
    lines.push(`\n${d.description_template}`);
  lines.push("");
  lines.push("options:");
  for (const o of d.options) {
    const mark = o.visible ? " " : "x";
    const tag = o.target ? ` → ${o.target}` : "";
    const cond = o.condition ? `   if: ${o.condition}` : "";
    lines.push(`  [${mark}] ${o.index}. ${o.label}${tag}${cond}`);
  }
  const t = d.world_state?.time;
  if (t)
    lines.push(
      `\nworld: ${t.day_of_week} ${t.hhmm}  day ${t.day_counter}`,
    );
  return lines.join("\n");
}

async function cmdGo([slug]) {
  needSession();
  if (!slug) err("usage: weaver go <loc_slug>", 2);
  if (cfg.mode !== "author")
    err("observer mode: go is author-only. weaver world use <your-slug>", 2);
  const client = getClient();
  const r = await client.mutation(ref("cli.teleportCharacter"), {
    session_token: cfg.session_token,
    world_slug: currentWorld(),
    loc_slug: slug,
  });
  out(r, (o) => `teleported to ${o.loc_slug}`);
}

async function cmdPick([arg]) {
  needSession();
  if (!arg) err("usage: weaver pick <index|label-substring>", 2);
  if (cfg.mode !== "author")
    err("observer mode: pick is author-only", 2);
  const client = getClient();
  const world_slug = currentWorld();
  const info = await client.query(ref("cli.whereAmI"), {
    session_token: cfg.session_token,
    world_slug,
  });
  const loc_slug = info.character?.current_location_slug;
  if (!loc_slug) err("character has no current location", 1);
  const dump = await client.query(ref("cli.dumpLocation"), {
    session_token: cfg.session_token,
    world_slug,
    loc_slug,
  });
  // Resolve the arg: number = original index; else substring match on visible options.
  let optionIndex = null;
  const asInt = parseInt(arg, 10);
  if (!isNaN(asInt) && String(asInt) === arg) {
    optionIndex = asInt;
  } else {
    const match = dump.options.find(
      (o) => o.visible && o.label.toLowerCase().includes(arg.toLowerCase()),
    );
    if (!match) err(`no visible option matches: ${arg}`, 1);
    optionIndex = match.index;
  }
  const r = await client.mutation(ref("locations.applyOption"), {
    session_token: cfg.session_token,
    world_id: cfg.world_id,
    location_slug: loc_slug,
    option_index: optionIndex,
  });
  // If needs_expansion: auto-chain.
  if (r.needs_expansion) {
    const ex = await client.action(ref("expansion.expandFromFreeText"), {
      session_token: cfg.session_token,
      world_id: cfg.world_id,
      location_slug: loc_slug,
      input: r.needs_expansion.hint,
    });
    r.expansion = ex;
  }
  out(
    r,
    (o) =>
      `${(o.says ?? []).map((s) => `  "${s}"`).join("\n") || "  (no dialogue)"}\n` +
      `→ ${o.new_location_slug ?? "(same location)"}${o.needs_expansion ? "  [expanded]" : ""}${o.closed_journey_id ? `  [journey ${o.closed_journey_id} closed]` : ""}`,
  );
}

async function cmdWeave([text]) {
  needSession();
  if (!text) err('usage: weaver weave "free text"', 2);
  if (cfg.mode !== "author")
    err("observer mode: weave is author-only", 2);
  const client = getClient();
  const world_slug = currentWorld();
  const info = await client.query(ref("cli.whereAmI"), {
    session_token: cfg.session_token,
    world_slug,
  });
  const loc_slug = info.character?.current_location_slug;
  if (!loc_slug) err("character has no current location", 1);
  const r = await client.action(ref("expansion.expandFromFreeText"), {
    session_token: cfg.session_token,
    world_id: cfg.world_id,
    location_slug: loc_slug,
    input: text,
  });
  out(r, (o) => {
    if (o.kind === "goto") return `wove → ${o.new_location_slug}`;
    if (o.kind === "narrate") return `"${o.text}"`;
    return JSON.stringify(o);
  });
}

async function cmdWait() {
  needSession();
  if (cfg.mode !== "author") err("observer mode: wait is author-only", 2);
  // Advance the clock by one tick's worth of minutes without triggering
  // an option. Preferred path: a real "wait" option in the location if
  // one exists (UX-03); fallback: fastForwardClock by tick_minutes.
  const client = getClient();
  const world_slug = currentWorld();
  const info = await client.query(ref("cli.whereAmI"), {
    session_token: cfg.session_token,
    world_slug,
  });
  const tick = info.branch?.state?.time?.tick_minutes ?? 1;
  const r = await client.mutation(ref("cli.fastForwardClock"), {
    session_token: cfg.session_token,
    world_slug,
    delta_minutes: tick,
    tick_turn_counter: true,
  });
  out(r, (o) => `waited ${o.minutes_added}m → ${o.time.day_of_week} ${o.time.hhmm}`);
}

// ---------------------------------------------------------------
// Commands: clock

async function cmdClock([sub, ...a]) {
  needSession();
  const client = getClient();
  const world_slug = currentWorld();
  if (!sub) {
    const info = await client.query(ref("cli.whereAmI"), {
      session_token: cfg.session_token,
      world_slug,
    });
    const t = info.branch?.state?.time;
    return out(t ?? {}, () =>
      t ? `${t.day_of_week} ${t.hhmm}  day ${t.day_counter}  week ${t.week_counter}  tick=${t.tick_minutes}m` : "(no clock)",
    );
  }
  if (cfg.mode !== "author") err("observer mode: clock mutation is author-only", 2);
  if (sub.startsWith("+")) {
    const delta_minutes = parseDuration(sub.slice(1));
    const r = await client.mutation(ref("cli.fastForwardClock"), {
      session_token: cfg.session_token,
      world_slug,
      delta_minutes,
    });
    return out(r, (o) => `clock +${o.minutes_added}m → ${o.time.day_of_week} ${o.time.hhmm}`);
  }
  if (sub === "set") {
    const [dow, hhmm] = a;
    if (!dow || !hhmm) err("usage: weaver clock set <dow> <hh:mm>", 2);
    const r = await client.mutation(ref("cli.fastForwardClock"), {
      session_token: cfg.session_token,
      world_slug,
      to_day_of_week: dow,
      to_hhmm: hhmm,
    });
    return out(r, (o) => `clock → ${o.time.day_of_week} ${o.time.hhmm} (+${o.minutes_added}m)`);
  }
  err("usage: weaver clock [+<delta>|set <dow> <hh:mm>]", 2);
}

function parseDuration(s) {
  const m = /^(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|days?)?$/i.exec(s.trim());
  if (!m) err(`bad duration: ${s} (try 30m, 2h, 1d)`, 2);
  const n = parseInt(m[1], 10);
  const unit = (m[2] ?? "m").toLowerCase();
  if (unit.startsWith("s")) return Math.max(1, Math.round(n / 60));
  if (unit.startsWith("h")) return n * 60;
  if (unit.startsWith("d")) return n * 24 * 60;
  return n;
}

// ---------------------------------------------------------------
// Commands: state

async function cmdState([sub, ...a]) {
  needSession();
  const client = getClient();
  const world_slug = currentWorld();
  if (!sub) {
    const info = await client.query(ref("cli.whereAmI"), {
      session_token: cfg.session_token,
      world_slug,
    });
    return out(info.character?.state ?? {}, (s) => JSON.stringify(s, null, 2));
  }
  if (cfg.mode !== "author") err("observer mode: state mutation is author-only", 2);
  if (sub === "set") {
    const [path, ...valParts] = a;
    if (!path || valParts.length === 0)
      err("usage: weaver state set <path> <json-value>", 2);
    const value_json = valParts.join(" ");
    const r = await client.mutation(ref("cli.setCharacterState"), {
      session_token: cfg.session_token,
      world_slug,
      path,
      value_json,
    });
    return out(r, (o) => `set ${o.path} = ${JSON.stringify(o.value)}`);
  }
  if (sub === "inc") {
    const [path, byStr] = a;
    if (!path || !byStr) err("usage: weaver state inc <path> <n>", 2);
    // Read current, compute, write.
    const info = await client.query(ref("cli.whereAmI"), {
      session_token: cfg.session_token,
      world_slug,
    });
    const cur = getDeep(info.character?.state ?? {}, path);
    const n = Number(cur ?? 0) + Number(byStr);
    const r = await client.mutation(ref("cli.setCharacterState"), {
      session_token: cfg.session_token,
      world_slug,
      path,
      value_json: JSON.stringify(n),
    });
    return out(r, (o) => `${o.path}: ${cur ?? 0} → ${o.value}`);
  }
  err("usage: weaver state [set <path> <json>|inc <path> <n>]", 2);
}

function getDeep(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
}

// ---------------------------------------------------------------
// Commands: journey

async function cmdJourney([sub, ...a]) {
  needSession();
  const client = getClient();
  const world_slug = currentWorld();
  if (!sub || sub === "list") {
    const rows = await client.query(ref("journeys.listMineInWorld"), {
      session_token: cfg.session_token,
      world_id: cfg.world_id,
    });
    return out(rows, (rs) =>
      rs.length === 0
        ? "(no journeys)"
        : rs
            .map(
              (j) =>
                `${j._id}  ${j.status.padEnd(10)}  ${j.entity_slugs.length} drafts  ${j.summary ?? ""}`,
            )
            .join("\n"),
    );
  }
  if (sub === "show") {
    const [id] = a;
    if (!id) err("usage: weaver journey show <id>", 2);
    const j = await client.query(ref("journeys.getJourney"), {
      session_token: cfg.session_token,
      journey_id: id,
    });
    return out(j);
  }
  if (sub === "resolve") {
    if (cfg.mode !== "author") err("observer mode: resolve is author-only", 2);
    const [id, slugs] = a;
    if (!id || !slugs)
      err("usage: weaver journey resolve <id> slug1,slug2,...", 2);
    const keep = slugs
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const r = await client.mutation(ref("journeys.resolveJourney"), {
      session_token: cfg.session_token,
      journey_id: id,
      keep_slugs: keep,
    });
    return out(r, (o) => `saved=${o.saved}  skipped=${o.skipped}`);
  }
  if (sub === "dismiss") {
    if (cfg.mode !== "author") err("observer mode: dismiss is author-only", 2);
    const [id] = a;
    if (!id) err("usage: weaver journey dismiss <id>", 2);
    const r = await client.mutation(ref("journeys.dismissJourney"), {
      session_token: cfg.session_token,
      journey_id: id,
    });
    return out(r, () => "dismissed");
  }
  err("usage: weaver journey list|show|resolve|dismiss ...", 2);
}

// ---------------------------------------------------------------
// Commands: entity

async function cmdEntity([sub, ...a]) {
  needSession();
  const client = getClient();
  const world_slug = currentWorld();
  if (!sub || sub === "list") {
    const rows = await client.query(ref("cli.listEntities"), {
      session_token: cfg.session_token,
      world_slug,
      type: flags.type ?? undefined,
      limit: flags.limit ?? undefined,
    });
    return out(rows, (rs) =>
      rs.length === 0
        ? "(no entities)"
        : rs
            .map(
              (e) =>
                `${e.type.padEnd(10)} ${e.slug.padEnd(32)} v${e.version}${e.draft ? " (draft)" : ""}${e.art_status ? ` [art:${e.art_status}]` : ""}`,
            )
            .join("\n"),
    );
  }
  if (sub === "show") {
    const [type, slug] = a;
    if (!type || !slug) err("usage: weaver entity show <type> <slug>", 2);
    const e = await client.query(ref("cli.getEntity"), {
      session_token: cfg.session_token,
      world_slug,
      type,
      slug,
    });
    if (!e) err(`entity not found: ${type}/${slug}`, 3);
    return out(e, (o) => JSON.stringify(o.payload, null, 2));
  }
  if (sub === "versions") {
    const [entity_id] = a;
    if (!entity_id) err("usage: weaver entity versions <entity_id>", 2);
    const rows = await client.query(ref("cli.listVersions"), {
      session_token: cfg.session_token,
      world_slug,
      entity_id,
    });
    if (!rows) err("entity not found or wrong world", 3);
    return out(rows, (rs) =>
      rs
        .map(
          (v) =>
            `v${v.version}  ${v.edit_kind.padEnd(20)}  ${v.author_pseudonym ?? "-"}  ${v.reason ?? ""}`,
        )
        .join("\n"),
    );
  }
  err("usage: weaver entity list|show|versions ...", 2);
}

// ---------------------------------------------------------------
// Commands: bible, cost, fix

async function cmdBible() {
  needSession();
  const client = getClient();
  const world_slug = currentWorld();
  const bible = await client.query(ref("worlds.getBible"), {
    session_token: cfg.session_token,
    world_id: cfg.world_id,
  });
  if (!bible) err("world has no bible yet", 3);
  if (flags.json || flags.full) return out(bible);
  // Truncate for plain-text output.
  const str = JSON.stringify(bible, null, 2);
  const truncated = str.length > 2500 ? str.slice(0, 2500) + "\n... (truncated; --full to see all)" : str;
  process.stdout.write(truncated + "\n");
}

async function cmdCost() {
  needSession();
  const client = getClient();
  const world_slug = currentWorld();
  const s = await client.query(ref("cli.getCostSummary"), {
    session_token: cfg.session_token,
    world_slug,
  });
  out(s, (o) => {
    const lines = [`total=$${o.total_usd.toFixed(4)}  events=${o.count}  (last 7d)`];
    for (const [k, v] of Object.entries(o.by_kind)) {
      lines.push(`  ${k.padEnd(20)} ${v.count.toString().padStart(4)}  $${v.usd.toFixed(4)}`);
    }
    return lines.join("\n");
  });
}

async function cmdFix([type, slug, field, ...valParts]) {
  needSession();
  if (!type || !slug || !field || valParts.length === 0)
    err('usage: weaver fix <type> <slug> <field> <json-value> [--reason "..."]', 2);
  const reasonIdx = valParts.indexOf("--reason");
  let reason;
  if (reasonIdx >= 0) {
    reason = valParts[reasonIdx + 1];
    valParts = [...valParts.slice(0, reasonIdx), ...valParts.slice(reasonIdx + 2)];
  }
  const new_value_json = valParts.join(" ");
  const client = getClient();
  const r = await client.mutation(ref("cli.fixEntityField"), {
    session_token: cfg.session_token,
    world_slug: currentWorld(),
    type,
    slug,
    field,
    new_value_json,
    reason,
  });
  out(
    r,
    (o) =>
      `fixed ${type}/${slug}.${o.field}  v${o.previous_version} → v${o.new_version}`,
  );
}

// ---------------------------------------------------------------
// Commands: flag

async function cmdFlag([sub, ...a]) {
  needSession();
  const client = getClient();
  if (!sub || sub === "list") {
    const { rows, defaults } = await client.query(ref("flags.listAll"), {
      session_token: cfg.session_token,
    });
    const byKey = new Map();
    for (const r of rows) {
      if (!byKey.has(r.flag_key)) byKey.set(r.flag_key, []);
      byKey.get(r.flag_key).push(r);
    }
    const allKeys = new Set([...Object.keys(defaults), ...byKey.keys()]);
    const listing = [...allKeys].sort().map((k) => ({
      flag_key: k,
      default: defaults[k] ?? false,
      overrides: byKey.get(k) ?? [],
    }));
    return out(listing, (ls) =>
      ls
        .map((l) => {
          const base = `${l.flag_key.padEnd(36)} default=${l.default ? "on" : "off"}`;
          if (l.overrides.length === 0) return base;
          const extra = l.overrides
            .map((o) => `\n    ${o.scope_kind}${o.scope_id ? `:${o.scope_id}` : ""} = ${o.enabled ? "on" : "off"}`)
            .join("");
          return base + extra;
        })
        .join("\n"),
    );
  }
  if (sub === "resolve") {
    const [key] = a;
    if (!key) err("usage: weaver flag resolve <key> [--world slug]", 2);
    const r = await client.query(ref("flags.resolve"), {
      session_token: cfg.session_token,
      flag_key: key,
      world_slug: flags.world ?? cfg.world_slug ?? undefined,
    });
    return out(r, (o) => `${o.flag_key} = ${o.enabled ? "on" : "off"} (default=${o.default})`);
  }
  if (sub === "set" || sub === "unset") {
    const [key, ...more] = a;
    if (!key) err(`usage: weaver flag ${sub} <key> [--scope world|user|character|global] [--id X] [on|off]`, 2);
    const scopeIdx = more.indexOf("--scope");
    const idIdx = more.indexOf("--id");
    const scope_kind = scopeIdx >= 0 ? more[scopeIdx + 1] : "global";
    let scope_id = idIdx >= 0 ? more[idIdx + 1] : undefined;
    // If scope=world and no explicit id, use the current world's slug.
    if (scope_kind === "world" && !scope_id) scope_id = cfg.world_slug;
    if (scope_kind === "user" && !scope_id) scope_id = cfg.user_id;
    if (sub === "set") {
      const val = more.find((m) => m === "on" || m === "off");
      if (!val) err("specify on|off at end", 2);
      const r = await client.mutation(ref("flags.set"), {
        session_token: cfg.session_token,
        flag_key: key,
        scope_kind,
        scope_id,
        enabled: val === "on",
      });
      return out(r, (o) => `${o.created ? "created" : "updated"} ${key} @ ${scope_kind}${scope_id ? `:${scope_id}` : ""} = ${val}`);
    } else {
      const r = await client.mutation(ref("flags.unset"), {
        session_token: cfg.session_token,
        flag_key: key,
        scope_kind,
        scope_id,
      });
      return out(r, (o) => `unset ${key} @ ${scope_kind}${scope_id ? `:${scope_id}` : ""} (deleted ${o.deleted})`);
    }
  }
  err("usage: weaver flag [list|resolve|set|unset] ...", 2);
}

// ---------------------------------------------------------------
// Commands: prefetch

async function cmdPrefetch([sub]) {
  needSession();
  if (cfg.mode !== "author")
    err("observer mode: prefetch is author-only (it triggers Opus calls)", 2);
  const client = getClient();
  const world_slug = currentWorld();
  const info = await client.query(ref("cli.whereAmI"), {
    session_token: cfg.session_token,
    world_slug,
  });
  const loc_slug = info.character?.current_location_slug;
  if (!loc_slug) err("character has no current location", 1);
  const r = await client.action(ref("expansion.ensurePrefetched"), {
    session_token: cfg.session_token,
    world_id: cfg.world_id,
    location_slug: loc_slug,
  });
  out(
    r,
    (o) =>
      `flag=${o.flag ? "on" : "off"}\n` +
      o.options
        .map(
          (x) =>
            `  [${x.option_index}] ${x.option_label.padEnd(36)} ${x.status}${x.prefetched_slug ? ` (→ ${x.prefetched_slug})` : ""}`,
        )
        .join("\n"),
  );
}

// ---------------------------------------------------------------
// Commands: export / validate (two-way content sync per spec AUTHORING_AND_SYNC)

function splitBody(type, payload) {
  const bodyField = BODY_FIELD_BY_TYPE[type];
  const frontmatter = {};
  let body = "";
  for (const [k, v] of Object.entries(payload ?? {})) {
    if (RUNTIME_OMIT_FIELDS.has(k)) continue;
    if (bodyField && k === bodyField) {
      body = typeof v === "string" ? v : JSON.stringify(v, null, 2);
    } else {
      frontmatter[k] = v;
    }
  }
  return { frontmatter, body };
}

function yamlDump(o) {
  // Minimal YAML writer — good enough for the shapes Weaver emits (strings,
  // numbers, booleans, arrays, nested objects). Uses JSON-compatible quoting.
  const lines = [];
  const emit = (val, indent) => {
    if (val === null || val === undefined) return "null";
    if (typeof val === "boolean" || typeof val === "number") return String(val);
    if (typeof val === "string") {
      // Quote any string that isn't a clean plain-scalar. YAML reserved
      // chars at the start (! & * @ | > % ? -) need quoting; so do
      // strings containing colons, #, quotes, leading/trailing ws, or
      // control chars. Safest: JSON-quote anything that isn't a pure
      // alphanum/underscore/dash/period/space word.
      if (val === "") return '""';
      if (/[\n\r\t"'#&*!@|>%?]/.test(val)) return JSON.stringify(val);
      if (/:/.test(val)) return JSON.stringify(val);
      if (val !== val.trim()) return JSON.stringify(val);
      if (/^[\-\[\]{},&*!|>]/.test(val)) return JSON.stringify(val);
      // yes/no/true/false/null unquoted would be booleans/null in YAML
      if (/^(yes|no|true|false|null|~|on|off)$/i.test(val))
        return JSON.stringify(val);
      return val;
    }
    if (Array.isArray(val)) {
      if (val.length === 0) return "[]";
      return (
        "\n" +
        val
          .map((x) => {
            const sub = emit(x, indent + 2);
            if (sub.startsWith("\n")) return `${" ".repeat(indent)}-${sub}`;
            return `${" ".repeat(indent)}- ${sub}`;
          })
          .join("\n")
      );
    }
    if (typeof val === "object") {
      if (Object.keys(val).length === 0) return "{}";
      return (
        "\n" +
        Object.entries(val)
          .map(([k, v]) => {
            const sub = emit(v, indent + 2);
            if (sub.startsWith("\n"))
              return `${" ".repeat(indent)}${k}:${sub}`;
            return `${" ".repeat(indent)}${k}: ${sub}`;
          })
          .join("\n")
      );
    }
    return JSON.stringify(val);
  };
  for (const [k, v] of Object.entries(o)) {
    const sub = emit(v, 2);
    if (sub.startsWith("\n")) lines.push(`${k}:${sub}`);
    else lines.push(`${k}: ${sub}`);
  }
  return lines.join("\n");
}

async function cmdExport([slug, dir]) {
  needSession();
  if (!slug || !dir)
    err("usage: weaver export <world_slug> <dir>", 2);
  const client = getClient();
  const dump = await client.query(ref("cli.exportWorld"), {
    session_token: cfg.session_token,
    world_slug: slug,
  });
  if (!dump) err(`world not found or empty: ${slug}`, 3);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, ".weaver-sync"), { recursive: true });
  writeFileSync(
    join(dir, ".weaver-sync", "world.json"),
    JSON.stringify(
      { world: dump.world, exported_at: dump.exported_at },
      null,
      2,
    ),
  );
  const map = {};
  let wrote = 0;
  for (const e of dump.entities) {
    // Skip draft entities — they're prefetch ephemera or in-flight journeys.
    if (e.draft) continue;
    map[`${e.type}/${e.slug}`] = e.id;
    if (e.type === "bible") {
      // bible.md at root
      const { frontmatter, body } = splitBody("bible", e.payload);
      writeEntity(join(dir, "bible.md"), frontmatter, body, e.author_pseudonym);
      wrote++;
      continue;
    }
    const subdir = typeSubdir(e.type);
    if (!subdir) {
      writeFileSync(
        join(dir, `${e.type}-${e.slug}.json`),
        JSON.stringify(e.payload, null, 2),
      );
      wrote++;
      continue;
    }
    mkdirSync(join(dir, subdir), { recursive: true });
    const { frontmatter, body } = splitBody(e.type, e.payload);
    writeEntity(
      join(dir, subdir, `${e.slug}.md`),
      frontmatter,
      body,
      e.author_pseudonym,
    );
    wrote++;
  }
  writeFileSync(
    join(dir, ".weaver-sync", "map.json"),
    JSON.stringify(map, null, 2),
  );
  out(
    { world: dump.world.slug, dir, files_written: wrote },
    (o) => `exported ${o.files_written} files to ${o.dir}`,
  );
}

function typeSubdir(type) {
  return {
    biome: "biomes",
    character: "characters",
    location: "locations",
    npc: "npcs",
    item: "items",
  }[type] ?? null;
}

function writeEntity(path, frontmatter, body, author_pseudonym) {
  const fm = { ...frontmatter };
  if (author_pseudonym && !fm.author_pseudonym)
    fm.author_pseudonym = author_pseudonym;
  const yaml = yamlDump(fm);
  const content = `---\n${yaml}\n---\n\n${body}\n`;
  writeFileSync(path, content);
}

async function cmdValidate([dir]) {
  if (!dir) err("usage: weaver validate <dir>", 2);
  if (!existsSync(dir)) err(`dir not found: ${dir}`, 3);
  const issues = [];
  const counts = {};
  const known = { biome: new Set(), location: new Set(), character: new Set(), npc: new Set(), item: new Set() };

  const biblePath = join(dir, "bible.md");
  if (!existsSync(biblePath)) {
    issues.push("missing bible.md");
  } else {
    const b = parseEntityFile(biblePath);
    for (const field of ["name", "tagline", "tone"]) {
      if (b.frontmatter[field] === undefined)
        issues.push(`bible.md: missing field "${field}"`);
    }
    counts.bible = 1;
  }
  for (const [type, subdir] of Object.entries({
    biome: "biomes",
    character: "characters",
    npc: "npcs",
    location: "locations",
    item: "items",
  })) {
    const fullSub = join(dir, subdir);
    if (!existsSync(fullSub)) continue;
    const files = readdirSync(fullSub).filter((f) => f.endsWith(".md"));
    counts[type] = files.length;
    for (const f of files) {
      const slug = basename(f, ".md");
      known[type].add(slug);
      const parsed = parseEntityFile(join(fullSub, f));
      if (type === "location") {
        if (!parsed.frontmatter.biome)
          issues.push(`locations/${f}: missing biome`);
        for (const [dir2, target] of Object.entries(
          parsed.frontmatter.neighbors ?? {},
        )) {
          // defer cross-ref check to next pass
        }
      }
    }
  }
  // Cross-reference pass.
  for (const f of known.location) {
    const p = parseEntityFile(join(dir, "locations", f + ".md"));
    const biome = p.frontmatter.biome;
    if (biome && !known.biome.has(biome))
      issues.push(`locations/${f}.md: biome "${biome}" has no biomes/${biome}.md`);
    for (const [dir2, target] of Object.entries(p.frontmatter.neighbors ?? {})) {
      if (!known.location.has(target))
        issues.push(
          `locations/${f}.md: neighbor "${dir2}: ${target}" points to unknown location`,
        );
    }
    for (const opt of p.frontmatter.options ?? []) {
      if (opt.target && !known.location.has(opt.target) && !opt.target.startsWith("#")) {
        // allow unknown target — importer creates stub. Surface as warning.
        issues.push(
          `locations/${f}.md option "${opt.label}" target "${opt.target}" unknown (stub will be created on import)`,
        );
      }
    }
  }
  for (const f of known.npc) {
    const p = parseEntityFile(join(dir, "npcs", f + ".md"));
    const at = p.frontmatter.lives_at;
    if (at && !known.location.has(at))
      issues.push(`npcs/${f}.md: lives_at "${at}" unknown`);
  }
  const ok = issues.length === 0;
  out(
    { ok, counts, issues },
    (o) =>
      `${ok ? "OK" : "ISSUES"}\n` +
      `counts: ${JSON.stringify(o.counts)}\n` +
      (o.issues.length ? o.issues.map((i) => `  - ${i}`).join("\n") : "  (none)"),
  );
  if (!ok) process.exit(1);
}

function parseEntityFile(path) {
  const raw = readFileSync(path, "utf-8");
  const parsed = matter(raw);
  return { frontmatter: parsed.data, body: parsed.content.trim() };
}

// Reconstruct payload by merging frontmatter + body (where body is the
// spec-designated field for that entity type).
function payloadFromEntityFile(type, path) {
  const { frontmatter, body } = parseEntityFile(path);
  const payload = { ...frontmatter };
  const bodyField = BODY_FIELD_BY_TYPE[type];
  if (bodyField && body) payload[bodyField] = body;
  // Stamp the canonical type + slug for safety — file basename is slug.
  if (!payload.type) payload.type = type;
  if (!payload.slug)
    payload.slug = basename(path, ".md");
  return payload;
}

async function cmdPush([type, slug, filePath, ...more]) {
  needSession();
  if (!type || !slug || !filePath)
    err('usage: weaver push <type> <slug> <file.md> [--reason "..."]', 2);
  if (cfg.mode !== "author" && !flags.as)
    err("observer mode: push is author-only (or use --as <owner-email>)", 2);
  if (!existsSync(filePath)) err(`file not found: ${filePath}`, 3);
  const reasonIdx = more.indexOf("--reason");
  const reason = reasonIdx >= 0 ? more[reasonIdx + 1] : undefined;
  const payload = payloadFromEntityFile(type, filePath);
  const client = getClient();
  const r = await client.mutation(ref("cli.pushEntityPayload"), {
    session_token: cfg.session_token,
    world_slug: currentWorld(),
    type,
    slug,
    payload_json: JSON.stringify(payload),
    reason,
  });
  out(
    r,
    (o) =>
      o.created
        ? `created ${type}/${slug} (v1)`
        : `${type}/${slug}  v${o.previous_version} → v${o.version}`,
  );
}

/** `weaver sync <dir>` — push every file under <dir> into the current
 *  world. Walks biomes/ characters/ npcs/ locations/ items/ bible.md.
 *  Idempotent; creates new versions for each. Agent-friendly batch
 *  update: export → edit → sync. */
async function cmdSync([dir, ...more]) {
  needSession();
  if (!dir) err("usage: weaver sync <dir> [--dry-run]", 2);
  if (cfg.mode !== "author" && !flags.as)
    err("observer mode: sync is author-only (or use --as <owner-email>)", 2);
  const dry = more.includes("--dry-run");
  const reasonIdx = more.indexOf("--reason");
  const reason = reasonIdx >= 0 ? more[reasonIdx + 1] : "cli sync";

  const toPush = [];
  const biblePath = join(dir, "bible.md");
  if (existsSync(biblePath))
    toPush.push({ type: "bible", slug: "bible", path: biblePath });
  for (const [type, sub] of Object.entries({
    biome: "biomes",
    character: "characters",
    npc: "npcs",
    location: "locations",
    item: "items",
  })) {
    const subdir = join(dir, sub);
    if (!existsSync(subdir)) continue;
    for (const f of readdirSync(subdir).filter((x) => x.endsWith(".md"))) {
      toPush.push({
        type,
        slug: basename(f, ".md"),
        path: join(subdir, f),
      });
    }
  }

  if (dry) {
    return out(
      toPush,
      (rs) =>
        `DRY RUN — would push ${rs.length} entities:\n` +
        rs.map((r) => `  ${r.type.padEnd(10)} ${r.slug}`).join("\n"),
    );
  }

  const client = getClient();
  const world_slug = currentWorld();
  const results = [];
  for (const item of toPush) {
    // Bible push route is not on the allowlist; skip with a warning to
    // keep batch non-destructive. Use `weaver fix bible bible <field>`
    // for bible edits.
    if (item.type === "bible") {
      results.push({ ...item, status: "skipped", note: "bible edits via `fix` only" });
      continue;
    }
    try {
      const payload = payloadFromEntityFile(item.type, item.path);
      const r = await client.mutation(ref("cli.pushEntityPayload"), {
        session_token: cfg.session_token,
        world_slug,
        type: item.type,
        slug: item.slug,
        payload_json: JSON.stringify(payload),
        reason,
      });
      results.push({ ...item, status: r.created ? "created" : "updated", version: r.version });
    } catch (e) {
      results.push({ ...item, status: "error", error: e?.message ?? String(e) });
    }
  }
  const summary = results.reduce(
    (acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc),
    {},
  );
  out(
    { summary, results },
    (o) =>
      Object.entries(o.summary)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ") +
      "\n" +
      o.results
        .map(
          (r) =>
            `  ${r.status.padEnd(8)} ${r.type.padEnd(10)} ${r.slug}${r.note ? ` — ${r.note}` : ""}${r.error ? ` — ${r.error}` : ""}${r.version ? ` (v${r.version})` : ""}`,
        )
        .join("\n"),
  );
}

// ---------------------------------------------------------------
// Commands: memory (NPC memory, Ask 4)

async function cmdMemory([sub, ...a]) {
  needSession();
  const client = getClient();
  const world_slug = currentWorld();
  if (!sub || sub === "list" || sub === "show") {
    const [npc_slug] = a;
    if (!npc_slug) err("usage: weaver memory show <npc_slug>", 2);
    const rows = await client.query(ref("npc_memory.listForNpc"), {
      session_token: cfg.session_token,
      world_slug,
      npc_slug,
    });
    return out(
      rows,
      (rs) =>
        rs.length === 0
          ? `(no memories for ${npc_slug})`
          : rs
              .map(
                (r) =>
                  `  [${r.salience}] turn ${String(r.turn).padStart(4)} ${r.event_type.padEnd(20)} ${r.summary}`,
              )
              .join("\n"),
    );
  }
  if (sub === "add") {
    if (cfg.mode !== "author" && !flags.as)
      err("observer mode: add is author-only (or use --as)", 2);
    const [npc_slug, event_type, ...more] = a;
    if (!npc_slug || !event_type)
      err('usage: weaver memory add <npc_slug> <event_type> "<summary>" [--salience high|medium|low]', 2);
    const salIdx = more.indexOf("--salience");
    const salience = salIdx >= 0 ? more[salIdx + 1] : undefined;
    const summary = more.filter((_, i) => salIdx < 0 || (i !== salIdx && i !== salIdx + 1)).join(" ");
    const r = await client.mutation(ref("npc_memory.addForNpc"), {
      session_token: cfg.session_token,
      world_slug,
      npc_slug,
      event_type,
      summary,
      salience,
    });
    return out(r, (o) => `wrote memory ${o.id}`);
  }
  err("usage: weaver memory [show <npc_slug>|add <npc_slug> <event_type> \"summary\"]", 2);
}

// ---------------------------------------------------------------
// Commands: flow (step-keyed module runtime)

async function cmdFlow([sub, ...a]) {
  needSession();
  const client = getClient();
  const world_slug = currentWorld();
  if (!sub || sub === "list") {
    const rows = await client.query(ref("flows.listMyFlows"), {
      session_token: cfg.session_token,
      world_slug,
    });
    return out(
      rows,
      (rs) =>
        rs.length === 0
          ? "(no flows)"
          : rs
              .map(
                (r) =>
                  `${r.id}  ${r.module_name.padEnd(12)} step=${r.current_step_id ?? "-"}  ${r.status}`,
              )
              .join("\n"),
    );
  }
  if (sub === "show") {
    const [id] = a;
    if (!id) err("usage: weaver flow show <id>", 2);
    const f = await client.query(ref("flows.getFlow"), {
      session_token: cfg.session_token,
      flow_id: id,
    });
    if (!f) err("flow not found or not yours", 3);
    return out(f);
  }
  if (sub === "start") {
    const [mod, ...more] = a;
    if (!mod) err('usage: weaver flow start <module> [--state \'{"k":"v"}\']', 2);
    if (cfg.mode !== "author" && !flags.as)
      err("observer mode: flow start is author-only", 2);
    const stateIdx = more.indexOf("--state");
    const initial_state = stateIdx >= 0 ? JSON.parse(more[stateIdx + 1]) : {};
    const r = await client.action(ref("flows.startFlow"), {
      session_token: cfg.session_token,
      world_slug,
      module: mod,
      initial_state,
    });
    return out(r, renderFlowResult);
  }
  if (sub === "step") {
    if (cfg.mode !== "author" && !flags.as)
      err("observer mode: flow step is author-only", 2);
    const [id, ...more] = a;
    if (!id)
      err('usage: weaver flow step <id> [--choice X] [--text "..."]', 2);
    const choiceIdx = more.indexOf("--choice");
    const textIdx = more.indexOf("--text");
    const input = {};
    if (choiceIdx >= 0) input.choice = more[choiceIdx + 1];
    if (textIdx >= 0) input.text = more[textIdx + 1];
    const r = await client.action(ref("flows.stepFlow"), {
      session_token: cfg.session_token,
      flow_id: id,
      input,
    });
    return out(r, renderFlowResult);
  }
  err("usage: weaver flow [list|start <mod>|step <id>|show <id>]", 2);
}

function renderFlowResult(r) {
  const lines = [];
  lines.push(
    `flow=${r.flow_id} module=${r.module_name} status=${r.status} step=${r.current_step_id ?? "-"}`,
  );
  for (const s of r.says ?? []) lines.push(`  ${s}`);
  if (r.ui) {
    if (r.ui.prompt) lines.push(`> ${r.ui.prompt}`);
    for (const c of r.ui.choices ?? [])
      lines.push(`  [${c.id}] ${c.label}`);
    if (r.ui.free_text) lines.push(`  (or free text)`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------
// Commands: art — full wardrobe from feature #12 art_curation.
//
//   art modes                             list Wave-2 modes
//   art variants <entity_slug> [type]     wardrobe: renderings by mode
//   art conjure <entity_slug> <mode> [type]  new rendering (Opus/FLUX)
//   art regen-variant <rendering_id>      new variant, same mode
//   art delete <rendering_id>             soft-delete (status=hidden)
//   art undelete <rendering_id>           recover a hidden variant
//   art upvote <rendering_id>             +1 upvote
//   art feedback <rendering_id> "..."     free-text feedback
//   art board-add <rendering_id> <kind>   push to reference board
//   art migrate <world_slug>              retrofit legacy art_blob_hash
//   art regen <location_slug>             legacy pre-curation path
//   art show <entity_slug> [type]         entity lookup

async function cmdArt([sub, ...a]) {
  needSession();
  const client = getClient();
  const world_slug = () => flags.world ?? cfg.world_slug ?? (err("no world", 2), "");
  const actorMode = () => cfg.mode === "author" || flags.as;

  if (sub === "modes") {
    return out(
      { wave_2: ["ambient_palette", "banner", "portrait_badge", "tarot_card", "illumination"] },
      (o) => `wave 2 modes: ${o.wave_2.join(", ")}`,
    );
  }
  if (sub === "variants") {
    const [slug, typeArg] = a;
    if (!slug) err("usage: weaver art variants <entity_slug> [type]", 2);
    const t = typeArg ?? "location";
    const e = await client.query(ref("cli.getEntity"), {
      session_token: cfg.session_token,
      world_slug: world_slug(),
      type: t,
      slug,
    });
    if (!e) err(`entity not found: ${t}/${slug}`, 3);
    const r = await client.query(ref("art_curation.getRenderingsForEntity"), {
      session_token: cfg.session_token,
      world_slug: world_slug(),
      entity_id: e.id,
    });
    return out(r, (o) => {
      if (!o) return "(no renderings — flag off?)";
      const lines = [`${o.entity_type}/${o.entity_slug} (${o.entity_id})`];
      const modes = Object.keys(o.modes ?? {}).sort();
      if (modes.length === 0) lines.push("  (no variants yet)");
      for (const mode of modes) {
        lines.push(`  ${mode}:`);
        for (const v of o.modes[mode]) {
          lines.push(
            `    v${v.variant_index}  id=${v.id}  ${v.status.padEnd(10)}  ↑${v.upvote_count}  hash=${v.blob_hash ? v.blob_hash.slice(0, 8) : "-"}`,
          );
        }
      }
      return lines.join("\n");
    });
  }
  if (sub === "conjure") {
    if (!actorMode()) err("observer mode: conjure is author-only", 2);
    const [slug, mode, typeArg] = a;
    if (!slug || !mode)
      err("usage: weaver art conjure <entity_slug> <mode> [type]", 2);
    const t = typeArg ?? "location";
    const e = await client.query(ref("cli.getEntity"), {
      session_token: cfg.session_token,
      world_slug: world_slug(),
      type: t,
      slug,
    });
    if (!e) err(`entity not found: ${t}/${slug}`, 3);
    const r = await client.action(ref("art_curation.conjureForEntity"), {
      session_token: cfg.session_token,
      world_slug: world_slug(),
      entity_id: e.id,
      mode,
    });
    return out(r, (o) => `conjured ${mode} rendering ${o.rendering_id} (${o.status})`);
  }
  if (sub === "regen-variant") {
    if (!actorMode()) err("observer mode: regen-variant is author-only", 2);
    const [rid] = a;
    if (!rid) err("usage: weaver art regen-variant <rendering_id>", 2);
    const r = await client.action(ref("art_curation.regenVariant"), {
      session_token: cfg.session_token,
      world_slug: world_slug(),
      rendering_id: rid,
    });
    return out(r, (o) => `new variant ${o.rendering_id} (${o.status})`);
  }
  if (sub === "delete") {
    if (!actorMode()) err("observer mode: delete is author-only", 2);
    const [rid] = a;
    if (!rid) err("usage: weaver art delete <rendering_id>", 2);
    const r = await client.mutation(ref("art_curation.deleteVariant"), {
      session_token: cfg.session_token,
      world_slug: world_slug(),
      rendering_id: rid,
    });
    return out(r, () => `hid ${rid}`);
  }
  if (sub === "undelete") {
    if (!actorMode()) err("observer mode: undelete is author-only", 2);
    const [rid] = a;
    if (!rid) err("usage: weaver art undelete <rendering_id>", 2);
    const r = await client.mutation(ref("art_curation.undeleteVariant"), {
      session_token: cfg.session_token,
      world_slug: world_slug(),
      rendering_id: rid,
    });
    return out(r, () => `recovered ${rid}`);
  }
  if (sub === "upvote") {
    const [rid] = a;
    if (!rid) err("usage: weaver art upvote <rendering_id>", 2);
    const r = await client.mutation(ref("art_curation.upvoteVariant"), {
      session_token: cfg.session_token,
      world_slug: world_slug(),
      rendering_id: rid,
    });
    return out(r, (o) =>
      o.already ? `already upvoted ${rid}` : `upvoted ${rid} (count=${o.upvote_count})`,
    );
  }
  if (sub === "feedback") {
    const [rid, ...words] = a;
    if (!rid || words.length === 0)
      err('usage: weaver art feedback <rendering_id> "comment"', 2);
    const r = await client.mutation(ref("art_curation.addFeedback"), {
      session_token: cfg.session_token,
      world_slug: world_slug(),
      rendering_id: rid,
      comment: words.join(" "),
    });
    return out(r, () => `feedback logged`);
  }
  if (sub === "board-add") {
    if (!actorMode()) err("observer mode: board-add is author-only", 2);
    const [rid, kind, ...rest] = a;
    if (!rid || !kind)
      err('usage: weaver art board-add <rendering_id> <kind> [--caption "..."]', 2);
    const capIdx = rest.indexOf("--caption");
    const caption = capIdx >= 0 ? rest[capIdx + 1] : undefined;
    const r = await client.mutation(ref("art_curation.addToReferenceBoard"), {
      session_token: cfg.session_token,
      world_slug: world_slug(),
      rendering_id: rid,
      kind,
      caption,
    });
    return out(r, (o) => `added to board kind=${kind} order=${o.order}`);
  }
  if (sub === "migrate") {
    if (!actorMode()) err("observer mode: migrate is owner-only", 2);
    const [target] = a;
    const slug = target ?? world_slug();
    const r = await client.mutation(ref("art_curation.migrateArtToRenderings"), {
      session_token: cfg.session_token,
      world_slug: slug,
      confirm: "yes-migrate-art",
    });
    return out(r, (o) => `migrated=${o.migrated} skipped=${o.skipped} total=${o.total_entities}`);
  }
  // Legacy paths (pre-curation):
  if (sub === "regen") {
    if (!actorMode()) err("observer mode: regen is author-only", 2);
    const [slug] = a;
    if (!slug) err("usage: weaver art regen <location_slug>", 2);
    const r = await client.action(ref("art.regenerateArt"), {
      session_token: cfg.session_token,
      world_id: cfg.world_id,
      location_slug: slug,
    });
    return out(r, () => `regen queued for location/${slug} (legacy path)`);
  }
  if (sub === "show") {
    const [slug, typeArg] = a;
    if (!slug) err("usage: weaver art show <entity_slug> [type]", 2);
    const t = typeArg ?? "location";
    const e = await client.query(ref("cli.getEntity"), {
      session_token: cfg.session_token,
      world_slug: world_slug(),
      type: t,
      slug,
    });
    if (!e) err(`entity not found: ${t}/${slug}`, 3);
    return out(e, (o) => `entity ${o.type}/${o.slug} id=${o.id}`);
  }
  err("usage: weaver art [modes|variants|conjure|regen-variant|delete|undelete|upvote|feedback|board-add|migrate|show|regen] ...", 2);
}

// ---------------------------------------------------------------
// Usage

function usage(topic) {
  const general = `
weaver — non-interactive CLI for driving Weaver

session:     login <email>  logout  whoami
worlds:      worlds  world use <slug>  world create <name>  world delete <slug> --yes
             world import <dir>
inspect:     where  look [slug]  char show  bible [--full]  cost
             entity list [--type T] [--limit N]  entity show <type> <slug>  entity versions <id>
             journey list  journey show <id>
play:        pick <idx|label>  weave "<text>"  go <slug>  wait  clock [+<dur>|set <dow> <hh:mm>]
             state  state set <path> <json>  state inc <path> <n>
             journey resolve <id> <slugs>  journey dismiss <id>
fix:         fix <type> <slug> <field> <json> [--reason "..."]    (member-level, non-destructive)

flags:       --json   structured output  --world <slug>  override current  --full  don't truncate
             --type <type>  filter entity list  --limit N  cap results  --url <url>  override convex

state persisted to ${CONFIG_PATH}
`.trim();
  process.stdout.write(general + "\n");
}
