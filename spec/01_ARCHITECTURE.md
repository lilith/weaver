# Weaver — Architecture

## Two execution paths, one store

Every location, NPC, and encounter is rendered by one of two paths. The runtime detects which on load and dispatches.

```
┌─────────────────────────────────────────┐
│  JSON with safe inline expressions      │ ← most content. Template render + a
│  (description_template, options,        │   small bounded expression evaluator
│   predicates, effects)                  │   for conditionals, RNG flavor, and
└─────────────────────────────────────────┘   per-player {{...}} shorthand.
           │
           ▼
┌─────────────────────────────────────────┐
│  Durable module (state machine)         │ ← anything stateful across turns,
│  steps: { [id]: (ctx, state) =>         │   anything that subscribes to world
│    ({ next, effects }) }                │   events, anything genuinely complex.
└─────────────────────────────────────────┘
           │
           ▼
     entities / components / relations store (Convex)
```

The store is common. What differs is how behavior reaches the store.

The earlier three-path split (JSON / inline script / module with a custom script grammar as Path 2) is dropped; the "Path 2" use-cases — conditional prose, random flavor, tiny per-player state tweaks — are served by safe inline expressions inside the JSON template grammar (see `02_LOCATION_SCHEMA.md` §"Template grammar"). `03_INLINE_SCRIPT.md` is marked deprecated.

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

## Path 2 — durable module

Used when something genuinely needs persistent state across multiple visits with branching logic, or needs to subscribe to cross-world events. Examples: a multi-stage quest, a persistent NPC with memory, combat.

```ts
// modules/merchant_arc/flow.ts
export const merchantArc: ModuleDef = {
  name: "merchant_arc",
  schema_version: 1,
  manifest: { reads: [...], writes: [...], emits: [...] },
  steps: {
    open: async (ctx, state) => {
      ctx.say("The cloaked merchant watches you approach.")
      return {
        next: "choose_action",
        ui: { choices: [
          { id: "inspect", label: "Inspect the snowglobe" },
          { id: "leave",   label: "Walk away" },
        ]},
      }
    },
    choose_action: async (ctx, state, input) => {
      if (input.choice === "leave") return { next: "done" }
      return { next: "price_check" }
    },
    price_check: async (ctx, state) => {
      ctx.say('He holds it out. "500 coins."')
      if (ctx.character.gold < 500) {
        ctx.say("You realize you can't afford it.")
        return { next: "done" }
      }
      return { next: "confirm_pay" }
    },
    confirm_pay: async (ctx, state, input) => {
      if (input.choice !== "pay") return { next: "done" }
      return {
        next: "done",
        effects: [
          { kind: "inc", path: "character.gold", by: -500 },
          { kind: "give_item", item_id: "snowglobe" },
        ],
      }
    },
    done: { terminal: true },
  },
}
```

**Runtime:** step-keyed state machine, not generator replay. A flow row stores `{module_name, schema_version, current_step_id, state_blob_hash, status}`. Resume is: look up handler for `current_step_id`, call with loaded state + any waiting input, apply returned effects, update `current_step_id`, persist. Crash-safe (state is on disk after every transition). Deploy-safe (version-pinned — §"Version pinning and escape handlers"). See §"Durable runtime" below.

**Module context (`ModuleCtx`):** a typed proxy that declares the module's `reads`, `writes`, `emits`. Wave 1-3 modules are trusted TypeScript compiled into the server bundle; the proxy is a documentation + one-line-runtime-check pattern, not a sandbox isolate. The runtime check catches "module writes a component type it didn't declare" at the boundary (defense in depth for bugs, not security). User-authored modules in a real isolate is a Wave 4+ concern — see `ISOLATION_AND_SECURITY.md` §"Module isolation."

## Durable runtime — how it actually works

Weaver's original coroutine persistence used Pluto. JS doesn't have that natively, and generator-based event-sourced replay (an earlier sketch of this section) is a Temporal-sized engineering commitment we don't need. The chosen shape is **step-keyed state machines**, which give us crash safety and deploy safety without the replay semantics' landmines (closure capture, non-deterministic built-ins, side effects on the "should never happen" path).

### The shape

A **module** is a plain TypeScript object:

```ts
type ModuleDef = {
  name: string
  schema_version: number
  manifest: { reads: string[], writes: string[], emits: string[] }
  steps: Record<StepId, StepHandler | TerminalStep>
}

type StepHandler = (ctx: ModuleCtx, state: ModuleState, input?: StepInput) => Promise<StepResult>

type StepResult = {
  next: StepId                // where to resume next
  state?: ModuleState          // updated state (blob-hashed if large)
  effects?: Effect[]           // mutations + UI + AI calls to apply
  ui?: { choices?: Choice[], narration?: string }  // shown to the player; step becomes waiting
}

type TerminalStep = { terminal: true }
```

### Lifecycle

