# Weaver — Location Schema

## Goal

One schema that covers ~95% of hand-authored and AI-generated content. When this isn't enough, the location upgrades to an inline script (4%) or a full module (1%).

## The schema

```ts
// packages/engine/schemas/location.ts
import { z } from "zod"

export const LocationEffect = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("set"), path: z.string(), value: z.any() }),
  z.object({ kind: z.literal("inc"), path: z.string(), by: z.number() }),
  z.object({ kind: z.literal("goto"), target: z.string() }),
  z.object({ kind: z.literal("spawn_location"), hint: z.string(), biome: z.string().optional() }),
  z.object({ kind: z.literal("start_combat"), opponent_id: z.string() }),
  z.object({ kind: z.literal("roll"), sides: z.number(), save_as: z.string() }),
  z.object({ kind: z.literal("say"), text: z.string() }),
  z.object({ kind: z.literal("give_item"), item_id: z.string() }),
  z.object({ kind: z.literal("take_item"), item_id: z.string() }),
  z.object({ kind: z.literal("add_predicate"), predicate: z.string(), object_id: z.string(), payload: z.any().optional() }),
  z.object({ kind: z.literal("emit"), event_type: z.string(), payload: z.any().optional() }),
])

export const LocationOption = z.object({
  label: z.string(),                        // button text
  condition: z.string().optional(),         // mini-predicate string, e.g. "character.inventory.has('key')"
  target: z.string().optional(),            // location id OR "#inline:scriptname" OR "#module:name/method"
  effect: z.array(LocationEffect).optional(),
  hidden_until: z.string().optional(),      // predicate that must become true
  author_pseudonym: z.string().optional(),  // who added this option
})

export const LocationSchema = z.object({
  id: z.string(),
  type: z.literal("location"),
  schema_version: z.number().default(1),

  name: z.string(),
  biome: z.string(),                        // "forest" | "village" | "inn" | "forest_deep" | ...
  coords: z.object({ q: z.number(), r: z.number() }).optional(),  // hex coords
  neighbors: z.record(z.string(), z.string()).optional(),         // {"n": "loc_id", "se": "loc_id", ...}

  description_template: z.string(),         // supports {{vars}} and {{#if cond}}...{{/if}}
  options: z.array(LocationOption),

  on_enter: z.array(LocationEffect).default([]),
  on_leave: z.array(LocationEffect).default([]),

  state_keys: z.array(z.string()).default([]),  // list of {{vars}} used, for test coverage
  tags: z.array(z.string()).default([]),         // "has_chat" | "safe_anchor" | "combat_allowed" | ...

  art_ref: z.string().optional(),           // ref id for the scene art
  art_status: z.enum(["queued", "generating", "ready", "failed"]).default("queued"),

  author_user_id: z.string().optional(),
  author_pseudonym: z.string().optional(),
  discovered_by: z.string().optional(),     // user_id of first visitor, never displayed directly
  created_at: z.number(),
  updated_at: z.number(),

  safe_anchor: z.boolean().default(false),
  chat_thread_id: z.string().optional(),
})

export type Location = z.infer<typeof LocationSchema>
```

## Template grammar

Descriptions and option conditions support a minimal mustache-like syntax.

```
{{var}}                    interpolate
{{var.path}}               nested access
{{#if predicate}}...{{/if}} conditional block
{{#unless predicate}}...{{/unless}} inverted
{{#each collection}}...{{/each}} loop
```

Predicates are read-only mini-expressions:

```
character.inventory.has('key')
character.level >= 5
world.time.hour > 18
this.visited > 3
npc.mordred.bond > 0.5
```

No arithmetic beyond `>`, `>=`, `<`, `<=`, `==`, `!=`. No function calls except `.has()`, `.length`, `.count()`. Parses to an AST, evaluates against scoped context. Never `eval`.

## Scoped state

Four scopes readable in templates and conditions:

