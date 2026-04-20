# Weaver — Eras and Progression

**Status:** designed
**Flag:** `flag.eras`
**Registry:** `FEATURE_REGISTRY.md` #16
**Last updated:** 2026-04-20

## Problem

A multi-book story (The Daily Grind: 5 books, 789K words) has arc beats that the world passes through — the office invasion, the sewer discovery, the Lair establishment, faction war, resolution. Side quests are easy (the AI invents scenes, players steer). **Arc beats are hard:** the world and characters have to shift in authored ways that can't be wholly emergent, but also can't ship as a flat "everything exists at import" bundle — that ruins discovery.

This spec is how the world progresses through authored eras while staying collaborative.

## The three dimensions

Current schema carries **entity × current_version**. The missing dimensions:

- **Era** — which story-chapter a piece of world-state belongs to. The office at Era 1 is "cubicles and fluorescents." At Era 2 (post-invasion) it's "scorched desks, Karen-drones humming." Both exist as distinct authored states.
- **Personal era** — per-character track of which arc beats they've personally participated in / witnessed / acknowledged via catch-up. Mara may be at Era 2 (saw the invasion) while Jason is at Era 1 (hasn't yet).

One shared world at a canonical active era. Every character sees the world's current state. What differs is *narrative memory* — whether they lived through the transition that produced this state, or arrived after.

## Core model

### World-level

```ts
worlds: {
  ...existing...,
  active_era: v.number(),          // default 1. Canonical "now" for the world.
}
```

The world is always at one era at a time. Advancing is a deliberate ritual (§"Era transition" below); rolling back is supported but rare.

### Entity-level

Every entity carries its era-specific states as parallel versions:

```ts
artifact_versions: {
  ...existing...,
  era: v.number(),                 // which era this version belongs to
}

entities: {
  ...existing...,
  era_version_map: v.optional(v.any()),   // { 1: versionN, 2: versionM, 3: versionO }
}
```

Rendering an entity: `picked = era_version_map[world.active_era] ?? (largest version where version.era <= world.active_era)`. Falls back to the nearest prior era if no explicit version for the current one — many entities don't change every era.

An entity that lives across all eras without changing has a single artifact_version with `era: 1`; it renders the same at every active era.

An entity that's era-specific (Karen, who only exists from Era 2 onward) has its first version at `era: 2`. At Era 1, the entity has no resolvable version → it's effectively hidden. Templates and option targets referring to it are gated (see §"Era gating" below).

### Character-level

```ts
characters: {
  ...existing...,
  personal_era: v.number(),                           // default 1
  arc_beats_acknowledged: v.array(v.string()),        // event_ids from campaign_events
  personal_chronicle: v.optional(v.string()),         // AI-woven summary of this character's journey
}
```

`personal_era` is the highest arc-beat era this character has personally acknowledged. Updated when:
- The character participates in a gating beat firsthand.
- The character opts into "I was with them" in a catch-up panel (per `ASYNC_SYNC_PLAY.md`).
- Family-mod explicitly advances the character (rare, admin-only).

`arc_beats_acknowledged` is the specific-event log (fine-grained). `personal_era` is the summary (coarse).

## Authoring — one file per era

The convention locked 2026-04-20: each entity's per-era state lives in its own file with an era suffix:

```
worlds/the-office/
├── bible.md                              (era-agnostic; facts inherit forward)
├── bible.era-2.md                        (era-2-specific facts, if needed)
├── biomes/
│   ├── office-dungeon-outer.md           (era 1)
│   └── office-dungeon-outer.era-2.md     (era 2 — post-invasion rules differ)
├── characters/
│   ├── james.md                          (era 1)
│   ├── james.era-2.md                    (era 2 — has skulljack now)
│   └── karen.era-2.md                    (karen first exists in era 2)
├── npcs/
│   ├── theo.md                           (era 1)
│   └── theo.era-3.md                     (era 3 — lost his son, voice shifts)
├── locations/
│   ├── fort-door.md                      (era 1)
│   ├── fort-door.era-2.md                (era 2 — besieged)
│   └── fort-door.era-3.md                (era 3 — fortified base)
```

**Inheritance rules:**
- A file without an `.era-N.md` suffix is treated as era 1 (the oldest era any file for that entity exists at).
- If an entity has files at eras 1 and 3 but not 2, era 2 inherits from era 1.
- If a file exists at era 2 but not era 1, the entity doesn't exist at era 1 (Karen's case).
- `bible.md` frontmatter gains optional `era: 1` / `era: 2` — era-2 bible layers over era-1 additively (new facts accumulate, taboos tighten, tone may shift per the stage-shift).

**Frontmatter carries the era:**
```yaml
---
name: Fort Door
biome: office
era: 2                    # explicit; importer reads from filename too and cross-checks
---

Era-2 description of Fort Door — scorched walls, smell of ozone, Anesh's
cot still where he left it before the invasion.
```

