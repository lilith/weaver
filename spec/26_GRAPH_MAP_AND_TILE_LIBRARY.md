# Weaver — Graph Map + Pixel Tile Library

**Status:** Sessions 1–5 shipped (2026-04-20). Session 6 — batch library seed — pending.
**Flag:** `flag.graph_map` (default off). Flip on per-world once `style_tag` is bound and ≥10 library tiles exist.
**Feasibility:** single-family-instance scale — ≤ 1K locations per world, ≤ 200 tiles in library per style. Force sim runs client-side, ≤ 500ms to settle.
**Supersedes:** the grid-based `/map/[world]` shipped in `385cccc`. The grid path still loads when `flag.graph_map = off`; retiring it entirely is post-Session-6.

## What shipped (Sessions 1–5)

- **Layer 1 — pure engine.** `packages/engine/src/graph-layout/` with `classifyNode`, `directionToVector`, `layoutSubgraph` (seeded force sim + cone bias + soft pins + subgraph clustering + BFS seed). 41 unit tests in `scripts/graph-layout-tests.mjs`. Exposed via `@weaver/engine/graph-layout`.
- **Layer 2 — data plane.** `convex/graph.ts` — `loadGraphMap` (one-round-trip bundle), `pinNodePosition` / `unpinNode` (member-gated), `incrementEdgeTraffic` (internal; fired from `locations.applyOption` on every cross-location transition). Schema adds `entities.map_shape / subgraph / map_hint` and new tables `map_pins` + `edge_traffic`.
- **Layer 3 — UI.** `apps/play/src/lib/map-graph/GraphMap.svelte` — SVG canvas, pan+zoom, drag-to-pin, tap-to-goto, right-click context menu, live `useQuery(api.graph.loadGraphMap)`. `/map/[world]` routes to graph or grid based on `flag.graph_map`.
- **Layer 4 — Haiku picker + CLI.** `convex/tile_picker.ts` with `pickTileForLocation` (owner-only action), `backfillWorldTiles` (owner-only batch), `setMapHint` (owner-only). `weaver tile {styles,bind,binding,pick,backfill,hint}` subcommands wire the whole surface to the CLI.
- **Layer 5 — isolation + typecheck.** 7 new adversarial Playwright tests (35 total now pass). svelte-check: 0 errors / 0 warnings. Convex tsc clean. Gameplay-sweep 38/38.

## One-paragraph summary

The world is a graph of locations, not a grid of tiles. The map view renders that graph — force-directed, but biased toward the cardinal-direction labels authors write on neighbor edges so a "north" path still points north. Locations branch into **spatial** nodes (intersections, dead-ends with content) and **action** chips (read-a-book, sit-on-bench — attached to their parent, no layout cost). Locations with the same biome cluster implicitly. The visual layer reads from a **cross-world tile library** of pixellab-generated pixel art, where each world picks a `style_tag` and gets deterministic or owner-pinned assignments per location, character, and decoration. AI (Haiku) chooses from the library on first-visit; generates new tiles with a relative-position suggestion when nothing fits.

## Layered contracts

The implementation sits across three packages. Every contract is intentional; refactors should stay inside layer boundaries.

### Layer 1: `packages/engine/src/graph-layout/` — pure

No Convex imports, no Svelte, no DOM. Unit-testable with plain Node.

```ts
export type NodeClass = "spatial" | "action" | "floating";

export type GraphNode = {
  slug: string;
  biome: string | null;
  subgraph: string | null;      // authored override; else biome
  map_shape?: "spatial" | "action" | "floating";  // authored override
  draft: boolean;
  tags: string[];
  neighbors: Record<string, string>;  // direction → neighbor slug
  pin?: { x: number; y: number };     // user-dragged authoritative position
};

export type GraphEdge = {
  from: string;
  to: string;
  direction: string;
  traffic: number;              // 0-N, crossings counted
};

export type LayoutOptions = {
  width: number;
  height: number;
  iterations?: number;          // default 120
  intraSubgraphAttraction?: number;     // default 0.5
  interSubgraphAttraction?: number;     // default 0.08
  cardinalBiasStrength?: number;        // default 0.8
  coneAngleRad?: number;                // default Math.PI / 4  (45 deg)
  pinPullStrength?: number;             // default 1.5
};

export type LayoutResult = Map<string, { x: number; y: number; class: NodeClass }>;

export function classifyNode(node: GraphNode): NodeClass;
export function directionToVector(label: string): { dx: number; dy: number } | null;
export function layoutSubgraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  opts: LayoutOptions,
): LayoutResult;
```

