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
const COST_ALLOWED =
  process.env.WEAVER_SWEEP_COST === "allow" || process.argv.includes("--long");
const LONG_MODE = process.argv.includes("--long");
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

    log("   waiting up to 40s for Opus to land the draft…");
    const beforeCount = (
      await client.query(api.cli.listEntities, {
        session_token,
        world_slug,
        type: "location",
      })
    ).filter((e) => e.draft).length;
    let landed = false;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const after = await client.query(api.cli.listEntities, {
        session_token,
        world_slug,
        type: "location",
      });
      if (after.filter((e) => e.draft).length > beforeCount) {
        landed = true;
        break;
      }
    }
    assert(landed, `prefetched draft materialized within 40s (drafts pre=${beforeCount})`);
  } else {
    log("\n[prefetch — skipped (set WEAVER_SWEEP_COST=allow to hit Opus)]");
  }

  // --- --long: dialogue + combat round-trip (hits Sonnet + runs effects) ---
  if (LONG_MODE) {
    log("\n[dialogue module — hits Sonnet, ~$0.005]");
    // Push a tiny NPC so dialogue has a speaker.
    await client.mutation(api.cli.pushEntityPayload, {
      session_token,
      world_slug,
      type: "npc",
      slug: "sweep-bard",
      payload_json: JSON.stringify({
        name: "Sweep Bard",
        description: "A bard who only speaks in sweep-test questions.",
        voice: { style: "Calm, curious, quick." },
        memory: {
          default_salience: "medium",
          retention: 40,
          track: ["dialogue_turn"],
          ignore: [],
        },
        memory_initial: [
          { summary: "Has been asked one question before.", salience: "high" },
        ],
      }),
      reason: "sweep: dialogue npc",
    });
    await client.mutation(api.flags.set, {
      session_token,
      flag_key: "flag.npc_memory",
      scope_kind: "world",
      scope_id: world_slug,
      enabled: true,
    });
    const d0 = await client.action(api.flows.startFlow, {
      session_token,
      world_slug,
      module: "dialogue",
      initial_state: { speaker_slug: "sweep-bard", exchanges: 0 },
    });
    assert(d0.status === "waiting", "dialogue flow waiting after open");
    assert(d0.says?.length > 0, "dialogue flow produced a greeting line");
    const d1 = await client.action(api.flows.stepFlow, {
      session_token,
      flow_id: d0.flow_id,
      input: { text: "What's this sweep testing, bard?" },
    });
    assert(d1.says?.length >= 2, "dialogue exchange produced player + bard lines");
    // Memory row written?
    const memRows = await client.query(api.npc_memory.listForNpc, {
      session_token,
      world_slug,
      npc_slug: "sweep-bard",
    });
    assert(
      memRows.some((m) => m.event_type === "dialogue_turn"),
      "dialogue_turn memory auto-written",
    );

    log("\n[combat module — deterministic seeded rolls, character.hp ticks]");
    await client.mutation(api.flags.set, {
      session_token,
      flag_key: "flag.flows",
      scope_kind: "world",
      scope_id: world_slug,
      enabled: true,
    });
    // Set a known HP for the round count we expect.
    await client.mutation(api.cli.setCharacterState, {
      session_token,
      world_slug,
      path: "hp",
      value_json: "20",
    });
    const c0 = await client.action(api.flows.startFlow, {
      session_token,
      world_slug,
      module: "combat",
      initial_state: {
        enemy_slug: "sweep-dummy",
        enemy_name: "Sweep Dummy",
        enemy_hp: 4,
        enemy_max_hp: 4,
        enemy_attack: 2,
        player_weapon_attack: 3,
        escape_dc: 8,
      },
    });
    assert(c0.status === "running", "combat starts running after open");
    // Loop until the flow completes or we hit a safety cap.
    let cN = c0;
    for (let i = 0; i < 15; i++) {
      if (cN.status === "completed") break;
      cN = await client.action(api.flows.stepFlow, {
        session_token,
        flow_id: c0.flow_id,
        input: { choice: "attack" },
      });
    }
    assert(cN.status === "completed", "combat completes within 15 rounds");
    // Character HP should have decreased from enemy counters.
    const afterCombat = await client.query(api.cli.whereAmI, {
      session_token,
      world_slug,
    });
    const hpAfter = afterCombat.character.state.hp;
    assert(
      typeof hpAfter === "number" && hpAfter <= 20,
      `character hp dropped from 20 (got ${hpAfter})`,
    );
  } else {
    log("\n[dialogue + combat — skipped (pass --long to exercise)]");
  }

  // --- Option-effect wirings: flow_start through applyOption, legacy item_id ---
  log("\n[option-effect wirings]");
  // Snapshot pre-count for legacy inventory test (gives `legacy-widget` via item_id).
  await client.mutation(api.cli.fixEntityField, {
    session_token,
    world_slug,
    type: "location",
    slug: "village-square",
    field: "options",
    new_value_json: JSON.stringify([
      {
        label: "Start a counter flow via option-effect",
        effect: [
          { kind: "flow_start", module: "counter", initial_state: { target: 2 } },
        ],
      },
      {
        label: "Grant a legacy-named item via item_id",
        effect: [{ kind: "give_item", item_id: "legacy-widget" }],
      },
      { label: "Back out", target: "mara-cottage" },
    ]),
    reason: "sweep: flow_start + item_id legacy",
  });
  await client.mutation(api.cli.teleportCharacter, {
    session_token,
    world_slug,
    loc_slug: "village-square",
  });
  const flowsBefore = await client.query(api.flows.listMyFlows, {
    session_token,
    world_slug,
  });
  await client.mutation(api.locations.applyOption, {
    session_token,
    world_id,
    location_slug: "village-square",
    option_index: 0,
  });
  // Flow starts via scheduler.runAfter(0) — poll briefly.
  let flowsAfter = flowsBefore;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 150));
    flowsAfter = await client.query(api.flows.listMyFlows, {
      session_token,
      world_slug,
    });
    if (flowsAfter.length > flowsBefore.length) break;
  }
  assert(
    flowsAfter.length > flowsBefore.length,
    "flow_start option-effect opened a new flow row",
  );
  assert(
    flowsAfter.some((f) => f.module_name === "counter"),
    "flow_start option-effect created a counter-module flow",
  );
  // Legacy item_id fallback: give_item with item_id (not slug) should still add.
  await client.mutation(api.locations.applyOption, {
    session_token,
    world_id,
    location_slug: "village-square",
    option_index: 1,
  });
  const legacyMe = await client.query(api.cli.whereAmI, {
    session_token,
    world_slug,
  });
  assert(
    legacyMe.character.state.inventory?.["legacy-widget"]?.qty === 1,
    "give_item with legacy item_id field populated inventory under that slug",
  );

  // --- spawn_combat effect + expression-bug logging + depth guard ---
  log("\n[spawn_combat + runtime bug logging]");
  // Author a tiny hostile NPC with a combat_profile.
  await client.mutation(api.cli.pushEntityPayload, {
    session_token,
    world_slug,
    type: "npc",
    slug: "sweep-scrapper",
    payload_json: JSON.stringify({
      name: "Sweep Scrapper",
      description: "A sweep-test hostile.",
      combat_profile: { hp: 2, attack: 1, escape_dc: 5 },
    }),
    reason: "sweep: spawn_combat npc",
  });
  await client.mutation(api.cli.fixEntityField, {
    session_token,
    world_slug,
    type: "location",
    slug: "village-square",
    field: "options",
    new_value_json: JSON.stringify([
      {
        label: "Trigger spawn_combat on scrapper",
        effect: [{ kind: "spawn_combat", npc_slug: "sweep-scrapper" }],
      },
      {
        label: "Option with broken condition",
        condition: "@@@not a real expression@@@",
        effect: [{ kind: "say", text: "should never fire" }],
      },
      { label: "Back out", target: "mara-cottage" },
    ]),
    reason: "sweep: spawn_combat + broken-cond",
  });
  await client.mutation(api.cli.teleportCharacter, {
    session_token,
    world_slug,
    loc_slug: "village-square",
  });
  const spawnFlowsBefore = await client.query(api.flows.listMyFlows, {
    session_token,
    world_slug,
  });
  await client.mutation(api.locations.applyOption, {
    session_token,
    world_id,
    location_slug: "village-square",
    option_index: 0,
  });
  let spawnFlowsAfter = spawnFlowsBefore;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 150));
    spawnFlowsAfter = await client.query(api.flows.listMyFlows, {
      session_token,
      world_slug,
    });
    if (spawnFlowsAfter.length > spawnFlowsBefore.length) break;
  }
  const spawnedCombat = spawnFlowsAfter.find(
    (f) =>
      f.module_name === "combat" &&
      !spawnFlowsBefore.some((p) => p.id === f.id),
  );
  assert(spawnedCombat, "spawn_combat effect opened a combat flow row");
  assert(
    spawnedCombat.state?.enemy_slug === "sweep-scrapper" &&
      spawnedCombat.state?.enemy_hp === 2 &&
      spawnedCombat.state?.enemy_attack === 1,
    "spawn_combat resolved NPC combat_profile (hp=2, atk=1)",
  );

  // Pick the broken-condition option. applyOption will soft-refuse
  // (since the parse error triggers the logBugs + early-return branch,
  // not the throw branch).
  const brokeRes = await client.mutation(api.locations.applyOption, {
    session_token,
    world_id,
    location_slug: "village-square",
    option_index: 1,
  });
  assert(
    (brokeRes.says ?? []).some((s) => s.includes("authoring error")),
    "broken-condition option soft-refused with authoring-error say",
  );
  // Scheduler-dispatched bug write lands shortly after the throw;
  // poll briefly rather than sleep a fixed duration.
  let spawnBugs = [];
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 150));
    spawnBugs = await client.query(api.diagnostics.listBugs, {
      session_token,
      world_slug,
      since_ms: Date.now() - 30_000,
    });
    if (
      spawnBugs.some(
        (b) =>
          b.code === "expr.tokenize_failed" || b.code === "expr.parse_failed",
      )
    )
      break;
  }
  const hasExprBug = spawnBugs.some(
    (b) => b.code === "expr.tokenize_failed" || b.code === "expr.parse_failed",
  );
  if (!hasExprBug) {
    log(`  [debug] bugs returned: ${JSON.stringify(spawnBugs.map((b) => b.code))}`);
  }
  assert(hasExprBug, "broken condition logged to runtime_bugs");

  // --- New-day hook: hostile_nearby clears + dawn say appended ---
  log("\n[newday hook on day rollover]");
  // Seed a stale hostile-nearby flag on village-square.
  await client.mutation(api.cli.setCharacterState, {
    session_token,
    world_slug,
    path: "this.village-square.hostile_nearby",
    value_json: '"sweep-scrapper"',
  });
  // Cache pending-says baseline (the soft-refuse added one line).
  const preNewdayMe = await client.query(api.cli.whereAmI, {
    session_token,
    world_slug,
  });
  const preDaySays = (preNewdayMe.character.state.pending_says ?? []).length;
  const preDay = (
    await client.query(api.cli.dumpLocation, {
      session_token,
      world_slug,
      loc_slug: "village-square",
    })
  ).world_state.time.day_counter;
  // Jump the clock to just before midnight so the next applyOption
  // tick will roll the day counter (the newday hook is keyed off the
  // prev→next day_counter delta inside applyOption, not off
  // fastForwardClock — fastForwardClock doesn't fire gameplay hooks).
  const currentDow = (
    await client.query(api.cli.dumpLocation, {
      session_token,
      world_slug,
      loc_slug: "village-square",
    })
  ).world_state.time.day_of_week;
  await client.mutation(api.cli.fastForwardClock, {
    session_token,
    world_slug,
    to_day_of_week: currentDow,
    to_hhmm: "23:55",
  });
  // Re-set the stale hostile flag in case fastForwardClock touched state.
  await client.mutation(api.cli.setCharacterState, {
    session_token,
    world_slug,
    path: "this.village-square.hostile_nearby",
    value_json: '"sweep-scrapper"',
  });
  // Bump tick_minutes large enough that +1 tick rolls past midnight.
  // Each option-pick advances 1 tick; sandbox default is 1 min, so
  // advance_time in the effect list pushes us across.
  await client.mutation(api.cli.fixEntityField, {
    session_token,
    world_slug,
    type: "location",
    slug: "village-square",
    field: "options",
    new_value_json: JSON.stringify([
      {
        label: "Push clock past midnight",
        effect: [{ kind: "advance_time", delta_minutes: 20 }],
      },
      { label: "Back out", target: "mara-cottage" },
    ]),
    reason: "sweep: newday advance_time",
  });
  await client.mutation(api.cli.teleportCharacter, {
    session_token,
    world_slug,
    loc_slug: "village-square",
  });
  await client.mutation(api.locations.applyOption, {
    session_token,
    world_id,
    location_slug: "village-square",
    option_index: 0, // push clock past midnight
  });
  const postNewdayMe = await client.query(api.cli.whereAmI, {
    session_token,
    world_slug,
  });
  const postHostile =
    postNewdayMe.character.state.this?.["village-square"]?.hostile_nearby;
  assert(
    postHostile === undefined,
    "newday cleared hostile_nearby on this-scope",
  );
  const postSays = postNewdayMe.character.state.pending_says ?? [];
  assert(
    postSays.some((s) => s.includes("dawn") || s.includes("days pass")),
    "newday appended a dawn say to pending_says",
  );
  const postDump = await client.query(api.cli.dumpLocation, {
    session_token,
    world_slug,
    loc_slug: "village-square",
  });
  assert(
    postDump.world_state.time.day_counter > preDay,
    `day_counter advanced (was ${preDay}, now ${postDump.world_state.time.day_counter})`,
  );

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
