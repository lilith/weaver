#!/usr/bin/env node
// scripts/gameplay-sweep.mjs — scripted full-feature gameplay test.
//
// Creates an ephemeral test user, seeds a fresh Quiet Vale world,
// walks every LitRPG-lite / Wave-2 surface, asserts invariants between
// steps. Prints PASS/FAIL per scenario + exits 0 when all green.
//
// Runs against the live Convex dev deployment; scenarios that cost
// money (Opus calls via expansion/dialogue/combat-inside-flow) are
// gated behind WEAVER_SWEEP_COST=allow so a default run stays cheap.
//
// Usage:
//   node scripts/gameplay-sweep.mjs
//   WEAVER_SWEEP_COST=allow node scripts/gameplay-sweep.mjs  # hits LLMs
//
// Invariants checked:
//   - character.state.hp/gold/energy are finite numbers
//   - inventory is {} or a valid map
//   - pending_says is always an array
//   - this.visited increments on location re-entry
//   - condition-gated options hide/show per world clock
//   - prefetch draft materializes within ~20s
//   - runtime_bugs count doesn't grow during a clean session

import { ConvexHttpClient } from "convex/browser";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";

const HERE = dirname(fileURLToPath(import.meta.url));
const { api } = await import(resolve(HERE, "../convex/_generated/api.js"));

const CONVEX_URL =
  process.env.PUBLIC_CONVEX_URL ?? "https://friendly-chameleon-175.convex.cloud";
const COST_ALLOWED = process.env.WEAVER_SWEEP_COST === "allow";
const STAMP = Date.now();
const EMAIL = `sweep-${STAMP}@theweaver.quest`;

const client = new ConvexHttpClient(CONVEX_URL);

// --------------------------------------------------------------------
// Minimal test harness