The importer resolves per-entity cross-references within an era first, then falls back to earlier-era targets.

### Archiving intent

One-file-per-era keeps each era's authoring reviewable standalone. Git-diffing `fort-door.era-2.md` tells the reader what changed in Era 2 without scrolling through all versions. The importer handles combining them into the `era_version_map` at write time.

## Era gating

Three gating primitives, each serving a different concern:

### 1. Bible-prompt filtering

When building an AI prompt (expansion, dialogue, narration), the serialized world bible only includes facts/biomes/characters/items whose `era <= world.active_era`:

```ts
function serializeBibleForActiveEra(bible, active_era) {
  return {
    ...bible,
    characters: bible.characters.filter(c => !c.era || c.era <= active_era),
    biomes: bible.biomes.filter(b => !b.era || b.era <= active_era),
    established_facts: bible.established_facts.filter(f => !f.era || f.era <= active_era),
    taboos: bible.taboos,          // taboos always apply regardless of era
  }
}
```

The AI *literally cannot spoil Era 2* because it doesn't know Era 2 exists until the world advances.

### 2. Entity visibility gating

A location with `era: 2` returns 404 when the world is at Era 1. The URL is valid but unreachable. Options that target an Era-2 entity from an Era-1 location hide automatically via a condition on active_era.

Expansion-loop target resolution: when the player (or prefetch) picks an unresolved slug, candidate expansions don't reference entities beyond the current era. The `expansion_hint` fed to Opus is filtered to era-appropriate context.

### 3. Arc-beat personal-era gating

Some options are arc-beat-specific (climb the east stairwell door at 3:44 on Tuesday). These carry a `gating_beat: <event_id>` field. The option is hidden for any character whose `arc_beats_acknowledged` doesn't include that event.

When a character's `personal_era < world.active_era`, certain options are hidden — they lack the context to take them. UI shows a subtle hint: "something about this place is waiting for you to catch up." Catch-up panel (per `ASYNC_SYNC_PLAY.md`) is the normal path to acknowledge.

## Background pressure (between beats)

Between arc-beat transitions, low-stakes tension accumulates in the background so the next beat lands with weight instead of appearing out of thin air.

```ts
worlds: {
  ...existing...,
  arc_pressure: v.optional(v.any()),   // { karen_activity: 0-100, sewer_awareness: 0-100, ... }
}
```

Authored as part of the bible:

```yaml
# bible.md frontmatter
arc_pressure_schema:
  karen_activity:
    description: "How much Karen's hivemind has spread through the office."
    starts: 0
    ticks_up_per_turn: 0.2        # slow drift
    conditions_that_accelerate:
      - when: "character.visited.hallway-three"
        amount: 2
      - when: "world.time.day_of_week == 'mon'"
        amount: 1
    surfaces_as:
      - 30: "subtle — staplers occasionally move when no one's watching"
      - 60: "moderate — co-workers seem slightly off; someone's always humming"
      - 90: "high — gurneys in the corners; Karen appears in distant doorways"
    triggers_arc_beat:
      at: 100
      event_id: the_invasion
      era_target: 2
  sewer_awareness: { ... similar ... }
```

Each turn, a runtime tick updates `world.arc_pressure` per the schema. Location prose templates can read `world.arc_pressure.karen_activity` to adapt description ("the fluorescents hum at a frequency your teeth can feel today"). Catch-up panels surface high-pressure changes ("while you were gone, Karen's presence intensified"). When pressure crosses its threshold, the arc beat auto-fires (or queues, gated by family consent).

Pressure is **authored, not AI-generated**. It's a knob the world-bible author provides; the runtime just ticks it.

## Era transition — the ritual

Advancing the world era is a deliberate family action. Not automatic, not single-player-decided.

```ts
// worlds.advanceEra mutation
export const advanceEra = mutation({
  args: { world_id, target_era, confirming_user_ids: v.array(v.id("users")) },
  handler: async (ctx, args) => {
    // 1. Validate: requesting user is owner or family_mod.
    // 2. Validate: target_era == active_era + 1.
    // 3. Validate: confirming_user_ids includes all adult world_memberships (minors get
    //    a heads-up notification, not a vote, for content-rating reasons).
    // 4. Look up the era-transition skeleton (era's authored chronicle + manifest).
    // 5. Kick off the stage-shift action (async, see below).
    // 6. Return the in-progress transition id so UI can subscribe.
  }
})
```

### The stage-shift action

