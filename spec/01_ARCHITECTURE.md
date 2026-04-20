# Weaver — Architecture

## Three execution paths, one store

Every location, NPC, and encounter is rendered by one of three paths. The runtime detects which on load and dispatches.

```
┌─────────────────────┐
│  Pure JSON location │ ← 95% of content. Template render. No runtime.
└─────────────────────┘
           │
           ▼
┌─────────────────────┐
│   Inline script     │ ← 4%. Tiny interpreter. Pure function.
└─────────────────────┘
           │
           ▼
┌─────────────────────┐
│   Durable module    │ ← 1%. Event-sourced workflow. Capability-sandboxed.
└─────────────────────┘
           │
           ▼
     entities / components / relations store (Convex)
```

The store is common. What differs is how behavior reaches the store.

## Blob storage (foundational)

Every durable payload in Weaver — location JSON, inline script source, world bible, theme JSON, image bytes, module source — is stored as an **immutable, content-addressed blob** (BLAKE3 hash → bytes). Mutable heads tables (entities, components, `artifact_versions`, etc.) carry `blob_hash` pointers, not inline payloads.

See `12_BLOB_STORAGE.md` for the full design. Summary of consequences that ripple through the rest of this document:

- Identical payloads deduplicate (two users edit to the same final text → one blob).
- Version rollback is a pointer update; no payload copy.
- Branch forks duplicate heads rows, not content (see §"Branches and forking").
- Time travel to any prior state is just repointing heads to prior `blob_hash` values.
- Durable backup: the blob store is append-only; point-in-time restore replays heads to a timestamp.

## The store — entity/component/relation

Three Convex tables, schemaless payloads validated per-module by Zod.

```ts
// convex/schema.ts
import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"

export default defineSchema({
  entities: defineTable({
    type: v.string(),              // "location" | "character" | "npc" | "item" | "encounter" | "ref" | "theme" | ...
    branch_id: v.id("branches"),
    world_id: v.id("worlds"),
    version: v.number(),
    schema_version: v.number(),
    author_user_id: v.optional(v.id("users")),
    author_pseudonym: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
  }).index("by_branch_type", ["branch_id", "type"])
    .index("by_world_type", ["world_id", "type"]),

  components: defineTable({
    entity_id: v.id("entities"),
    component_type: v.string(),    // "location_data" | "character_ref" | "chat_state" | ...
    payload: v.any(),              // validated at module boundary
    schema_version: v.number(),
  }).index("by_entity_type", ["entity_id", "component_type"])
    .index("by_type", ["component_type"]),

  relations: defineTable({
    subject_id: v.id("entities"),
    predicate: v.string(),         // "fed_doe" | "owns" | "knows_secret" | ...
    object_id: v.id("entities"),
    payload: v.optional(v.any()),  // e.g., {bond: 0.3, on_day: 47}
    version: v.number(),
  }).index("by_subject_pred", ["subject_id", "predicate"])
    .index("by_object_pred", ["object_id", "predicate"])
    .index("by_predicate", ["predicate"]),

  // supporting tables covered in other docs:
  // users, branches, worlds, events (event log), versions (rollback),
  // mentorship_log, chat_messages, art_queue, themes, world_bible
})
```

Schemaless payloads + typed component_types means new modules add component types without migrations. Every payload is validated by a Zod schema the module ships with its manifest.

**Payload storage.** Component and artifact-version payloads above 4 KB live as content-addressed blobs; the heads rows carry a `blob_hash` referencing canonicalized bytes (see `12_BLOB_STORAGE.md`). Small inline payloads (≤4 KB) can stay in the row via the `payload` field for hot-path reads; large ones (location JSON with long prose, theme JSON, image bytes) always resolve through the blob store. This is what enables cheap branching, deduplication, and rollback-as-pointer-update throughout the rest of this document.

## Path 1 — pure JSON location (the default)

A location with no behavior beyond rendering, offering options, and updating simple state. See `02_LOCATION_SCHEMA.md` for full schema.

```json
{
  "id": "forest_clearing_42",
  "type": "location",
  "biome": "forest",
  "description_template": "You stand in a small clearing. {{time_of_day}} light filters through the trees. {{#if weather.rain}}Rain patters against the leaves.{{/if}}",
  "options": [
    {"label": "Examine the old stump", "effect": [{"set": ["this.stump_examined", true]}, {"say": "The stump is older than any living memory."}]},
    {"label": "Head deeper into the forest", "target": "forest_deep_17"},
    {"label": "Return to the village", "target": "village_square"}
  ],
  "on_enter": [{"inc": ["character.location_visits", 1]}],
  "art_ref": "ref_forest_clearing_42",
  "author_pseudonym": "Stardust",
  "discovered_by": "user_jason",
  "safe_anchor": false
}
```