1. **Start.** A trigger (`start_combat`, `arrive_location` with a `#module:` target, a module's own `emit` → another module's subscription, etc.) inserts a `flows` row with `current_step_id: "start"` (or whatever the module defines as entrypoint) and empty state.
2. **Step dispatch.** Runtime reads the flow row, looks up `module.steps[current_step_id]`, calls it with `ctx`, loaded state, and any waiting input. The handler returns `{ next, state?, effects?, ui? }`.
3. **Apply effects.** Runtime applies mutations, enqueues AI calls, appends to the narrative. Each effect has its own deterministic seed derived from `(flow_id, step_id, effect_index)` so regenerating after a crash produces the same output.
4. **Persist.** Updates flow row: `current_step_id = next`, `state_blob_hash = hash(state)` (if state changed). Writes a `flow_transitions` row with `{step_from, step_to, effects}` for audit + debugging.
5. **Suspend or continue.** If the step returned `ui:` (presented choices or awaiting free-text), status becomes `waiting`; the flow is parked until the user responds. Otherwise the runtime immediately dispatches the next step.
6. **Terminal.** A step marked `{ terminal: true }` sets the flow's status to `completed`. No further dispatch.

### Why this over generator-replay

- **Debugging.** Stepping through a state machine is stepping through named functions; stepping through a generator-replay is stepping through a re-run of an earlier execution against a log, which is harder to reason about.
- **Migration.** A new module version can ship a `migrate: (old_state, from_version) => new_state` function; no replay-equivalence concerns.
- **Determinism scope.** Non-determinism inside a step (wall-clock, Math.random) is fine — the step is called once per transition, and its effects go through the ctx proxy which stamps seeds. The earlier generator-replay model required everything inside the generator to be deterministic under re-execution, which is a nightmare to audit.
- **Escape is simpler.** If a version-pinned handler has been GC'd, the escape handler runs in place of the missing step — no "fast-forward through the log to find the last good state" dance.

### What we give up

- **Time travel through intra-step execution** — we can replay step transitions from `flow_transitions` but not the inside of a step. Fine: the step is a black box whose effect on the world is captured by its emitted effects.
- **"Re-run the whole flow" as a test primitive** — replaced by "replay the transition log": call each step in order with its recorded input, assert effects match. Still deterministic, easier to debug.

### Crash recovery

On process restart, all `flows` rows with status `running` are re-dispatched from their `current_step_id` with their stored state. If a step was mid-effect (partial mutations applied), the effects are idempotent by design (seeded writes, blob-hash-addressed content creation) so the re-run converges to the same result. Effects that are inherently non-idempotent (e.g., send_email) are marked so and moved to a "send-once-and-record" pattern.

### Determinism, RNG, and AI caching

RNG is still a pure function of seed parts: `rng(flow_id, step_id, effect_label, branch_id, world_id)`. AI calls are still cached by `(prompt_hash, seed, model_version, world_id, branch_id)` — the world/branch keys are from `ISOLATION_AND_SECURITY.md` rule 5. Cache is authoritative in test mode. Resume after crash hits the cache if the seed matches the prior run.

## Version pinning and escape handlers

Every durable flow, module, and combat encounter carries `schema_version`. Runtime keeps old version handlers loaded as long as any live row references them. On read:

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

## Module context — typed proxy (Wave 1-3)

Modules don't access Convex directly. They receive a `ModuleCtx` proxy scoped to the calling flow's `world_id` / `branch_id`:

```ts
interface ModuleCtx {
  world_id: Id<"worlds">        // const — cannot be overridden by the module
  branch_id: Id<"branches">
  character: Readonly<Character>

  read: {
    entity: (id: Id<"entities">) => Promise<Entity | null>
    component: <T>(entity_id: Id<"entities">, type: string) => Promise<T | null>
    relation: (subject: Id<"entities">, predicate: string) => Promise<Relation[]>
  }
  write: {
    mutate: (mutations: Mutation[]) => Promise<void>
    emit: (event_type: string, payload: unknown) => Promise<void>
  }
  ai: {
    classify: (text: string, schema: ZodSchema) => Promise<unknown>
    narrate: (prompt: string) => Promise<string>
    gen_image: (prompt: string, refs: Id<"entities">[]) => Promise<Id<"entities">>   // returns ref entity id
  }
  rng: (label: string) => number
  now: () => number
  log: (msg: string) => void
  say: (text: string) => void                                                        // convenience — appends narration
}
```

The module's manifest declares which component types it reads and writes, which events it emits, and which predicates it manipulates. The proxy enforces the declaration:

- **Compile-time:** typed via branded component-type strings; `writes` not declared in the manifest won't type-check.
- **Runtime:** one check per boundary call. Cheap, defense-in-depth for bugs, not a security isolate.

**Wave 1-3 modules are trusted TypeScript** compiled into the server bundle. There is no QuickJS WASM isolate, no runtime capability boundary beyond the proxy check. The proxy pattern survives because it documents module surface (manifest) and catches bugs that would silently access data the module shouldn't — not because we need to protect against hostile module code.

