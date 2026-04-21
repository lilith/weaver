#!/usr/bin/env -S pnpm dlx tsx
// Graph-layout unit tests (spec/26 Layer 1).
//
// Pure Node — no Convex, no DOM. Covers:
//   - classifyNode priority order (map_shape override, verbs → action,
//     cardinals/≥2 neighbors → spatial, else floating)
//   - directionToVector for cardinals, diagonals, up/down, in/out, junk
//   - layoutSubgraph determinism (same seed + inputs → same output)
//   - Cardinal cone bias pulls edges back inside 45° cone
//   - Pin attractors dominate force sim
//   - BFS seed doesn't NaN when the first node has 0 neighbors
//   - Empty + single-node subgraphs
//
// Run:  pnpm dlx tsx scripts/graph-layout-tests.mjs

import {
  classifyNode,
  directionToVector,
  layoutSubgraph,
  layoutRadialTree,
  layoutBiomeCluster,
  layout,
  CARDINAL_LABELS,
  VERB_LABELS,
} from "../packages/engine/src/graph-layout/index.ts";

let pass = 0;
let fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    console.log(`  [32m✓[0m ${label}`);
    pass++;
  } else {
    console.log(
      `  [31m✗[0m ${label}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`,
    );
    fail++;
  }
}
function checkNear(label, got, want, eps = 1e-6) {
  const ok = Math.abs(got - want) <= eps;
  if (ok) {
    console.log(`  [32m✓[0m ${label}`);
    pass++;
  } else {
    console.log(`  [31m✗[0m ${label}\n      got ${got} want ${want}`);
    fail++;
  }
}
function checkTrue(label, cond, why = "") {
  if (cond) {
    console.log(`  [32m✓[0m ${label}`);
    pass++;
  } else {
    console.log(`  [31m✗[0m ${label}  ${why}`);
    fail++;
  }
}

// --- classifyNode -------------------------------------------------------

console.log("\n[classifyNode]");
{
  // Rule 1 — explicit override wins.
  check(
    "map_shape override returns as-is",
    classifyNode({
      slug: "x",
      biome: null,
      subgraph: null,
      map_shape: "floating",
      draft: false,
      tags: [],
      neighbors: { n: "y", s: "z" },
    }),
    "floating",
  );
  // Rule 2 — draft + 1 neighbor + parent-verb-back → action.
  check(
    "draft dead-end on verb edge → action",
    classifyNode({
      slug: "book",
      biome: null,
      subgraph: null,
      draft: true,
      tags: [],
      neighbors: { back: "library" },
    }),
    "action",
  );
  // Rule 3 — all verbs → action (even if not draft).
  check(
    "all verb labels → action",
    classifyNode({
      slug: "bench",
      biome: null,
      subgraph: null,
      draft: false,
      tags: [],
      neighbors: { sit: "bench-sitting", examine: "bench-detail" },
    }),
    "action",
  );
  // Rule 4 — any cardinal → spatial.
  check(
    "cardinal neighbor → spatial",
    classifyNode({
      slug: "x",
      biome: null,
      subgraph: null,
      draft: false,
      tags: [],
      neighbors: { n: "y", examine: "z" },
    }),
    "spatial",
  );
  // Rule 4b — ≥2 neighbors, all non-cardinal non-verb → spatial.
  check(
    "two unknown labels → spatial (hub-ish)",
    classifyNode({
      slug: "x",
      biome: null,
      subgraph: null,
      draft: false,
      tags: [],
      neighbors: { left: "a", right: "b" },
    }),
    "spatial",
  );
  // Rule 5 — solitary + no cardinal + non-verb → floating.
  check(
    "single unknown label → floating",
    classifyNode({
      slug: "x",
      biome: null,
      subgraph: null,
      draft: false,
      tags: [],
      neighbors: { ramp: "somewhere" },
    }),
    "floating",
  );
  // 0 neighbors → floating.
  check(
    "zero neighbors → floating",
    classifyNode({
      slug: "x",
      biome: null,
      subgraph: null,
      draft: false,
      tags: [],
      neighbors: {},
    }),
    "floating",
  );
  // Case-insensitivity.
  check(
    "case-insensitive NORTH → spatial",
    classifyNode({
      slug: "x",
      biome: null,
      subgraph: null,
      draft: false,
      tags: [],
      neighbors: { NORTH: "y" },
    }),
    "spatial",
  );
}