| Scope | Contents |
|---|---|
| `character` | visiting player's character state |
| `this` | location-specific state for *this player* (e.g., `this.visited`, `this.stump_examined`) |
| `location` | location-specific state shared by *all players* (e.g., `location.fire_lit`) |
| `world` | world-scoped state (`world.time`, `world.weather.rain`, `world.day`) |

Writes via effects are scope-addressed: `"path": "this.stump_examined"` or `"path": "location.fire_lit"`.

## Worked examples

### Example 1 — A peaceful clearing (pure JSON)

```json
{
  "id": "forest_clearing_42",
  "type": "location",
  "schema_version": 1,
  "name": "A small clearing",
  "biome": "forest",
  "coords": {"q": 4, "r": -2},
  "neighbors": {"n": "forest_deep_17", "s": "village_square", "e": "forest_creek_03"},
  "description_template": "You stand in a small clearing ringed by pale birches. {{#if world.weather.rain}}Rain taps softly against the leaves.{{/if}}{{#if this.visited}} The path back to the village curves behind you.{{/if}} An old stump occupies the center.",
  "options": [
    {
      "label": "Examine the old stump",
      "effect": [
        {"kind": "set", "path": "this.stump_examined", "value": true},
        {"kind": "say", "text": "Rings uncountable. Older than any living memory."}
      ]
    },
    {"label": "Head deeper into the forest", "target": "forest_deep_17"},
    {"label": "Return to the village", "target": "village_square"}
  ],
  "on_enter": [{"kind": "inc", "path": "this.visited", "by": 1}],
  "state_keys": ["this.visited", "this.stump_examined", "world.weather.rain"],
  "tags": ["has_chat"],
  "art_ref": "ref_forest_clearing_42",
  "art_status": "ready",
  "author_pseudonym": "Stardust",
  "discovered_by": "user_jason",
  "safe_anchor": false,
  "chat_thread_id": "chat_forest_clearing_42"
}
```

### Example 2 — Village Inn with a conditional option

```json
{
  "id": "inn_common_room",
  "type": "location",
  "name": "The Inn common room",
  "biome": "inn",
  "description_template": "Firelight dances across the low-beamed ceiling. {{#if location.fire_lit}}A warm glow fills the room.{{/if}}{{#unless location.fire_lit}}The hearth is cold.{{/unless}} Violet the barmaid nods as you enter.",
  "options": [
    {
      "label": "Warm yourself by the fire",
      "condition": "location.fire_lit",
      "effect": [
        {"kind": "set", "path": "character.state.warmed", "value": true},
        {"kind": "say", "text": "You soak in the warmth, feeling the chill leave your bones."}
      ]
    },
    {
      "label": "Light the fire",
      "condition": "!location.fire_lit && character.inventory.has('flint')",
      "effect": [
        {"kind": "set", "path": "location.fire_lit", "value": true},
        {"kind": "say", "text": "Flint and steel, sparks, then a gentle roar."}
      ]
    },
    {
      "label": "Talk to Violet",
      "target": "#module:violet_dialogue/greet"
    },
    {
      "label": "Rent a room for the night",
      "condition": "character.gold >= 5",
      "effect": [
        {"kind": "inc", "path": "character.gold", "by": -5},
        {"kind": "goto", "target": "inn_bedroom_3"}
      ]
    },
    {"label": "Step back outside", "target": "village_square"}
  ],
  "state_keys": ["location.fire_lit", "character.gold", "character.inventory"],
  "tags": ["has_chat", "safe_anchor"],
  "safe_anchor": true,
  "chat_thread_id": "chat_inn_common_room"
}
```

### Example 3 — Dead-end, expansion-ready stub (AI-generated on first visit)

When a player's free-text or option references an undefined target, a stub is created:

```json
{
  "id": "chapel_tower_auto_2619",
  "type": "location",
  "name": "The chapel tower",
  "biome": "stone_tower",
  "description_template": "PENDING_GENERATION",
  "options": [],
  "on_enter": [{"kind": "emit", "event_type": "needs_expansion", "payload": {"hint": "Jason climbed the chapel tower looking for ravens"}}],
  "state_keys": [],
  "tags": ["stub"],
  "art_status": "queued",
  "discovered_by": "user_jason",
  "author_pseudonym": "Jason",
  "created_at": 1744844400000,
  "updated_at": 1744844400000
}
```