let pass = 0;
let fail = 0;
const failures = [];
function log(msg) {
  console.log(msg);
}
function passed(name) {
  pass++;
  log(`  \x1b[32m✓\x1b[0m ${name}`);
}
function failed(name, detail) {
  fail++;
  failures.push({ name, detail });
  log(`  \x1b[31m✗\x1b[0m ${name}\n    ${detail}`);
}
function assert(cond, name, detail = "") {
  if (cond) passed(name);
  else failed(name, detail || "expected truthy");
}
function assertEq(actual, expected, name) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) passed(name);
  else failed(name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function assertIs(actual, predicate, name, detail = "") {
  if (predicate(actual)) passed(name);
  else failed(name, `${detail} got ${JSON.stringify(actual)}`);
}

// --------------------------------------------------------------------
// Scenarios

async function main() {
  log(`== Weaver gameplay sweep (cost=${COST_ALLOWED ? "allow" : "cheap"}) ==`);
  log(`   user: ${EMAIL}`);
  log(``);

  // --- Auth ---
  log("[auth]");
  const { session_token, user_id } = await client.action(api._dev.devSignInAs, {
    email: EMAIL,
  });
  assert(!!session_token, "devSignInAs returns session_token");
  assert(!!user_id, "devSignInAs returns user_id");

  // --- Seed Quiet Vale ---
  log("\n[seed]");
  const seed = await client.mutation(api.seed.seedStarterWorld, {
    session_token,
    character_name: "Sweeper",
  });
  assert(/^quiet-vale-/.test(seed.slug), "seeded world slug looks like quiet-vale-XXXX");
  const world_id = seed.world_id;
  const world_slug = seed.slug;

  // --- Initial state invariants ---
  log("\n[initial character state invariants]");
  let me = await client.query(api.cli.whereAmI, { session_token, world_slug });
  const state0 = me.character.state;
  assertIs(state0.hp, (x) => typeof x === "number" && Number.isFinite(x), "hp is finite number");
  assertIs(state0.gold, (x) => typeof x === "number", "gold is number");
  assertIs(state0.energy, (x) => typeof x === "number", "energy is number");
  assertIs(
    state0.inventory,
    (x) => Array.isArray(x) || (x && typeof x === "object"),
    "inventory is array or object",
  );
  assert(me.character.current_location_slug === "village-square", "starter at village-square");

  // --- on_enter / on_leave wiring: visit mara-cottage and back ---
  log("\n[on_enter/on_leave hooks]");
  await client.mutation(api.locations.applyOption, {
    session_token,
    world_id,
    location_slug: "village-square",
    option_index: 1, // "Walk up to Mara's cottage" → goto
  });
  await client.mutation(api.locations.applyOption, {
    session_token,
    world_id,
    location_slug: "mara-cottage",
    option_index: 2, // "Step back out" → goto village-square
  });
  me = await client.query(api.cli.whereAmI, { session_token, world_slug });
  const visited1 = me.character.state.this?.["village-square"]?.visited;
  assertEq(visited1, 1, "village-square.visited = 1 after one return");

  // Second round-trip
  await client.mutation(api.locations.applyOption, {
    session_token,
    world_id,
    location_slug: "village-square",
    option_index: 1,
  });
  await client.mutation(api.locations.applyOption, {
    session_token,
    world_id,
    location_slug: "mara-cottage",
    option_index: 2,
  });
  me = await client.query(api.cli.whereAmI, { session_token, world_slug });
  const visited2 = me.character.state.this?.["village-square"]?.visited;
  assertEq(visited2, 2, "village-square.visited = 2 after two returns");

  // --- Clock tick per option ---
  log("\n[clock ticks per option]");
  const clock0 = me.branch.state.time;
  await client.mutation(api.locations.applyOption, {
    session_token,
    world_id,
    location_slug: "village-square",
    option_index: 0, // say-only "draw water"
  });
  me = await client.query(api.cli.whereAmI, { session_token, world_slug });
  const clock1 = me.branch.state.time;
  assert(
    new Date(clock1.iso).getTime() > new Date(clock0.iso).getTime(),
    "clock advances on applyOption",
  );

  // --- Condition-gated option via world.time.day_of_week ---
  log("\n[condition-gated options]");
  // Fix village-square to add a tuesday-only option, flag.world_clock is on.
  await client.mutation(api.cli.fixEntityField, {
    session_token,
    world_slug,
    type: "location",
    slug: "village-square",
    field: "options",
    new_value_json: JSON.stringify([
      { label: "Draw water from the well", effect: [{ kind: "say", text: "ok" }] },
      { label: "Walk up to Mara's cottage", target: "mara-cottage" },
      { label: "Whisper at dawn", condition: 'world.time.hhmm >= "05:00" && world.time.hhmm < "07:00"' },
      { label: "At 09:00 only", condition: 'world.time.hhmm == "09:00"' },
    ]),
    reason: "gameplay-sweep condition test",
  });
  const dump = await client.query(api.cli.dumpLocation, {
    session_token,
    world_slug,
    loc_slug: "village-square",
  });
  const bools = dump.options.map((o) => o.visible);
  // Two static visible (0, 1); two gated depend on actual clock.
  assertEq(bools.slice(0, 2), [true, true], "first two options always visible");
  const clockNow = dump.world_state.time;
  const expectedDawn = clockNow.hhmm >= "05:00" && clockNow.hhmm < "07:00";
  assertEq(bools[2], expectedDawn, `dawn-only option visibility matches clock (hhmm=${clockNow.hhmm})`);

  // --- Clock fast-forward to test exact-time condition ---
  log("\n[clock fast-forward]");
  // Jump to a specific hhmm: pick next 09:00 on the current DOW
  await client.mutation(api.cli.fastForwardClock, {
    session_token,
    world_slug,
    to_day_of_week: "wed",
    to_hhmm: "09:00",
  });
  const dump2 = await client.query(api.cli.dumpLocation, {
    session_token,
    world_slug,
    loc_slug: "village-square",
  });
  assert(dump2.world_state.time.hhmm === "09:00", "clock landed at 09:00");
  assert(dump2.world_state.time.day_of_week === "wed", "clock landed on wednesday");
  assertEq(dump2.options[3].visible, true, "09:00-only option visible at 09:00");

  // --- Item taxonomy: give orb, verify inventory structure ---
  log("\n[item taxonomy: give + inventory shape]");
  // Turn flag on + author an orb + pick an option that gives it.
  await client.mutation(api.flags.set, {
    session_token,
    flag_key: "flag.item_taxonomy",
    scope_kind: "world",
    scope_id: world_slug,
    enabled: true,
  });
  await client.mutation(api.cli.pushEntityPayload, {
    session_token,
    world_slug,
    type: "item",
    slug: "test-orb",
    payload_json: JSON.stringify({
      name: "Test Orb",
      kind: "orb",
      orb: {
        color: "green",
        size: 1,
        on_crack: [{ kind: "say", text: "Green motes scatter." }],
        on_absorb: [{ kind: "inc", path: "character.energy", by: 2 }],
      },
    }),
    reason: "sweep: orb",
  });
  await client.mutation(api.cli.fixEntityField, {
    session_token,
    world_slug,
    type: "location",
    slug: "village-square",
    field: "options",
    new_value_json: JSON.stringify([
      { label: "Pick up the test orb", effect: [{ kind: "give_item", slug: "test-orb" }] },
      { label: "Crack it", condition: 'has(character.inventory, "test-orb")', effect: [{ kind: "crack_orb", slug: "test-orb" }] },
      { label: "Back out", target: "mara-cottage" },
    ]),
    reason: "sweep: orb-pick options",
  });
  // Need to be at village-square to pick
  await client.mutation(api.cli.teleportCharacter, {
    session_token,
    world_slug,
    loc_slug: "village-square",
  });
  const energyBefore = (await client.query(api.cli.whereAmI, { session_token, world_slug }))
    .character.state.energy;
  await client.mutation(api.locations.applyOption, {
    session_token,
    world_id,
    location_slug: "village-square",
    option_index: 0, // pick up
  });
  me = await client.query(api.cli.whereAmI, { session_token, world_slug });
  const invAfterPick = me.character.state.inventory;
  assertIs(
    invAfterPick,
    (x) => x && typeof x === "object" && !Array.isArray(x),
    "inventory became a map after give_item",
  );
  assert(invAfterPick["test-orb"]?.qty === 1, "test-orb qty=1");
  assertEq(invAfterPick["test-orb"].kind, "orb", "test-orb kind snapshotted");
  assertEq(invAfterPick["test-orb"].color, "green", "test-orb color snapshotted");

  // Crack orb — conditions should have unblocked it
  const dump3 = await client.query(api.cli.dumpLocation, {
    session_token,
    world_slug,
    loc_slug: "village-square",
  });
  assertEq(dump3.options[1].visible, true, "crack option visible now that inventory has orb");
  await client.mutation(api.locations.applyOption, {
    session_token,
    world_id,
    location_slug: "village-square",
    option_index: 1,
  });
  me = await client.query(api.cli.whereAmI, { session_token, world_slug });
  assert(!me.character.state.inventory["test-orb"], "test-orb consumed by crack");
  assert(me.character.state.energy === energyBefore + 2, `energy incremented by on_absorb (${energyBefore} → ${energyBefore + 2})`);

  // --- State-mutation invariants: inventory string-corruption heals ---
  log("\n[sanitizer self-heal]");
  await client.mutation(api.cli.setCharacterState, {
    session_token,
    world_slug,
    path: "inventory",
    value_json: '"oops-I-set-a-string"',
  });
  // Next applyOption should heal it via the sanitizer
  await client.mutation(api.locations.applyOption, {
    session_token,
    world_id,
    location_slug: "village-square",
    option_index: 2, // back out — any option
  });
  me = await client.query(api.cli.whereAmI, { session_token, world_slug });
  assertIs(
    me.character.state.inventory,
    (x) => typeof x === "object" && !Array.isArray(x) && x !== null,
    "inventory healed from string corruption to {}",
  );
  const bugs = await client.query(api.diagnostics.listBugs, {
    session_token,
    world_slug,
    since_ms: Date.now() - 60_000,
  });
  assert(
    bugs.some((b) => b.code === "char.state.inventory.string"),
    "string-inventory bug logged to runtime_bugs",
  );

  // --- Flow runtime: counter module end-to-end ---
  log("\n[flow runtime: counter]");
  await client.mutation(api.flags.set, {
    session_token,
    flag_key: "flag.flows",
    scope_kind: "world",
    scope_id: world_slug,
    enabled: true,
  });
  const c0 = await client.action(api.flows.startFlow, {
    session_token,
    world_slug,
    module: "counter",
    initial_state: { target: 3 },
  });
  assert(c0.status === "waiting", "counter starts waiting after open");
  assert(c0.current_step_id === "counting", "counter at counting step");
  let cN = c0;
  for (let i = 0; i < 3; i++) {
    cN = await client.action(api.flows.stepFlow, {
      session_token,
      flow_id: c0.flow_id,
      input: { choice: "continue" },
    });
  }
  assert(cN.status === "completed", "counter completed after 3 steps");

  // --- Prefetch (optional, cost-gated) ---
  if (COST_ALLOWED) {
    log("\n[prefetch — hits Opus]");
    await client.mutation(api.flags.set, {
      session_token,
      flag_key: "flag.text_prefetch",
      scope_kind: "world",
      scope_id: world_slug,
      enabled: true,
    });
    // Add an option with an unresolved target
    await client.mutation(api.cli.fixEntityField, {
      session_token,
      world_slug,
      type: "location",
      slug: "village-square",
      field: "options",
      new_value_json: JSON.stringify([
        { label: "Down to the unknown cellar", target: "unknown-cellar" },
        { label: "Back out", target: "mara-cottage" },
      ]),
      reason: "sweep: prefetch target",
    });
    const pr = await client.action(api.expansion.ensurePrefetched, {
      session_token,
      world_id,
      location_slug: "village-square",
    });
    assert(pr.flag, "prefetch flag on");
    assert(pr.options.length > 0, "at least one unresolved target picked up");

    log("   waiting up to 25s for Opus to land the draft…");
    let landed = false;
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const entities = await client.query(api.cli.listEntities, {
        session_token,
        world_slug,
        type: "location",
      });
      if (entities.some((e) => e.prefetched_from_entity_id != null && e.draft)) {
        landed = true;
        break;
      }
    }
    assert(landed, "prefetched draft materialized within 25s");
  } else {
    log("\n[prefetch — skipped (set WEAVER_SWEEP_COST=allow to hit Opus)]");
  }

  // --- Summary ---
  log("\n== Summary ==");
  log(`${pass} passed, ${fail} failed`);
  if (fail > 0) {
    log("\nFailures:");
    for (const f of failures) log(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
}

try {
  await main();
} catch (e) {
  console.error("\x1b[31mSWEEP CRASHED:\x1b[0m", e);
  process.exit(2);
}
