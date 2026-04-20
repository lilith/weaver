# Weaver — Biome Rules

## What this spec does

Promotes **biomes** from descriptive authoring tags (name + prose + establishing_shot_prompt) into **runtime primitives** that carry mechanical rules consumed by the engine. Ask 1 in `backstory/POSTER_CHILD.md`.

Today: a biome is art + tone. The office-dungeon-deep looks different from a birch forest, but the engine treats them identically for everything mechanical.

Proposed: biomes carry optional `rules:` that shape the clock, the spawn table, per-turn effects, on-entry narration. This is what makes a biome feel like a *place* rather than a skin.

**Status:** Wave 2 target. Not shipped. Additive — existing biomes without `rules:` keep working unchanged.

## The `rules:` block

Added to biome frontmatter (`biomes/<slug>.md` per `AUTHORING_AND_SYNC.md`):

```yaml
---
name: The Office Dungeon — Deep
tags: [indoor, urban, fluorescent, liminal, dangerous]
establishing_shot_prompt: >
  Endless fluorescent corridors, waxed linoleum, drop ceiling, stapler
  swarms skittering at the edge of vision, muted-noir + liminal-dread.
rules:
  time_dilation: 160                  # 3 min real ≈ 8 hrs internal
  noise_decay: 0.5                    # per-turn decay of location.noise_level
  on_enter_biome:
    - { kind: say, text: "The fluorescents here hum at a frequency your teeth can feel." }
    - { kind: inc, path: character.hours_awake, by: 0 }   # example stat stamp
  on_turn_in_biome:
    - { kind: inc, path: character.hours_in_dungeon, by: 8 }
  on_leave_biome:
    - { kind: say, text: "The door behind you seals with a soft pneumatic sigh." }
  spawn_tables:
    low_noise:  [none, none, rogue-stapler]
    mid_noise:  [stapler-swarm, shellaxy]
    high_noise: [stapler-swarm-large, tumblefeed, basilisk-prime]
  ambient_effects:
    - { kind: damage, target: character, amount: 1, damage_kind: fluorescent_fatigue, every_n_turns: 8 }
palette:                              # from 10_THEME_GENERATION.md
  background_tint: "#0b0f14"
  ink_tint: "#d8e0e8"
  atmosphere: "fluorescent-cold"
---

Prose body — the "what this biome is like" description, as today.
```

Every field under `rules:` is optional. A biome that carries none is identical to a biome today.

## Hook semantics

Biome hooks fire at well-defined moments in the turn lifecycle. Ordering relative to location-level hooks is explicit:

```
ENTER a new location:
  1. location.on_leave (from the previous location)
  2. If biome changed: biome.on_leave_biome (previous biome)
  3. If biome changed: biome.on_enter_biome (new biome)
  4. location.on_enter (new location)
  5. render

EACH TURN spent in the same location:
  1. biome.on_turn_in_biome
  2. biome.ambient_effects (those whose every_n_turns matches turn_count)
  3. (player action)
```

"Turn" is defined as a player-initiated option tap or free-text input. Idle time does not tick biome hooks (the world doesn't grind while the player's sleeping).

## `time_dilation`

A scalar multiplier applied to `world.time.*` advancement while the character is inside any location of this biome. See `23_WORLD_CLOCK.md` for the clock model.

- `time_dilation: 1` (or omitted) — realtime-equivalent.
- `time_dilation: 160` — 160 seconds of in-world time per 1 second of real-turn time. The Daily Grind's office dungeon.
- `time_dilation: 0` — clock frozen while inside. For pocket dimensions / dreamspaces.

Composition: `world.time_tick_per_turn = world.base_tick_per_turn * active_biome.time_dilation`. The turn engine applies this on `on_turn_in_biome` dispatch.

## `spawn_tables`

Named tables keyed by a **spawn bucket** (`low_noise`, `mid_noise`, `high_noise`, or any author-defined key). Each table is an array of slugs — either `none` (no spawn this draw) or a slug resolvable against `encounters/<slug>.md` (see `26_ENCOUNTER_TEMPLATES.md` — Wave 3 spec).

The runtime consults a spawn table via an effect:

```yaml
on_enter:
  - { kind: spawn_from_biome, bucket: "high_noise", chance: 0.4 }
```

If the roll hits, the runtime picks a uniform-random entry from the named bucket and triggers `start_combat` with that encounter. If `none`, nothing happens. If the bucket is empty or missing, nothing happens and a warning is logged.

**Why buckets:** a biome often has different spawn pressures based on state — a quiet office-dungeon vs one where the player shot the potato gun. The location's `location.noise_level` (player-author-managed state) feeds the bucket choice.

## `ambient_effects`

A list of effects that fire on a cadence while the character is in the biome:

```yaml
ambient_effects:
  - { kind: damage, target: character, amount: 1, damage_kind: fluorescent_fatigue, every_n_turns: 8 }
  - { kind: say, text: "Something small scurries in the ducts overhead.", every_n_turns: 20, chance: 0.3 }
```

`every_n_turns` counts turns-in-this-biome, not turns-in-this-location. Walking between two locations in the same biome continues the counter; crossing a biome boundary resets it.

## Damage kinds (Wave 2 minimum)

Biome `ambient_effects` and encounter damage carry a `damage_kind` string. Standard kinds:

- `physical` — default; armor-reducible
- `mental` — armor-ignoring, reducible by specific gear (see `22_ITEM_TAXONOMY.md`)
- `acid` — sewer-biome typical
- `fluorescent_fatigue` — office-dungeon accumulator
- `psychic` — rare, for specific antagonists

Kinds are free-form strings the engine doesn't enforce; `25_COMBAT.md` defines which are "standard" and how armor/resistance maps apply. Author-defined kinds Just Work — gear with `resistance.author_custom` reduces them.

## Importer validation

`scripts/import-world.mjs` + `convex/import.ts` will validate `rules:` on biomes:

- `time_dilation` is a non-negative number.
- `spawn_tables` keys are strings; values are arrays of slugs resolving to existing `encounters/` entries OR the literal `"none"`.
- `on_enter_biome` / `on_turn_in_biome` / `on_leave_biome` effect lists parse against the effect schema.
- `ambient_effects[].every_n_turns` is a positive integer.

Unknown keys under `rules:` are ignored (forward-compat).

## Runtime changes

The turn engine gains:

1. **Biome-entry detection.** On every location transition, compare `new_location.biome` to `prev_location.biome`. If different, fire `on_leave_biome` for the old and `on_enter_biome` for the new.
2. **Per-turn biome tick.** After the player's action but before the next render, iterate `active_biome.on_turn_in_biome` + any `ambient_effects` matching the turn counter.
3. **Time-dilation composition.** Before applying `advance_time` effects, multiply by the active biome's `time_dilation` (or 1 if unset).
4. **Spawn hook.** The `spawn_from_biome` effect type looks up the biome, picks from the named bucket, rolls the chance, invokes combat if it hits.

All changes are additive to the effect dispatcher; no existing effect types change.

## Example: one biome, full rules

```yaml
---
name: The Sewer — Flow Plane
tags: [underground, flowing, acid, luminous]
establishing_shot_prompt: >
  A vast sewer chamber where the waste-flow plane turns into a slow luminous
  river, green-glowing algae on the walls, faint dripping echo, things
  watching from the ceiling.
rules:
  time_dilation: 40
  noise_decay: 0.3
  on_enter_biome:
    - { kind: say, text: "You wade into the Flow. The smell resolves into something almost sweet." }
  on_turn_in_biome:
    - { kind: inc, path: this.exposure, by: 1 }
  spawn_tables:
    low_noise:  [none, sewer-herring]
    mid_noise:  [acidwhisker, shellaxy]
    high_noise: [acidwhisker-pack, basilisk-prime]
  ambient_effects:
    - { kind: damage, target: character, amount: 1, damage_kind: acid, every_n_turns: 6 }
    - { kind: say, text: "Something large displaces water upstream.", every_n_turns: 15, chance: 0.2 }
palette:
  background_tint: "#052815"
  ink_tint: "#c8f0b8"
  atmosphere: "acid-luminous"
---

The Flow is a river under the city — where the sewer slows into a vast
green-lit plane. Things live here.
```

## Migration

The Quiet Vale world (today's shipped world) has no `rules:` on any biome. It keeps working. When an authoring pass adds rules:

- `village` biome: no rules needed; the whole world is realtime-equivalent.
- `forest` biome: maybe `on_turn_in_biome: [{ kind: inc, path: this.pulse, by: 1 }]` for a quiet-forest mood counter.
- `forest-deep` biome (if added): `spawn_tables.low_noise: [none, wild-doe]` for atmospheric encounters.

No migration of existing biomes needed — only additive authoring.

## What this enables (stories)

- **The Tuesday 3:44 window** (Daily Grind) — world clock (`23_WORLD_CLOCK.md`) + biome time-dilation composes to let the office-dungeon spend 8 hours internal per 3 min real. The window is a clock-predicate option on a location.
- **Sewer acid attrition** — ambient damage pressures exploration cadence.
- **Quiet forest mood** — `on_turn_in_biome` accumulators feed conditional prose ("the forest is silent today" vs "the forest is restless").
- **Room-sized identity** — even without mechanical rules, per-biome `palette:` (in `10_THEME_GENERATION.md`) makes every biome feel visually distinct.

## Dependencies

- `22_ITEM_TAXONOMY.md` — `damage_kind` + armor/resistance mapping.
- `23_WORLD_CLOCK.md` — time-dilation composition.
- `25_COMBAT.md` (Wave 2 combat spec) — spawn-from-biome triggers into the combat system.
- `26_ENCOUNTER_TEMPLATES.md` (Wave 3) — spawn_table slugs resolve to encounter entities.

If any of those lag, biome `rules:` still ships — just with reduced effect palette.

## Open questions

- **Biome inheritance.** Is `office-dungeon-deep` a child of `office-dungeon`? If yes, deep inherits the outer's `on_enter_biome` unless overridden. If no, each biome is standalone. **Recommendation: no inheritance.** Flat biome list keeps the mental model clean; authors duplicate rules that should be shared.
- **Multi-biome locations.** A location in two biomes (e.g. "office-dungeon lobby that's also a corporate-lobby")? **Recommendation: one biome per location.** Ambiguity is more trouble than reuse.
- **Per-character biome state.** Should `on_turn_in_biome` mutations like `character.hours_in_dungeon` be per-character (yes, they already are — `character.*` scope is player-specific) or per-biome-per-world? The existing scope model handles this; no spec change needed.