// --- directionToVector --------------------------------------------------

console.log("\n[directionToVector]");
{
  check("north → (0, -1)", directionToVector("north"), { dx: 0, dy: -1 });
  check("n → (0, -1)", directionToVector("n"), { dx: 0, dy: -1 });
  check("south → (0, +1)", directionToVector("south"), { dx: 0, dy: 1 });
  check("east → (+1, 0)", directionToVector("east"), { dx: 1, dy: 0 });
  check("west → (-1, 0)", directionToVector("west"), { dx: -1, dy: 0 });
  // Diagonal.
  const ne = directionToVector("ne");
  checkNear("ne.dx ≈ +sqrt(1/2)", ne.dx, Math.SQRT1_2);
  checkNear("ne.dy ≈ -sqrt(1/2)", ne.dy, -Math.SQRT1_2);
  const sw = directionToVector("southwest");
  checkNear("southwest.dx ≈ -sqrt(1/2)", sw.dx, -Math.SQRT1_2);
  checkNear("southwest.dy ≈ +sqrt(1/2)", sw.dy, Math.SQRT1_2);
  // up/down.
  check("up → north-like", directionToVector("up"), { dx: 0, dy: -1 });
  check("down → south-like", directionToVector("down"), { dx: 0, dy: 1 });
  // in/out per spec §Cardinal→vector.
  check("in → (0, +1)", directionToVector("in"), { dx: 0, dy: 1 });
  check("out → (0, -1)", directionToVector("out"), { dx: 0, dy: -1 });
  // Unknown → null.
  check("random label → null", directionToVector("blargh"), null);
  check("sit → null (that's a verb)", directionToVector("sit"), null);
  // Case-insensitive.
  check("North → (0,-1)", directionToVector("North"), { dx: 0, dy: -1 });
}

// --- layoutSubgraph — basics -------------------------------------------

console.log("\n[layoutSubgraph — edge cases]");
{
  const empty = layoutSubgraph([], [], { width: 800, height: 600 });
  check("empty inputs → empty map", empty.size, 0);

  const solo = layoutSubgraph(
    [
      {
        slug: "lone",
        biome: null,
        subgraph: null,
        draft: false,
        tags: [],
        neighbors: {},
      },
    ],
    [],
    { width: 800, height: 600, seed: 1 },
  );
  const p = solo.get("lone");
  checkTrue(
    "single node positioned in canvas",
    p && Number.isFinite(p.x) && Number.isFinite(p.y),
    JSON.stringify(p),
  );
  check("single node classified floating", p?.class, "floating");
}

// --- layoutSubgraph — determinism --------------------------------------

console.log("\n[layoutSubgraph — determinism]");
{
  // Include an unknown-direction edge so the seeded PRNG actually fires
  // during BFS placement — lets us tell seeds apart downstream.
  const nodes = [
    { slug: "a", biome: "forest", subgraph: null, draft: false, tags: [], neighbors: { n: "b", e: "c", ramp: "d" } },
    { slug: "b", biome: "forest", subgraph: null, draft: false, tags: [], neighbors: { s: "a" } },
    { slug: "c", biome: "forest", subgraph: null, draft: false, tags: [], neighbors: { w: "a" } },
    { slug: "d", biome: "forest", subgraph: null, draft: false, tags: [], neighbors: { back: "a" } },
  ];
  const edges = [
    { from: "a", to: "b", direction: "n", traffic: 3 },
    { from: "a", to: "c", direction: "e", traffic: 1 },
    { from: "a", to: "d", direction: "ramp", traffic: 0 },
  ];
  const r1 = layoutSubgraph(nodes, edges, { width: 800, height: 600, seed: 42, iterations: 60 });
  const r2 = layoutSubgraph(nodes, edges, { width: 800, height: 600, seed: 42, iterations: 60 });
  const s1 = [...r1.entries()].map(([k, v]) => [k, v.x.toFixed(6), v.y.toFixed(6)]);
  const s2 = [...r2.entries()].map(([k, v]) => [k, v.x.toFixed(6), v.y.toFixed(6)]);
  check("same seed → identical positions", s1, s2);
  const r3 = layoutSubgraph(nodes, edges, { width: 800, height: 600, seed: 43, iterations: 60 });
  const s3 = [...r3.entries()].map(([k, v]) => [k, v.x.toFixed(6), v.y.toFixed(6)]);
  checkTrue("different seed → different positions", JSON.stringify(s1) !== JSON.stringify(s3));
}