```ts
// convex/era.ts - internal action
export const runStageShift = internalAction({
  args: { world_id, from_era, to_era, transition_id },
  handler: async (ctx, { world_id, from_era, to_era, transition_id }) => {
    // 1. Load world state: all entities, current chronicles, arc_pressure snapshot.
    // 2. Load era-target skeleton from authoring: what must happen this era.
    // 3. For each entity that the skeleton flags as changing:
    //    a. Call Opus with: prior-era version + skeleton-change-description + family-state-context.
    //    b. Parse new era-version payload.
    //    c. Write as a new artifact_version with era = to_era.
    //    d. Update entities.era_version_map[to_era] = version.
    // 4. Call Opus to write the era-transition chronicle — narrates what happened,
    //    specific to this family's Era-(from) play.
    // 5. Write the chronicle to the chronicles table.
    // 6. Call Opus to write per-character personal_chronicle updates.
    // 7. Update worlds.active_era = to_era.
    // 8. For characters whose personal_era < from_era, leave them — they catch up
    //    via the async-sync catch-up panel as usual.
    // 9. Invalidate pending prefetches in this world.
    // 10. Mark transition_id status = complete.
  }
})
```

The stage-shift is expensive — one Opus call per changed entity (~$0.04 each) + two chronicle calls + per-character chronicle calls. For a 40-entity world with ~20 entities changing in the transition, budget ~$1-2 per era transition. Happens 4 times total over the full Daily Grind arc. $4-8 total per playthrough. Affordable.

The transition runs in the background; the family gathers at family-LAN night to read the chronicle together when it's ready. Watching-the-world-change becomes a shared reading moment.

### Era rollback

Not quite reversible but mostly. `worlds.rollbackEra`:

1. Walk `entities.era_version_map` for target era; ignore (don't delete) the entries beyond.
2. Set `worlds.active_era = target_era`.
3. Mark the chronicle entry as "uncanonized" but preserved.
4. Characters whose `personal_era` exceeded target are nudged back to target (their memory of post-target events persists in their personal_chronicle; they just can't take post-target actions anymore).

Rare. Useful if an era-transition was premature or went badly. Not destructive — all artifacts stay in the DB.

## Chronicles table

```ts
chronicles: defineTable({
  world_id: v.id("worlds"),
  branch_id: v.id("branches"),
  era_from: v.number(),
  era_to: v.number(),
  summary_blob_hash: v.string(),                 // AI-generated era-transition narrative
  stage_shift_manifest_blob_hash: v.string(),    // what entities changed + how (for audit)
  authored_at: v.number(),
  authored_by_user_id: v.id("users"),            // who triggered the advance
})
  .index("by_world_era", ["world_id", "era_to"]),
```

Chronicles are read-only history. They show in the journal under a "World Chronicle" section, browsable by era. They're also fed into the bible prompt at subsequent eras as `<prior_chronicles>` so Opus has the narrative continuity.

## Interaction with async-sync play

`ASYNC_SYNC_PLAY.md` covers per-character progression through a single era. Eras are the *cross-era* layer:

- `personal_era` is a coarse counter built from `arc_beats_acknowledged` cardinality within the era.
- Advancing `personal_era` happens via the catch-up panel for gating events, or automatically for non-gating events.
- When the world's `active_era` advances, characters whose `personal_era < active_era` are still in the prior era narratively. Their experience: the world physically looks different (post-invasion), but dialogue/prose treats them as not-having-lived-through-it. NPCs may say "you weren't there for what happened, were you?" to them.

Catch-up across era boundaries works the same as within-era: the panel surfaces "while you were gone, [era transition narrative]." The character opts in ("I was at the fall of Fort Door") or skips ("I was elsewhere"). If they opt in, `personal_era` bumps to the transition's target era; if they skip, it stays.

## Interaction with the expansion loop

The expansion loop runs against the current era's bible. Opus at Era 2 knows only Era-1-and-Era-2 content. Invented entities (drafts) are tagged `era: <active_era>` at creation. Entities referenced in Opus's output are validated: mentions of era-beyond entities trigger a regen with tightened constraints.

## Interaction with art

`entity_art_renderings.era: v.optional(v.number())` (already noted in `ART_CURATION.md`):

- Mode-picker shows variants for the active-era first.
- Other-era variants are accessible via a "see other eras" drawer — a family who wants to remember Era 1's cozy Fort Door can still flip back to those variants.
- On era transition, new conjures default to the current era. Legacy variants stay in the wardrobe tagged with their original era.

## Skeleton authoring pattern

Era skeletons are authored in `worlds/<world>/eras/<N>.skeleton.md`:

```yaml
---
era: 2
title: "The Invasion"
prerequisite_pressures:
  karen_activity: 80
  sewer_awareness: 50
target_entities:
  - slug: fort-door
    change: "besieged; Anesh wounded; Alanna took charge of defense"
  - slug: office-dungeon-outer
    change: "Karen-drones active; hostile; navigation partially collapsed"
  - slug: karen
    kind: new_character
    change: "first appearance; she's a coordinator role, not personal antagonist"
must_happen_beats:
  - event_id: the_invasion
    gating: true
    forced_choices:
      - description: "One character takes the skulljack from the fallen. Family picks who."
        offered_to: all_adult_characters
        state_change: { target: "chosen_character.inventory.skulljack", value: true }
      - description: "A permanent cost lands. Family picks who pays."
        offered_to: all_adult_characters
        state_change: { target: "chosen_character.state.paralyzed", value: true }
---

Era summary (the bridge-chapter narration):

Two weeks after the last entry in the prior chronicle. The office had been
getting stranger. Then, on a Tuesday morning... [author writes 2-3 paragraph
high-level outline; stage-shift Opus call expands into specific family-adapted
prose].
```

The skeleton is the authorial contribution. The stage-shift action is the AI contribution. Authors write ~2-4 skeleton files per world (one per era transition). Each ~500-1500 words. A single author can draft a 5-era campaign in a weekend.

Stage-shift quality is bounded by skeleton quality. A sparse skeleton → generic AI expansion. A detailed skeleton → tailored, resonant AI expansion. The author has full authorial control at the level of abstraction they care about, and the AI fills in scene-by-scene detail below that.

## Migration path

Existing Quiet Vale has no era-awareness; all entities default to era 1 on the next deploy, `worlds.active_era = 1`. The world works exactly as before. When (if) the family wants to grow the Vale into a multi-era story, they author era-2 files and advance.

The Office imports in `backstory/stories/argus-daily-grind/worlds/the-office/` currently carry Era-1 content only. Future imports (`the-office/eras/2.skeleton.md`, `characters/james.era-2.md`, etc.) extend additively.

## Schema additions summary

```ts
worlds.active_era: v.number()
worlds.arc_pressure: v.optional(v.any())

entities.era_version_map: v.optional(v.any())   // { era_number: version_number }

artifact_versions.era: v.number()

characters.personal_era: v.number()
characters.arc_beats_acknowledged: v.array(v.string())
characters.personal_chronicle: v.optional(v.string())

chronicles: defineTable({ ... as above ... })

// On campaign_events (from ASYNC_SYNC_PLAY.md):
campaign_events.gating: v.optional(v.boolean())   // arc-beat events need personal-era advance
campaign_events.era: v.number()                    // which era this event happened in
```

See `09_TECH_STACK.md` for the full schema shape.

## Test surface

- **Unit:** era-version resolution picks the right version for various era/entity combinations; era filter on bible serialization excludes correct entities.
- **Property:** era advancement is monotonic; personal_era never exceeds world.active_era.
- **Isolation-adversarial:** character at personal_era=1 cannot take options gated to era=2; cannot read prose conditioned on era>=2 state; cannot resolve slugs to era-2-only entities.
- **Integration:** run a full Era-1 → Era-2 transition on a fixture world; verify stage-shift produces era-2 versions for flagged entities; verify chronicle appears; verify pre-shift prefetches invalidate.
- **E2E:** family-LAN night flow — advance_era mutation fires, background action runs, chronicle reveals, world visibly changes at the next page-load.

## Cost summary

- Background arc-pressure ticking: free (runtime math).
- Era transition stage-shift: ~$1-2 per transition (depending on entity count + character count).
- Chronicle generation: ~$0.05 per era.
- Personal_chronicle per character: ~$0.03 per character per era = $0.15 for a 5-person family.
- Full 5-era Daily Grind playthrough: ~$5-10 in era-transition cost across weeks of play. Trivial on the family budget.

## What this does NOT solve

- **Emergent off-book drift.** If the family wanders in a direction no era covers, Opus invents stuff. That's the feature.
- **Arc beats that depend on specific character state** the family didn't reach. The skeleton's `forced_choices` mechanism lets the arc adapt; beyond that, the author has to design arcs robustly.
- **Cross-world era sharing** — each world advances independently. The Daily Grind in Lilith's instance may be at Era 3 while another family's is at Era 1. No cross-family synchronization (that's Wave 4+ anyway).

## Open questions

- **Per-character personal era advance granularity.** Is it coarse (one number per character) or fine (per-arc-beat)? Current spec has both: `personal_era` is coarse, `arc_beats_acknowledged` is fine. Coarse is used for gating options; fine is used for narrative memory and dialogue. Works?
- **Era rollback consequences.** Rolling back loses nothing in the DB but does the active world feel "undone"? Likely yes — family-mod use only; not a UI for normal play.
- **Era-transition chronicle tone.** Is Opus writing in the world's bible tone, or in a "meta" tone (stepping back)? Current spec leans into the world's tone — the chronicle is an in-world "turning of the page." If the meta-tone is preferred, swap the prompt. Playtest call.