**Classification rules** (for `classifyNode`, in priority order):

1. If `node.map_shape` is set, return it.
2. If `node.draft === true` and `node.neighbors` has exactly 1 key AND the parent links back via a verb label → `action`.
3. If every neighbor label is a verb (see `VERB_LABELS` constant) → `action`.
4. If ≥1 neighbor label is cardinal-ish (see `CARDINAL_LABELS`) OR `node.neighbors` count ≥ 2 → `spatial`.
5. Else → `floating`.

**Cardinal set:** `n,s,e,w,north,south,east,west,ne,nw,se,sw,northeast,northwest,southeast,southwest,up,down,in,out`. Case-insensitive.

**Verb set:** default `read,talk,use,examine,search,pick,study,sit,listen,watch,smell,taste,touch,drink,eat,open,close,wait`. Authors can extend via `packages/engine/verb_labels.json`.

**Cardinal → vector** (unit vectors in screen coords: x right, y **down**):

```
north:  (0, -1)   south:  (0, +1)
east:   (+1, 0)   west:   (-1, 0)
ne:     (+√½, -√½)   (etc., 45° diagonals)
up:     (0, -1)   down:   (0, +1)  (treated same as N/S)
in:     (0, +1)   out:    (0, -1)  (pull toward/away from center)
```

**Force model** (per iteration):

- Charge repulsion between all nodes: `f = -k_charge / d²`, standard.
- Edge spring: rest length = `edgeBaseLength` × (1 for cardinal, 1.5 for verb/non-directional).
- **Cone penalty** (cardinal-bias): for each edge with a cardinal direction, measure the angle between the current `to - from` vector and `directionToVector(label)`. If angle > `coneAngleRad`, apply a corrective force of magnitude `cardinalBiasStrength × sin(excess_angle)` perpendicular to the current edge vector. **Inside the cone, no force is applied** — nodes move freely within 45° of the authored direction.
- **Pin attractor**: for each pinned node, apply `f = pinPullStrength × (pin - currentPos)`. Pins are soft — strong spring, not a hard lock.
- **Subgraph clustering**: nodes in the same subgraph get an extra weak attraction toward their subgraph's centroid.
- Damping: velocity × 0.85 per iteration. Stop when max velocity < epsilon or iterations hit.

**Initial positions** for the first run (no pins): place one node of the largest subgraph at origin; BFS outward from it, placing each child at `parent + directionToVector(edge) × edgeBaseLength`. Unknown directions get a random jitter in a radial band. This gives the force sim a good starting condition that already respects direction labels.

### Layer 2: `convex/graph.ts` — data plane

Depends on: `packages/engine/graph-layout` (pure — safe to import).

```ts
// Queries
export const loadGraphMap: query<
  { session_token: string; world_slug: string },
  MapBundle
>;

export type MapBundle = {
  world: { id, slug, name, style_tag: string | null };
  subgraphs: Array<{ slug: string; display_name: string; tint: string | null }>;
  nodes: Array<{
    slug: string;
    name: string;
    biome: string | null;
    subgraph: string;
    map_shape: NodeClass;
    draft: boolean;
    parent_slug: string | null;      // for action nodes
    tile_url: string | null;         // from library or entity_art_renderings
    pin: { x: number; y: number } | null;
  }>;
  edges: Array<{
    from: string; to: string; direction: string; traffic: number;
  }>;
};

// Mutations
export const pinNodePosition: mutation<
  { session_token; world_slug; slug; x: number; y: number },
  { pinned: true }
>;

export const unpinNode: mutation<
  { session_token; world_slug; slug },
  { pinned: false }
>;

// Internal helper — called by applyOption on every movement
export async function incrementEdgeTraffic(
  ctx, branch_id, from_slug, to_slug,
): Promise<void>;
```

**Schema additions:**

- `entities.map_shape: "spatial" | "action" | "floating" | null` (optional) — authored override.
- `entities.subgraph: v.optional(v.string())` — authored override; falls back to biome.
- `entities.map_hint: v.optional(v.any())` — AI-generated `{ dx?, dy?, descriptor? }` at first-gen. Informs initial layout + prompt.