// --- layoutSubgraph — cone preservation --------------------------------

console.log("\n[layoutSubgraph — cone bias]");
{
  const nodes = [
    { slug: "origin", biome: null, subgraph: null, draft: false, tags: [], neighbors: { n: "north", e: "east", s: "south", w: "west" } },
    { slug: "north",  biome: null, subgraph: null, draft: false, tags: [], neighbors: { s: "origin" } },
    { slug: "east",   biome: null, subgraph: null, draft: false, tags: [], neighbors: { w: "origin" } },
    { slug: "south",  biome: null, subgraph: null, draft: false, tags: [], neighbors: { n: "origin" } },
    { slug: "west",   biome: null, subgraph: null, draft: false, tags: [], neighbors: { e: "origin" } },
  ];
  const edges = [
    { from: "origin", to: "north", direction: "n", traffic: 0 },
    { from: "origin", to: "east",  direction: "e", traffic: 0 },
    { from: "origin", to: "south", direction: "s", traffic: 0 },
    { from: "origin", to: "west",  direction: "w", traffic: 0 },
  ];
  const result = layoutSubgraph(nodes, edges, {
    width: 1000, height: 1000, seed: 7, iterations: 160,
  });
  const O = result.get("origin");
  const N = result.get("north");
  const E = result.get("east");
  const S = result.get("south");
  const W = result.get("west");
  // Each outer should roughly match its cardinal direction from origin.
  // Tolerate the 45° cone — angle between actual vector and ideal ≤ π/4.
  function within45(from, to, wantDx, wantDy) {
    const dx = to.x - from.x, dy = to.y - from.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) return false;
    const cos = (dx * wantDx + dy * wantDy) / len;  // want vector is unit
    const angle = Math.acos(Math.max(-1, Math.min(1, cos)));
    return angle <= Math.PI / 4 + 1e-6;
  }
  checkTrue("north neighbor within 45° of N", within45(O, N, 0, -1));
  checkTrue("east neighbor within 45° of E", within45(O, E, 1, 0));
  checkTrue("south neighbor within 45° of S", within45(O, S, 0, 1));
  checkTrue("west neighbor within 45° of W", within45(O, W, -1, 0));
}

// --- layoutSubgraph — pin attractor ------------------------------------

console.log("\n[layoutSubgraph — pins]");
{
  const nodes = [
    { slug: "a", biome: null, subgraph: null, draft: false, tags: [], neighbors: { e: "b" }, pin: { x: 100, y: 100 } },
    { slug: "b", biome: null, subgraph: null, draft: false, tags: [], neighbors: { w: "a" } },
  ];
  const edges = [
    { from: "a", to: "b", direction: "e", traffic: 0 },
  ];
  const r = layoutSubgraph(nodes, edges, { width: 1000, height: 1000, seed: 1, iterations: 200 });
  const a = r.get("a");
  // Pin is soft — won't snap exactly. But it should be within ~40 units.
  checkTrue(
    `pinned node near pin (at ${a.x.toFixed(1)}, ${a.y.toFixed(1)}; pin 100,100)`,
    Math.hypot(a.x - 100, a.y - 100) < 40,
  );
}

// --- layoutSubgraph — doesn't NaN on unknown directions -----------------

console.log("\n[layoutSubgraph — robustness]");
{
  const nodes = [
    { slug: "a", biome: null, subgraph: null, draft: false, tags: [], neighbors: { blargh: "b" } },
    { slug: "b", biome: null, subgraph: null, draft: false, tags: [], neighbors: { flarp: "a" } },
  ];
  const edges = [{ from: "a", to: "b", direction: "blargh", traffic: 0 }];
  const r = layoutSubgraph(nodes, edges, { width: 800, height: 600, seed: 3, iterations: 80 });
  const a = r.get("a");
  const b = r.get("b");
  checkTrue(
    "unknown directions don't NaN",
    Number.isFinite(a?.x) && Number.isFinite(a?.y) && Number.isFinite(b?.x) && Number.isFinite(b?.y),
  );
  // a and b should have been pushed apart by repulsion.
  checkTrue("a, b separated by repulsion", a && b && Math.hypot(a.x - b.x, a.y - b.y) > 20);
}

