#!/usr/bin/env -S pnpm dlx tsx
// Template + expression engine tests. Runs pure TS imports — no Convex.
// Run via:  pnpm dlx tsx scripts/template-tests.mjs
// Covers the fixes from the Wave-2 creative-agent gap list:
//   - #if accepts expressions (not just paths)
//   - bracket-subscript for hyphenated inventory keys
//   - numeric comparison against undefined is false (no ASCII-lex)
//   - malformed expressions fail soft

import { renderTemplate } from "../packages/engine/src/template/index.ts";
import { evalExpression, evalCondition } from "../packages/engine/src/clock/index.ts";

let pass = 0;
let fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    console.log(`  \u001b[32m\u2713\u001b[0m ${label}`);
    pass++;
  } else {
    console.log(
      `  \u001b[31m\u2717\u001b[0m ${label}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`,
    );
    fail++;
  }
}

console.log("\n[#if expression inside template]");
{
  const ctx = {
    character: { hp: 10, energy: 5, inventory: { "yellow-orb": { qty: 2, kind: "orb" } } },
    this: { growth: 3 },
  };
  check(
    "#if with && compound",
    renderTemplate("A{{#if character.hp > 0 && character.energy > 0}}B{{/if}}C", ctx),
    "ABC",
  );
  check(
    "#if with ternary-value",
    renderTemplate("{{#if character.hp > 5 ? true : false}}strong{{/if}}", ctx),
    "strong",
  );
  check(
    "#if with comparison false branch",
    renderTemplate("{{#if this.growth >= 4}}ready{{/if}}", ctx),
    "",
  );
  check(
    "#if with has() builtin",
    renderTemplate(`{{#if has(character.inventory, "yellow-orb")}}orb{{/if}}`, ctx),
    "orb",
  );
  check(
    "#unless negates",
    renderTemplate("{{#unless this.harvested}}ready{{/unless}}", ctx),
    "ready",
  );
}

console.log("\n[bracket subscript + dotted chain on expressions]");
{
  const scope = {
    character: {
      inventory: {
        "yellow-orb": { qty: 3, kind: "orb" },
        "book-of-clouds": { qty: 1, charges: 99 },
      },
    },
  };
  check(
    'character.inventory["yellow-orb"].qty',
    evalExpression('character.inventory["yellow-orb"].qty', scope),
    3,
  );
  check(
    'character.inventory["yellow-orb"].qty >= 3',
    evalExpression('character.inventory["yellow-orb"].qty >= 3', scope),
    true,
  );
  check(
    "subscript on nonexistent key returns undefined safely",
    evalExpression('character.inventory["no-such-item"].qty', scope),
    undefined,
  );
  check(
    "postfix .ident on expression result",
    evalExpression('(character.inventory)["book-of-clouds"].charges', scope),
    99,
  );
}

console.log("\n[numeric comparison against undefined]");
{
  const scope = { this: {} };
  check("undefined >= 4 is false", evalCondition("this.growth >= 4", scope), false);
  check(
    "undefined >= 4 with explicit truthy guard still works",
    evalCondition("this.growth && this.growth >= 4", scope),
    false,
  );
  // Time-of-day string comparison must still work (tasks use this pattern)
  const timeScope = { world: { time: { hhmm: "14:30" } } };
  check(
    "time-of-day >= comparison (string lex fallback)",
    evalCondition(`world.time.hhmm >= "07:00"`, timeScope),
    true,
  );
  check(
    "time-of-day < comparison preserved",
    evalCondition(`world.time.hhmm < "21:00"`, timeScope),
    true,
  );
}

console.log("\n[malformed expression fails soft]");
{
  const scope = { x: 1 };
  check("unknown @ character returns undefined", evalExpression("@foo", scope), undefined);
  check("dangling bracket returns undefined", evalExpression("x[", scope), undefined);
  check("empty expression returns undefined", evalExpression("", scope), undefined);
}

console.log("\n[regression: bare-path #if still works]");
{
  check(
    "bare path truthy",
    renderTemplate("{{#if flag}}on{{/if}}", { flag: true }),
    "on",
  );
  check(
    "bare path falsy",
    renderTemplate("{{#if flag}}on{{/if}}", { flag: false }),
    "",
  );
  check(
    "dotted path (greedy ident)",
    renderTemplate("{{#if character.hp}}alive{{/if}}", { character: { hp: 10 } }),
    "alive",
  );
}

console.log("\n== Summary ==");
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
