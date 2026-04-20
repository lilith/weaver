# Weaver — Poster-Child Capabilities (Wave 2)

Engine-side plan for the five capability shifts the data agent flagged
while authoring The Office. Cross-reference: `backstory/POSTER_CHILD.md`
is the *why* (from the data-authoring angle); this doc is the *what*
and *when* for the engine.

All five are additive to the current schema. Old worlds (Quiet Vale)
keep working untouched.

## At a glance

| # | Capability | Wave | Schema touch | Runtime touch | Deep dive | Status |
|---|---|---|---|---|---|---|
| 1 | Biome rules (hooks, time_dilation, spawn_tables) | 2 | Additive `rules:` block on biome payload | New on_enter_biome / on_turn_in_biome dispatcher + clock multiplier | [`21_BIOME_RULES.md`](21_BIOME_RULES.md) | pending |
| 2 | Item taxonomy + first-class orbs | 2 | New `kind:` discriminator + per-kind schemas | Effect router: on_crack, on_absorb, on_use, narrate | [`22_ITEM_TAXONOMY.md`](22_ITEM_TAXONOMY.md) | pending |
| 3 | World clock + day-of-week + per-biome dilation | 2 | `world.time.*` formalized; tick effect | Turn-end tick handler | [`23_WORLD_CLOCK.md`](23_WORLD_CLOCK.md) | **shipped** (`a6985aa`) |
| 4 | NPC memory auto-injected into dialogue prompts | 2–3 | New `memory:` component on npc/character | Event-tap + prompt assembler + salience decay | [`24_NPC_AND_NARRATIVE_PROMPTS.md`](24_NPC_AND_NARRATIVE_PROMPTS.md) | pending |
| 5 | AI character-sheet / shared prompt assembler | 2–3 | None | `ctx.assembleNarrativePrompt(entity_id)` runtime helper | [`24_NPC_AND_NARRATIVE_PROMPTS.md`](24_NPC_AND_NARRATIVE_PROMPTS.md) | **shipped** (`d761c03`) |

## Ask 1 — biome rules

**Goal:** biomes carry mechanical weight, not just art + a tag.

**Schema:** the biome payload gains an optional `rules:` block:

```yaml
rules:
  time_dilation: 160
  noise_decay: 0.5
  on_enter_biome: [ ...effect_list ]
  on_turn_in_biome: [ ...effect_list ]
  spawn_tables:
    low_noise: [ ...encounter_slug | "none" ]
    high_noise: [ ...encounter_slug ]
```

**Runtime:**
- When a character's location's biome changes, fire `on_enter_biome` on
  the *new* biome. (Previous biome doesn't fire an exit hook in v1 —
  keep it simple; add if a story demands it.)
- Each turn spent in a location, fire `on_turn_in_biome` on that
  location's biome.
- `time_dilation` multiplies per-turn clock advancement (see Ask 3).
- `spawn_tables` feed the expansion loop + the combat module (when
  asking "what's here") with biome-scoped candidates.

**Amends:** `spec/AUTHORING_AND_SYNC.md §biomes/<slug>.md` (add
`rules:` to frontmatter). `spec/02_LOCATION_SCHEMA.md §Scopes` (note
that effects fired from biome rules can target `character.*`, `this.*`,
`location.*`, `world.*` like any other effect).

## Ask 2 — item taxonomy

**Goal:** items stop being opaque blobs. Orbs, gear, consumables,
keys, quest, and material are first-class subtypes each with their own
schemas + effect hooks.

**Schema:** items/<slug>.md frontmatter adds `kind:` and a per-kind
sub-block.

```yaml
kind: orb                 # consumable | gear | key | orb | quest | material
orb:
  color: yellow
  size: 1                 # 1–4
on_crack: [ ...effects ]   # instant stat bump
on_absorb: [ ...effects ]  # slower, bigger effect
stackable: true
```

For `kind: gear`: `slot:` (primary_weapon, armor, tool…) + `combat:
{damage, kind}` block.
For `kind: consumable`: `consumable: { charges, on_use: [...] }`.
For `kind: key`: `unlocks:` (entity slug, predicate condition).

**Runtime:**
- Effect router dispatches `on_use`, `on_crack`, `on_absorb` through
  the existing `effect` system.
- New `narrate { prompt }` effect — queues a small Sonnet call that
  generates a 1–3 sentence flavour line in the speaker's voice.
  Emitted result goes into the current `say` buffer (see `applyOption`
  output shape).
- `give_item` / `take_item` effects unchanged in shape; the importer
  knows the item's kind and can validate.

**Amends:** `spec/AUTHORING_AND_SYNC.md §items/<slug>.md` — un-defer
and specify. `spec/02_LOCATION_SCHEMA.md §effects` — add `narrate`.

## Ask 3 — world clock

**Goal:** options can gate on time of day / day of week (*the Tuesday
3:44 window*). Biome `time_dilation` from Ask 1 composes cleanly.

**Schema:** `world.time` becomes a structured scope with:

- `hhmm` (string `"HH:MM"`)
- `day_of_week` (`"mon"`..`"sun"`)
- `day_counter` (integer, days since world start)
- `week_counter` (integer)
- `iso` (full ISO timestamp, derived)

Bible frontmatter can declare the world's origin:

```yaml
world_time:
  start: 2026-04-20T03:40:00
  tick_per_turn: 3min
  week_start: mon
```

**Runtime:**
- Turn-end tick advances `world.time` by
  `tick_per_turn × biome.rules.time_dilation` (default `1`).
- Option `condition:` grammar already supports `world.*` reads; no
  parser change needed.