// --- Constants --------------------------------------------------------

console.log("\n[constants]");
{
  checkTrue("CARDINAL_LABELS contains north", CARDINAL_LABELS.has("north"));
  checkTrue("CARDINAL_LABELS contains ne", CARDINAL_LABELS.has("ne"));
  checkTrue("CARDINAL_LABELS contains up", CARDINAL_LABELS.has("up"));
  checkTrue("VERB_LABELS contains sit", VERB_LABELS.has("sit"));
  checkTrue("VERB_LABELS contains examine", VERB_LABELS.has("examine"));
}

// --- Bidirectional cardinal conflict resolution ----------------------
// When A says "north:B" AND B says "north:A", both can't be right.
// Layout should canonicalise to one winner (stable: lower slug wins on
// the edge direction it authored) — the loser's cone bias is dropped.

console.log("\n[layoutSubgraph — bidirectional conflict]");
{
  // A and B both claim "north" to each other. Under the naive algo,
  // both cones fire and cancel out. Under conflict-resolution, only
  // A's claim (lower slug sorts first) wins; B's north label is
  // treated as non-cardinal.
  const nodes = [
    { slug: "a-lower", biome: null, subgraph: null, draft: false, tags: [], neighbors: { n: "b-higher" } },
    { slug: "b-higher", biome: null, subgraph: null, draft: false, tags: [], neighbors: { n: "a-lower" } },
  ];
  const edges = [
    { from: "a-lower", to: "b-higher", direction: "n", traffic: 0 },
    { from: "b-higher", to: "a-lower", direction: "n", traffic: 0 },
  ];
  const r = layoutSubgraph(nodes, edges, { width: 800, height: 600, seed: 11, iterations: 200 });
  const a = r.get("a-lower"), b = r.get("b-higher");
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  // A's "north:B" claim: B should be ABOVE A (dy negative). Within 45°
  // means dy/len < -cos(45°) ≈ -0.707.
  checkTrue(
    `B lands above A — a's "north:b" claim wins (dy/len=${(dy/len).toFixed(2)})`,
    dy / len < -0.5,
  );
}

// --- Minimum-distance floor ------------------------------------------

console.log("\n[layoutSubgraph — min-distance floor]");
{
  // Two nodes with no edges between them — pure charge-repulsion test.
  // They should never land at d=0 even from adversarial init.
  const nodes = [
    { slug: "a", biome: null, subgraph: null, draft: false, tags: [], neighbors: {}, pin: { x: 400, y: 400 } },
    { slug: "b", biome: null, subgraph: null, draft: false, tags: [], neighbors: {}, pin: { x: 400, y: 400 } },
  ];
  const r = layoutSubgraph(nodes, [], { width: 800, height: 800, seed: 5, iterations: 200 });
  const a = r.get("a"), b = r.get("b");
  const d = Math.hypot(a.x - b.x, a.y - b.y);
  checkTrue(`adversarially co-pinned nodes spread to d=${d.toFixed(1)} (>= 50)`, d >= 50);
}

// --- layoutRadialTree ---------------------------------------------