The `needs_expansion` event triggers the expansion loop (see `04_EXPANSION_LOOP.md`), which generates actual content against the world bible + expansion hint. Player sees a brief "the scene is forming..." placeholder, then the real location appears within 2–4 seconds (text first, art on next visit).

### Example 4 — Combat trigger

```json
{
  "id": "forest_deep_ambush",
  "type": "location",
  "name": "A narrow pass",
  "biome": "forest_deep",
  "description_template": "The path narrows between boulders. {{#if this.visited}}The scar on the oak reminds you of your last passage here.{{/if}}",
  "options": [
    {"label": "Continue through", "target": "forest_mountain_foothills"},
    {"label": "Turn back", "target": "forest_clearing_42"}
  ],
  "on_enter": [
    {
      "kind": "emit",
      "event_type": "maybe_ambush",
      "payload": {"bandit_template": "road_bandit", "probability": 0.35}
    }
  ],
  "state_keys": ["this.visited"],
  "tags": ["combat_allowed"]
}
```

The `maybe_ambush` event is consumed by the combat system (Wave 1 hardcoded, Wave 2 module). On roll-success it injects a combat encounter; on roll-fail the player passes through.

### Example 5 — An inline-script location (Path 2)

When the location needs small runtime logic, the JSON points to an inline script:

```json
{
  "id": "merchant_booth",
  "type": "location",
  "name": "Hooded merchant's booth",
  "biome": "market",
  "description_template": "#inline:merchant_booth_script",
  "options": [],
  "state_keys": ["character.gold", "character.inventory", "this.examined_globe"],
  "tags": ["has_chat"]
}
```

The `#inline:` prefix on `description_template` (or on any option's `target`) tells the runtime to invoke the inline script evaluator. Script itself is stored in an `inline_script` component attached to the same entity. See `03_INLINE_SCRIPT.md`.

## Validation gates

Every location JSON is validated at insert/update time:

1. **Zod parse.** Schema mismatch → reject.
2. **Template compile.** Template parses to AST successfully; all `{{vars}}` resolve to declared `state_keys`.
3. **Option reachability.** All `target` references point to existing entities, declared `#inline:` scripts, or declared `#module:` methods. Unresolved → mark as stub pending expansion.
4. **Effect legality.** Each effect's `path` must be in one of the four scopes with valid shape.
5. **Safety filter.** No self-targeted infinite loops (option target == current id without a state change); no recursion without a `done()`-equivalent.

Validation happens server-side in the Convex mutation that writes the entity. Client sees either success or a structured error listing which checks failed, so the browser designer can show them inline.

## Testing a JSON location

Each location ships with a fixtures file:

```ts
// locations/forest_clearing_42.test.ts
import { testLocation } from "@weaver/test"

testLocation("forest_clearing_42", [
  { name: "first visit no rain", state: { this: { visited: 0 }, world: { weather: { rain: false } } },
    expected: { description_contains: "small clearing ringed", options_count: 3 } },
  { name: "revisit with rain", state: { this: { visited: 3 }, world: { weather: { rain: true } } },
    expected: { description_contains: "Rain taps softly", description_contains_2: "curves behind you" } },
  { name: "examine stump effect", state: { this: { visited: 1, stump_examined: false } },
    action: { kind: "select_option", label: "Examine the old stump" },
    expected: { new_state: { this: { stump_examined: true } }, say_contains: "Rings uncountable" } },
])
```

The state-space crawler also auto-generates tests by enumerating state combinations from `state_keys`.

## Attribution rendering

Every location displays its author pseudonym in a subtle header byline. Options also display author if different from the location's creator (e.g., someone added an option via prompt edit later). Example rendering:

```
A small clearing
✦ discovered by Stardust · last edited by Jason
```

Full edit history is accessible via a "history" affordance on the location. See `11_PROMPT_EDITING.md`.