- `map_pins` table (per-world shared; owner drag authoritative):
  ```
  world_id, branch_id, slug, x, y, pinned_by_user_id, pinned_at
  index by_world_branch (world_id, branch_id)
  index by_world_slug (world_id, slug)
  ```

- `edge_traffic` table:
  ```
  branch_id, from_slug, to_slug, crossings, last_crossed_at
  index by_branch_edge (branch_id, from_slug, to_slug)
  ```

### Layer 3: `apps/play/src/lib/map-graph/` — UI

Depends on: `convex/graph` (via Convex reactive client). No direct engine import required (layout runs client-side from the `MapBundle` using a thin re-export of `layoutSubgraph` via `@weaver/engine/graph-layout`).

**`<GraphMap data={bundle} character_slug? />`** — stateless-ish Svelte 5 component.

Rendering contract:

- SVG canvas, pan + zoom (pointer events), pinch-zoom on touch.
- Runs `layoutSubgraph` once per subgraph on mount. Uses `requestIdleCallback` to iterate the force sim so the first paint doesn't block.
- Spatial node = rounded rect (96×96 on desktop, 72×72 on mobile) with tile art + name strip.
- Action chip = pill anchored to parent, radiused around the parent by 48px with small offset animation.
- Edge = bezier between node centers. Stroke opacity = `0.2 + 0.6 × min(1, traffic/10)`. Color hue = stable hash(subgraph).
- Draft node dimmed to 0.55 opacity.
- Tap node → `goto('/play/[world]/[slug]')`.
- Drag node → ghost + call `pinNodePosition` on drop. Force sim picks up the new pin next frame.
- Long-press node → context menu: "Release pin", "Open", "Open in play", "Regen tile".

**Reactive data** — use `useQuery(api.graph.loadGraphMap, ...)` so pin mutations propagate live across family members.

## Pixel tile library

### Table shape