**Render path:** read entity → read `location_data` component → run template interpolation → render options. Zero runtime, zero code eval. Renders in <5ms on Convex.

**Author experience:** browser form designer or AI generates JSON directly. AI generations validated against Zod schema before insert.

## Path 2 — inline script

Used when templating isn't enough (conditional branches, random encounters, small stateful logic). See `03_INLINE_SCRIPT.md` for the grammar.

```
p "You approach the merchant's stall."

if not character.inventory.has("snowglobe") then
  p "He smiles knowingly."
  choose {
    "Examine the snowglobe": examine_globe,
    "Ignore him": leave
  }
else
  p "The merchant nods, recognizing the globe."
  goto "merchant_dialogue_post_globe"
end
```

**Render path:** read entity → read `inline_script` component → evaluate interpreter against current state → produce (text, options, effects). Pure function, fully replayable, fully testable as unit fixtures.

**Runtime:** TypeScript interpreter, ~300 LOC, no `eval`, no `Function`, no prototype access. Executes server-side in a Convex query or mutation.

## Path 3 — durable module

Used when something genuinely needs persistent state across multiple visits with branching logic, or needs to subscribe to cross-world events. Examples: a multi-stage quest, a persistent NPC with memory, combat.

```ts
// modules/merchant_arc/flow.ts
export async function* merchantArc(ctx: FlowCtx) {
  yield p`The cloaked merchant watches you approach.`

  const choice = yield choose({
    inspect: "Inspect the snowglobe",
    leave: "Walk away",
  })

  if (choice === "leave") return

  yield p`He holds it out. "500 coins."`
  if (ctx.character.gold < 500) {
    yield p`You realize you can't afford it.`
    return
  }

  const pay = yield choose({ pay: "Pay", decline: "Decline" })
  if (pay !== "pay") return

  yield mutate({ inc: ["character.gold", -500] })
  yield mutate({ add_item: ["snowglobe"] })
  yield p`The snowglobe is yours. The merchant's grin widens.`
  yield gotoFlow("ice_realm.chasm.snowdunes")
}
```

**Runtime:** generator function compiled to event log. Each `yield` records (op, args). Replay re-runs the generator against the log to resume. Crash-safe. Deploy-safe (version-pinned). See `01_ARCHITECTURE.md` §Durable runtime.

**Capability sandbox:** module manifest declares `reads`, `writes`, `publishes`, `emits`. Runtime hands module a proxy that only permits declared ops. Undeclared ops throw at the boundary.

## Durable runtime — how it actually works

Weaver's original coroutine persistence used Pluto. JS doesn't have that. The modern equivalent is **event-sourced generator replay**:

1. Flow is a plain generator function `function* flow(ctx) { ... }`.
2. Each `yield` produces an **op**: `{kind: "p" | "choose" | "mutate" | "call_ai" | "gen_art" | "goto", args, seed}`.
3. The runtime consumes the op, performs the side effect, and records `(op, result)` to an append-only `events` table.
4. To resume after crash/reload: re-run the generator from the top, comparing each new yield against the recorded log. If log has a result, feed it back in. When log is exhausted, wait for new input (user choice, AI response, etc.).
5. Determinism: ops carry seeds derived from `(world_id, turn, flow_id, op_index)`. RNG and AI calls cache by seed. Same inputs → same outputs, every time.

This gives:
- Crash recovery: resume exactly where you were.
- Deploy safety: old flows carry version tag; runtime keeps old handlers loaded until their events complete.
- Time travel: replay any suffix of the log.
- Test determinism: replay corpus is just recorded event logs.

## Version pinning and escape handlers

Every durable flow, module, combat encounter, and inline script carries `schema_version`. Runtime keeps old version handlers loaded as long as any live row references them. On read:

```ts
const encounter = await readEncounter(id)
const handler = handlers[encounter.module_name]?.[encounter.schema_version]