**Wave 4+** (user-authored modules, if ever): a real isolate becomes mandatory. Constraints proposed at that time will be something like: QuickJS WASM, 50ms wall-clock, 10MB memory, no network, no I/O beyond the proxy, no `eval` / `Function` / dynamic import. Those numbers are unverified — see `FEASIBILITY_REVIEW.md` §4 "QuickJS WASM isolate cold-start." Respec this section when the feature lands.

Isolation rules that apply today (trusted modules) are in `ISOLATION_AND_SECURITY.md` §"Module isolation" — ctx is bound to the flow's world/branch, manifest declarations are enforced, and modules cannot touch auth/cost-ledger/audit-log no matter what their manifest says.

## Multi-player sync — at-transition, plus reactive chat

Multiple players can occupy the same world (and, in Wave 2+, the same location). The sync model is deliberately simple:

- **Durable character state** — inventory, HP, gold, relationships, position, energy — syncs at **location-entry and location-exit** only. Two players at the same location don't see each other's `this.*`-scoped state updates in real time. If Mara drinks from the spring and gains `character.rested`, Jason (also at the spring) sees that on his next transition, not mid-turn.
- **Location-scoped shared state** (`location.*`) — fire lit, door opened, chest taken — syncs immediately on mutation via Convex's reactive queries. This is the coordination primitive.
- **Chat** — fully reactive via `chat_messages` subscription. Real-time, because conversation is the part where real-time actually matters.
- **Presence panel** — "where is everyone" — updates on transitions, not continuously. The panel subscribes to `characters.current_location_id` with a throttled view.

Why at-transition rather than continuous: intra-location state updates are numerous, low-stakes, and often personal-scoped (`this.stump_examined` is about you, not Jason). Making them reactive costs Convex mutation contention, UI flicker, and a coordination-semantics design problem that has no clean answer (who goes first when two players tap the same option?). At-transition sync keeps the game turn-based-like at each player's own pace while making chat feel live.

What this gives up:
- Two players simultaneously examining the same object don't see each other do it.
- Combat with two players can't be "same turn" in UI; it's either hardcoded-solo (Wave 1) or a module that externalizes turn-order explicitly (Wave 2+).
- Optimistic "I saw Mara take the torch, let me take the thing beside it" doesn't render until the next transition.

Worth it for Wave 1. Revisit if playtest shows the family feels disconnected.

### Campaign layer (async + sync overlap)

On top of at-transition durable sync + reactive chat, a campaign-events layer makes async play feel like shared story. See **`ASYNC_SYNC_PLAY.md`** for the full model. Summary: the world clock advances whenever any character acts (monotonic, no races). When a character logs in after time has passed, a catch-up panel offers per-event choices — *"I was with them / I skipped it / tell me about it"* — so narrative threads reconverge retroactively without forcing synchronous play. Cross-era catch-up is the same mechanism (see `25_ERAS_AND_PROGRESSION.md` §"Interaction with async-sync play"): a character whose `personal_era` is behind the world advances through the catch-up panel as they opt into the beats that happened while they were gone. Gating arc-beat events stay pending until the character explicitly acknowledges them — which is how "key stuff must be experienced by all eligible" is enforced without making the world wait on the slowest player.

## Flow stack (Weaver inheritance)

Flows nest. When a step handler returns `{ next: gotoFlow("merchant_arc") }`, the current flow pushes onto a stack. When the child flow completes (its terminal step is reached, or an explicit `done()` is returned), control returns to the parent's next step. Operations:

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

## Determinism, RNG, and AI caching (system-wide)

The durable-runtime section covers determinism inside flows. The broader rules, applying to every Convex action including the expansion loop and the art worker:

- **RNG** is a pure function: `rng(seed_parts) → number in [0,1)`. Seed parts for flow-owned RNG: `(world_id, branch_id, flow_id, step_id, effect_label)`. For non-flow RNG (e.g., expansion loop picking a fallback biome): `(world_id, branch_id, turn_id, caller_label)`. Never derive a seed from wall-clock.
- **AI calls cached** by `(model, canonicalized_prompt_hash, seed, world_id, branch_id)` per `ISOLATION_AND_SECURITY.md` rule 5. Cache backed by Convex storage. Test mode treats the cache as authoritative.
- **Non-deterministic built-ins** (`Math.random`, `Date.now`, network calls) are not forbidden in handler code, but their results go through the proxied `ctx.rng` / `ctx.now` / `ctx.ai` surfaces so they can be stamped with seeds and cached.
- **Resume after crash** reads persisted state + transition log; step handlers re-execute with the same seeds and hit the same cache entries, converging to the same output.

This makes the testing trinity cheap: the state-space crawler explores thousands of paths without re-paying for AI; the replay test primitive reruns transition logs deterministically.

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