`tile_library` + `world_style_bindings` already shipped in the working tree (this spec's first session). See `convex/schema.ts` and `convex/tile_library.ts` for the authoritative types. Briefly:

- One library row = one pixel asset (PNG bytes in R2, hashed).
- `kind: "biome_tile" | "building" | "path" | "bridge" | "portrait" | "map_object" | "character_walk" | "misc"`. For the graph map, the dominant kind is `portrait` (per-location place portrait, transparent 128×128) + `map_object` (decorations) + `character_walk` (party sprites later). `biome_tile` / `path` / `bridge` are deprioritised for graph view but stay supported for a future grid-style detail view.
- `style_tag`: one string per coherent aesthetic. Target handful: `cozy-watercolor-pixel`, `grim-corporate-pixel`, `classic-fantasy-pixel`, `dreamy-pastel-pixel`.
- `world_style_bindings.style_tag` binds a world to one style pool.

### Pick / generate decision (AI-assisted)

On first-visit of a canonical location (or explicit admin "backfill"):

1. Load context: bible tone + style_anchor, location name + biome + description + parent name + direction-from-parent, player's character id, existing library catalog filtered by world.style_tag (just names + subjects, not bytes).
2. Haiku call returns one of:
   - `{ action: "pick", tile_id, reason }` — reuse an existing tile from the library.
   - `{ action: "generate", kind, descriptor, relative_direction?, relative_distance? }` — gen a new one. `relative_direction` is a cardinal suggestion (how the location sits vs parent); `relative_distance` is a rough "near / mid / far" which maps to initial-layout edge length.
3. If `generate`: fire a pixellab MCP call (author-orchestrated — I run these) producing a tile; ingest via `tile_library.ingestPixellabAsset`; stamp `entities.map_hint = { relative_direction, relative_distance, descriptor }`.
4. Bind result: write `world_style_bindings.entity_overrides[slug] = tile_id`.

Prompt budget: ~500 input (context + ≤40 catalog slugs) + ~120 output ≈ $0.0005 per first-visit. Cheap.

### Pixellab call shape

- For `portrait`: `mcp__pixellab__create_map_object` with `description: <haiku-written descriptor>`, `width: 128, height: 128`, `view: "high top-down"`, `inpainting: null` (standalone). ~30s async.
- For `character_walk`: `mcp__pixellab__create_character` with a descriptor and directional rotation set. ~90s async.
- For `map_object` decorations batches: `mcp__pixellab__create_tiles_pro` with numbered prompt ("1). rock 2). tree 3). lamp"). ~15-30s async.
- For `biome_tile` (deprioritised for graph map but useful for terrain-flavor overlays behind nodes): `mcp__pixellab__create_topdown_tileset` with ocean→beach style transitions. ~100s async.

All pixellab calls are async — we get a job id, poll, download N tiles from B2 URLs, ingest each as a library row. The ingest action (`tile_library.ingestPixellabAsset`) takes base64 PNG bytes + metadata and uploads to R2 + writes a row.

### Dedup + versioning

- `tile_library.by_blob_hash` index makes ingest idempotent — same bytes = same row.
- Regenerating an entity's portrait bumps version (same name + kind + style_tag). Prior active flips to inactive; pin stays valid only if pointing at the new version (handled by `insertRow` logic).
- Library rows never mutate — they append. Rollback = activate a prior version.

## Traffic data

Every `applyOption` mutation that transitions a character to a new location calls `incrementEdgeTraffic(ctx, branch_id, from_slug, to_slug)`. Cheap insert-or-patch; cap display at `min(1, traffic/10)` opacity so a well-trafficked path shows clearly without domination.

Weekly cron GCs edges with `crossings == 0 && last_crossed_at < 60d`. Edges with traffic always keep.

## User drag behaviour

- Owner or any member may drag in v1 (single-family trust model). Drag-end writes to `map_pins`. Pin is per (world, branch, slug) — shared.
- Simulation treats pins as strong but soft attractors — `f_pin = 1.5 × (target - current)`. If two pins conflict (pathological), force sim settles between them.
- Long-press → "Release pin" restores to the force-solved position.
- On **era advance** or **bible rewrite**, pins persist but a Haiku call evaluates whether the existing layout still makes sense; if a subgraph's semantic shifted, AI can suggest a layout reset. Owner approves.

## Feasibility notes

- **45° cone preservation test.** Author-labeled directions occasionally conflict (A says "north to B", B says "north to A"). The classifier logs this to `runtime_bugs` and prefers the first-seen direction. After a few playtests: if conflicts bleed, consider making neighbor labels authoritative only from the higher-ordered location (stable sort by slug).
- **Layout determinism.** Force sim with a fixed seed + same inputs = same output. Seed from `branch_id` so family members see the same layout pre-pin.
- **Mobile perf.** 100-node subgraph with 150 edges settles in ~200ms on a mid-range phone using idle callbacks. Tested on existing worlds, which cap near 60 locations.
- **Subgraph scale.** If a world grows past ~10 subgraphs, render culling becomes important; defer until a world actually hits that size.

## Session handoff (what to do next)

- Session 1 ✅ spec + schema + ingest action + one test tileset in-hand.
- Session 2 ✅ Layer 1 (engine graph-layout module) + 41 unit tests.
- Session 3 ✅ Layer 2 (convex/graph.ts) + schema migration + `incrementEdgeTraffic` in `applyOption`.
- Session 4 ✅ Layer 3 (`<GraphMap>`) + `/map/[world]` routes behind `flag.graph_map`.
- Session 5 ✅ Haiku picker (`convex/tile_picker.ts`) + owner-only CLI (`weaver tile …`) + 7 isolation tests.
- Session 6 ⏳ batch-seed the real library — `cozy-watercolor-pixel` 60 assets, `grim-corporate-pixel` 60 assets, `classic-fantasy-pixel` 60 assets. Ingest. Bind Quiet Vale to cozy, The Office to grim. This is author-orchestrated (pixellab MCP + ingestPixellabAsset); main agent doesn't generate pixel art.

Each session lands in its own commit(s). The contracts in Layers 1–3 are what keep the pieces replaceable.

## Open questions (to decide during implementation)

- Per-user pin overrides (each family member's private layout)? Not in v1 — shared is simpler and matches single-instance-per-family.
- `subgraph:` explicit field vs. always-implicit-from-biome? Add the field now (schema cheap) so we have the escape hatch, but populate from biome by default.
- Inter-subgraph edges — render as dashed vs portal glyphs? Start with dashed; promote to portal-glyph only if a subgraph ends up screen-distant.
- Pixellab rate limits — haven't tested N concurrent requests. Document behaviour during the Session-6 batch and add a queue in `convex/pixellab.ts` if needed.