if (!handler) {
  // Handler was GC'd. Escape handler for this module fires.
  await escapeHandler(encounter)
  // Effect: force-resolve gracefully, return player to safe anchor,
  // durable state (character, inventory, settlement) preserved.
}
```

Each module ships an `escape_handler` as part of its manifest. Typical escape: write a terse "the scene ended quietly" narration to the event log, mark the encounter resolved, respawn player at nearest safe anchor.

GC policy: drop version handlers after 30 days of no active references. Log a warning at 20 days to allow manual intervention.

## Capability sandbox

Modules never access Convex directly. They receive a `ModuleCtx` proxy:

```ts
interface ModuleCtx {
  read: {
    entity: (id: string) => Promise<Entity | null>,
    component: <T>(entity_id: string, type: string) => Promise<T | null>,
    relation: (subject: string, predicate: string) => Promise<Relation[]>,
  },
  write: {
    mutate: (mutations: Mutation[]) => Promise<void>,
    emit: (event_type: string, payload: unknown) => Promise<void>,
  },
  ai: {
    classify: (text: string, schema: ZodSchema) => Promise<unknown>,
    narrate: (prompt: string) => Promise<string>,
    gen_image: (prompt: string, refs: string[]) => Promise<string>,
  },
  rng: (label: string) => number,  // deterministic, seeded
  now: () => number,                // deterministic in replay
  log: (msg: string) => void,
}
```

The manifest declares the subset of reads/writes/component-types/predicates the module will use. The proxy blocks anything not in the declared set — at the TS-type level via branded types (compile-time) and at the runtime level via permission checks (runtime).

Module execution happens inside a QuickJS WASM isolate (optional, for user-authored modules) or trusted V8 (for vetted modules). Limits: 50ms wall-clock, 10MB memory, no network, no I/O beyond the proxy.

## Cross-cutting hooks (`.always.` — future)

The original `weaver-lua` had an `.always.` convention: named code blocks that run on every turn, regardless of which location or flow the player is in. Typical uses: weather progression, time-of-day advance, resource regen (energy, hunger), ambient NPC state updates, chronicle tick.

Wave 1 and Wave 2 **don't ship this**. They ship single-subscription hooks at module level (`arrive_location`, `new_day`, `idle_player`, etc.) — which cover 80% of what `.always.` blocks were used for in the original. True always-on cross-cutting code is a Wave 3 concern, and the design should land *before* the Wave 2 module system is frozen so the module manifest can declare `always` subscriptions cleanly.

Rough shape to aim for when it's time:

- A module's manifest can declare `always: { tick, every: "turn" | "minute" | "day" }`.
- The runtime maintains a registry of always-handlers per (world, branch), compiled once.
- Each turn, the runtime executes all subscribed `always` handlers in declared order, inside the same capability-sandbox proxy as normal module code.
- `always` handlers are not allowed to produce narrative (no `yield p`); they mutate world-scope state only. Any narrative they want surfaced goes through a named event the location layer can consume.
- Execution budget per tick across all `always` handlers combined: <5ms for trusted, <20ms for user-authored. Exceeding the budget logs and skips (fail-open, not fail-closed — never block a turn).

Note: fail-open is a deliberate choice. An `.always.` bug should never brick gameplay. Drop a tick, log it, move on; users file a bug report.

Flag this in `08_WAVE_1_DISPATCH.md` as a known non-Wave-1 concern, and in the module-interface design when that spec lands, so the manifest format has room for `always` without a breaking revision later.

## Flow stack (Weaver inheritance)

Flows nest. When a module calls `yield gotoFlow("merchant_arc")`, the current flow pushes onto a stack. When the child flow completes (`done()`), control returns to the parent. Operations:

| Op | Semantics |
|---|---|
| `nest(name, default_method, filter)` | Push current, load named child; create if new. |
| `goto_flow(name, method)` | Save current if named, replace with child at same stack depth. |
| `nest_temp(method, filter)` | Unnamed, transient; popped on done. |
| `nest_throwaway(method)` | Dream — pops on done, **all state changes discarded**. |
| `reset_flow(name, method)` | Jump named flow back to start. |
| `done()` / `done(level)` | Pop one or many frames; save named flows. |

`filter` is a capability restriction applied *during* the child's lifetime (subset of parent's caps). Most commonly `stay_in_file`, `no_external_goto`, or a custom subset.

## Scaling strategy

### Lazy location materialization

Locations don't exist until visited. World is conceptually infinite (hex coordinates extend forever); only ~10K rows exist at any time per active settlement. First visit triggers a generator:

```
visit(hex) →
  if row exists → return row
  else:
    gen_prompt = buildPrompt(world_bible, biome_anchor(hex), neighbors(hex))
    json = await opus.generate(gen_prompt, schema=LocationSchema)
    entity = await insert(json)
    enqueue(art_generation, entity.id)
    return entity