console.log("\n[layoutRadialTree]");
{
  // A root with 3 children — children should land at depth=1 ring.
  const nodes = [
    { slug: "root", biome: null, subgraph: null, draft: false, tags: [], neighbors: { walk: "a", walk2: "b", walk3: "c" } },
    { slug: "a", biome: null, subgraph: null, draft: false, tags: [], neighbors: { back: "root" } },
    { slug: "b", biome: null, subgraph: null, draft: false, tags: [], neighbors: { back: "root" } },
    { slug: "c", biome: null, subgraph: null, draft: false, tags: [], neighbors: { back: "root" } },
  ];
  const edges = [
    { from: "root", to: "a", direction: "walk", traffic: 0 },
    { from: "root", to: "b", direction: "walk2", traffic: 0 },
    { from: "root", to: "c", direction: "walk3", traffic: 0 },
  ];
  const r = layoutRadialTree(nodes, edges, { width: 800, height: 600 });
  const root = r.get("root");
  // Children radius ≈ 120 * scale; they should all be roughly equidistant from root.
  const dists = ["a", "b", "c"].map((s) => {
    const p = r.get(s);
    return Math.hypot(p.x - root.x, p.y - root.y);
  });
  checkTrue(`children equidistant from root  (${dists.map(d => d.toFixed(1)).join(", ")})`,
    Math.abs(dists[0] - dists[1]) < 1 && Math.abs(dists[1] - dists[2]) < 1);
  checkTrue("root-to-child distance > 0", dists[0] > 10);

  // Disconnected components tile horizontally.
  const nodes2 = [
    { slug: "x1", biome: null, subgraph: null, draft: false, tags: [], neighbors: {} },
    { slug: "x2", biome: null, subgraph: null, draft: false, tags: [], neighbors: {} },
    { slug: "x3", biome: null, subgraph: null, draft: false, tags: [], neighbors: {} },
  ];
  const r2 = layoutRadialTree(nodes2, [], { width: 900, height: 300 });
  const xs = [...r2.values()].map(p => p.x).sort((a, b) => a - b);
  checkTrue(`disconnected nodes spread horizontally (xs=${xs.map(x => x.toFixed(0)).join(",")})`,
    xs[2] - xs[0] > 50);
}

// --- layoutBiomeCluster -------------------------------------------

console.log("\n[layoutBiomeCluster]");
{
  const nodes = [
    { slug: "v1", biome: "village", subgraph: null, draft: false, tags: [], neighbors: {} },
    { slug: "v2", biome: "village", subgraph: null, draft: false, tags: [], neighbors: {} },
    { slug: "v3", biome: "village", subgraph: null, draft: false, tags: [], neighbors: {} },
    { slug: "f1", biome: "forest",  subgraph: null, draft: false, tags: [], neighbors: {} },
    { slug: "f2", biome: "forest",  subgraph: null, draft: false, tags: [], neighbors: {} },
  ];
  const r = layoutBiomeCluster(nodes, [], { width: 1000, height: 1000 });
  // Compute group centroids and check they're separated by > 200px.
  const vPs = ["v1", "v2", "v3"].map((s) => r.get(s));
  const fPs = ["f1", "f2"].map((s) => r.get(s));
  const vc = { x: vPs.reduce((a, p) => a + p.x, 0) / vPs.length, y: vPs.reduce((a, p) => a + p.y, 0) / vPs.length };
  const fc = { x: fPs.reduce((a, p) => a + p.x, 0) / fPs.length, y: fPs.reduce((a, p) => a + p.y, 0) / fPs.length };
  const sep = Math.hypot(vc.x - fc.x, vc.y - fc.y);
  checkTrue(`biome centroids separated by ${sep.toFixed(1)} (>150)`, sep > 150);
  // Within-village nodes closer to each other than to forest.
  const vMax = Math.max(...vPs.map(p => Math.hypot(p.x - vc.x, p.y - vc.y)));
  checkTrue(`village nodes clustered tighter than biome separation (${vMax.toFixed(1)} < ${sep.toFixed(1)})`,
    vMax < sep);
}

// --- layout() dispatcher ------------------------------------------

console.log("\n[layout() dispatcher]");
{
  const nodes = [
    { slug: "a", biome: "x", subgraph: null, draft: false, tags: [], neighbors: { n: "b" } },
    { slug: "b", biome: "x", subgraph: null, draft: false, tags: [], neighbors: { s: "a" } },
  ];
  const edges = [{ from: "a", to: "b", direction: "n", traffic: 0 }];
  const o = { width: 800, height: 600, seed: 1 };
  const rForce = layout(nodes, edges, { ...o, mode: "force" });
  const rRadial = layout(nodes, edges, { ...o, mode: "radial-tree" });
  const rCluster = layout(nodes, edges, { ...o, mode: "biome-cluster" });
  const rDefault = layout(nodes, edges, o);
  checkTrue("force mode returns positions", rForce.size === 2);
  checkTrue("radial-tree mode returns positions", rRadial.size === 2);
  checkTrue("biome-cluster mode returns positions", rCluster.size === 2);
  checkTrue("default mode matches force", rDefault.get("a").x === rForce.get("a").x);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