- New `advance_time` effect for scripted jumps (bible-level set-pieces).

**Amends:** `spec/02_LOCATION_SCHEMA.md §Scopes` — formalize `world.time`
shape. `spec/AUTHORING_AND_SYNC.md §bible.md` — note `world_time:`
optional frontmatter.

## Ask 4 — NPC memory

**Goal:** every NPC remembers recent events involving the player by
default, and Sonnet dialogue prompts include that memory.

**Schema:** a new `memory:` component on each npc / character entity:

```yaml
memory:
  default_salience: medium  # low | medium | high
  retention: 20             # keep the N most recent events
```

Runtime stores memory as a `components` row with
`component_type: "npc_memory"`, payload shape:

```ts
{
  events: Array<{
    event_type: string,         // "dialogue" | "saw_player_do" | "predicate_added"
    summary: string,
    turn: number,
    salience: "low" | "medium" | "high"
  }>,
  last_compacted_at: number
}
```

**Runtime:**
- `record_memory` internal helper called from:
  - NPC dialogue modules (after each exchange)
  - `add_predicate` effect when the predicate involves the NPC
  - Witness hooks (a location's on_enter can record "saw_player_arrive")
- Low-salience entries decay first when over retention.
- Compaction (every N additions): summarize the oldest half into a
  single high-salience entry.
- Dialogue prompt assembler (Ask 5) auto-includes the memory.

**Amends:** `spec/AUTHORING_AND_SYNC.md §npcs/<slug>.md` — add
`memory:` frontmatter. `spec/01_ARCHITECTURE.md §components` — note
`npc_memory` as a first-class component type.

## Ask 5 — shared narrative prompt assembler

**Goal:** eliminate per-module prompt-assembly boilerplate. Every
dialogue-gen or narration-gen module calls one function.

**Runtime:**

```ts
const prompt = await ctx.assembleNarrativePrompt({
  speaker_entity_id,        // npc or character doing the speaking
  player_character_id,      // whose perspective
  purpose: "dialogue" | "narrate" | "examine" | ...
  extra_context?: string,   // module-specific prepend
});
```

Returns a structured prompt:

- World bible (cached via Anthropic ephemeral cache)
- Active biome rules + tone_descriptors + style_anchor
- Speaker: voice.style, voice.examples, recent memory
- Player: inventory summary, recent actions (last 5 turns), active
  relationships with speaker
- Purpose-specific framing

**Amends:** `spec/04_EXPANSION_LOOP.md §prompts` — reference the shared
assembler rather than composing bespoke prompts.

## Single-world philosophy (the "no silos" shift)

`backstory/POSTER_CHILD.md §"Why the sewers should be a biome"` argues
The Daily Grind should stay one world with multiple biomes, not be
split into `the-office` + `the-sewer` + `the-attic`. **This is already
supported** by the engine — a world has unbounded biomes, and location
expansion preserves the world_id. Asks 1–3 (biome rules + items +
clock) are what make multiple biomes feel meaningfully different
inside one world.

No schema change needed. The guidance is authorial, documented in
`backstory/IMPORT_CONTRACT.md §"Current target"`.

## What's NOT in this spec

Tier 3–4 asks from `POSTER_CHILD.md` (named encounters, base-builder
module, orb-icon gen, relationship-graph viz) are deferred to Wave 3+.
The Office v1 can ship playable before any of them.

**Ask 7 (party composition)** is **subsumed** by the async-sync play
model in `ASYNC_SYNC_PLAY.md` (shipped as a designed-status spec
2026-04-20). The campaign-events catch-up panel produces emergent
party dynamics: characters "were with" each other at events, or weren't.
`world.party[]` collapses to a derived view of characters whose last
event was in the same location — no dedicated schema, no separate
composition mechanic. If playtesting shows the emergent pattern feels
insufficient, a more structured party system can layer on top later.

## Sequencing

Recommended order for landing these in Wave 2:

1. **Ask 3 (world clock).** Small schema, enables the inciting
   Tuesday-3:44 mechanic. Unblocks content.
2. **Ask 1 (biome rules).** Largest per-biome feel shift. Depends on
   clock for `time_dilation` to do anything observable.
3. **Ask 5 (prompt assembler).** Foundation for Asks 4 + 2.narrate.
   Touches every AI call site.
4. **Ask 2 (item taxonomy).** Content-driven — shippable without
   modules if the runtime dispatches effect kinds correctly.
5. **Ask 4 (NPC memory).** Highest-quality-of-dialogue payoff. Needs
   Ask 5 to plug into cleanly.

## Cost + risk

- Est. engineering: 1–2 weeks at the data-processing pace this session
  has demonstrated. Each ask is a 3–5 hour end-to-end landing with
  tests.
- **Risk to existing worlds:** zero for Quiet Vale — it uses none of
  these capabilities. The Office has 23 locations authored against
  these assumptions; shipping any subset gates richness for that world
  only.
- **Rule 1 compliance:** every new mutation this spec implies must
  land with isolation tests in the same PR (URGENT rule 7).

## Verification

When each ask ships, mark it below:

- [ ] Ask 1 — biome rules (see `21_BIOME_RULES.md` for full design)
- [ ] Ask 2 — item taxonomy (see `22_ITEM_TAXONOMY.md`)
- [x] **Ask 3 — world clock** (shipped `a6985aa`; see `23_WORLD_CLOCK.md`)
- [ ] Ask 4 — NPC memory (see `24_NPC_AND_NARRATIVE_PROMPTS.md`)
- [x] **Ask 5 — shared prompt assembler** (shipped `d761c03`; see `24_NPC_AND_NARRATIVE_PROMPTS.md`)