```

A family of 5 exploring 30 new locations/session × 5 sessions/week × 52 weeks ≈ 40K locations/year. Convex Pro (50GB DB) holds ~10M rows comfortably.

### Predicate indexing at scale

A module decorating "all forest locations between dusk and dawn" registers a predicate query. The engine indexes predicates by (component_type, component_field, value_range). Query: "locations where biome=forest AND time ∈ dusk..dawn" is a compound index hit, sub-millisecond on Convex.

### Regional partitioning

At very large worlds (>1M locations), partition by macro-region via Convex Components — each a sub-app with its own deployment. Family worlds never hit this; it's the upper bound for ambitious public worlds.

### Prefetch neighbors

Client subscribes to the 8-hex neighborhood of current location. Movement to any neighbor is instant (already in client cache). Prefetch triggers AI gen for next-most-likely neighbors in the background.

## Branches and forking

A **branch** is a named slice of the universe: a set of entity heads pointing at blobs, scoped by `branch_id`. Forking a branch duplicates heads rows with a new `branch_id`; the blob store is unchanged. A million-location world forks in milliseconds.

Four user-facing features ride on this:

- **Named branches** — "what if the chapel tower had never fallen" — long-lived parallel versions of the world.
- **Dreams** — transient branches used for player what-ifs; state changes are discarded on completion.
- **State-fork testing** — the crawler forks a seed branch per test run, explores, discards (see `06_TESTING.md`).
- **Cross-branch character portability** — characters can be imported into another branch with durable state preserved.

Full design in `13_FORKING_AND_BRANCHES.md`, including the `fork_branch` mutation, character-policy semantics (`same | fresh | select`), in-flight-flow handling (escape handlers fire at fork time to settle transient state cleanly), event-log policy (per-branch, not copied), and cleanup of transient/expired branches via a scheduled `transient_branch_gc` action.

## Version migration ladder

Append-only migration chain per entity/component/module type:

```
components: LocationData
  v1 → v2: add field "safe_anchor", default false
  v2 → v3: rename "options" to "choices" (dual-write 30 days)
  v3 → v3.1: fix bug in description_template escaping (no data change)
  v3.1 → v4: split options into "always_available" and "conditional"
```

On read, any row with `schema_version < current` is run through the chain. Migrations are pure functions with golden-input tests. Never edit a shipped migration; always ship a fixup.

Expand/contract pattern for breaking changes:
1. Ship writer that dual-writes old + new format.
2. Backfill old rows to new format via scheduled Convex action.
3. Flip readers to new format.
4. Drop old format writer.

Each step is its own deploy, each deploy is a transaction.

## Determinism, RNG, and AI caching

- RNG is a pure function: `rng(seed_parts) → number in [0,1)`. Seed parts: `(world_id, turn, flow_id, op_index, label)`.
- AI calls are cached by `(prompt_hash, seed, model_version)`. Cache backed by Convex storage.
- Test mode treats the cache as authoritative: same input, always same output.
- Replay reads the event log's recorded result; no new AI call unless log is empty for that op.

This makes the testing trinity cheap: state-space crawler explores thousands of paths without re-paying for AI; screenshot eval replays deterministic states; replay corpus is exact.

## PWA + offline

- Service worker caches: app shell, world bible, theme, last 50 location snapshots, last 500 chat messages for locations visited, character ref images.
- Offline mode: readable (browse recently-visited locations, read chat history), not writable (mutations queued locally and synced on reconnect via Convex's built-in offline queue).
- Cold start target: <1.5s on mid-tier Android over 4G.

## What lives where (deployment)

| Concern | Home |
|---|---|
| Client bundle | Cloudflare Pages (free, unlimited bandwidth) |
| Reactive state + server logic | Convex |
| Generated images | Cloudflare R2 (zero egress) |
| Event log + mentorship log + mentorship archive | Convex tables |
| Long-tail generated content (chronicle exports) | R2 |
| LLM calls (Opus, Sonnet, Haiku) | Anthropic API via Convex actions |
| Image gen | fal.ai via Convex actions |
| Auth | Better Auth + Resend magic links |
| Domain | Cloudflare Registrar |

All secrets live in Convex environment variables. Client never sees an API key.
