# Weaver — NPC Memory + Narrative Prompt Assembly

## What this spec does

Two related asks from `backstory/POSTER_CHILD.md`:

- **Ask 4: NPC memory auto-injected into dialogue prompts** — a standard memory component that every NPC dialogue call consults, without per-NPC module code.
- **Ask 5: Shared `ctx.assembleNarrativePrompt()` helper** — one function every narrative-producing AI call goes through, so world bible + biome rules + speaker voice + memory + relationships + player context all arrive in every prompt by default.

Together they make every NPC feel like they remember without requiring a bespoke module per character.

**Status:**
- **Ask 5 (shared prompt assembler) shipped 2026-04-20** in commit `d761c03` as `convex/narrative.ts` → `assembleNarrativePrompt` + `internal.narrative.buildPrompt`. Cache_control on the world-bible block gives 90%-off on every call after the first in a 5-min window. Expansion loop already migrated to use it.
- **Ask 4 (NPC memory) not yet shipped.** Design below is target. Additive over current NPC schema; memory plugs into the already-shipped `assembleNarrativePrompt` via an optional `include_memory` flag.

## Memory component

NPC frontmatter (`npcs/<slug>.md` per `AUTHORING_AND_SYNC.md`) gains an optional `memory:` block:

```yaml
---
name: Theo
lives_at: parlour-street-diner
tags: [adult, cook, gruff]
memory:
  default_salience: medium       # low | medium | high
  retention: 20                  # keep the N most recent events; older fold into summary
  track:                         # events the NPC notices by default
    - the_player_visited
    - the_player_chatted
    - the_player_fought_nearby
  ignore:
    - the_player_picked_up_item  # don't clutter Theo's memory with inventory events
memory_initial:                  # author-provided priors, loaded on first encounter
  - { summary: "Theo has been cooking in this diner since before James's parents met.", salience: high }
  - { summary: "He lost a son to the office dungeon. He doesn't talk about it.", salience: high }
---
```

**`default_salience`** — the salience of events captured unless the event itself specifies. Low-salience entries decay first.

**`retention`** — how many detailed entries to keep. Older entries fold into a single "and X earlier events" summary line by a background summarizer.

**`track` / `ignore`** — event-type allowlist/blocklist. By default NPCs track "big" events (dialogue they participated in, fights they witnessed, predicates about them) and ignore "small" events (the player picking up or dropping items elsewhere).

**`memory_initial`** — priors loaded once, first time the NPC is accessed by the runtime. These are always high-retained; they don't decay. This is how you give an NPC backstory without needing a fake conversation to trigger it.

The same component applies to **characters** (player + travelling NPCs) — a character's memory of other characters is symmetric with an NPC's memory of them.

## Memory table

Separate table for event-level detail (not a component, because it's append-mostly):

```ts
// convex/schema.ts
npc_memory: defineTable({
  world_id: v.id("worlds"),
  branch_id: v.id("branches"),
  subject_entity_id: v.id("entities"),      // whose memory this is — NPC or character
  event_type: v.string(),                   // "the_player_visited" | "dialogue_turn" | ...
  summary: v.string(),                      // one-line what-happened
  salience: v.union(
    v.literal("low"), v.literal("medium"), v.literal("high"),
  ),
  turn: v.number(),                         // world turn counter at write-time
  involved_entity_ids: v.array(v.id("entities")),  // who else was in it
  payload: v.optional(v.any()),             // optional structured detail
  created_at: v.number(),
})
  .index("by_subject_turn", ["subject_entity_id", "turn"])
  .index("by_world_subject", ["world_id", "subject_entity_id"])
```

### Event-tap policy

A small set of runtime hooks writes memory rows automatically:

- **Dialogue turn.** When Sonnet generates NPC dialogue, a memory row is written for the NPC and for every player character in the scene (`event_type: "dialogue_turn"`, summary: first 80 chars of the turn).
- **Location entry with NPC present.** `event_type: "the_player_visited"`, summary: "Player arrived."
- **Combat witnessed.** `event_type: "the_player_fought_nearby"`.
- **Predicate added involving the NPC.** `event_type: <predicate_name>`, summary: the predicate's payload.

Author can extend the event taps via the NPC's `memory.track` list; the runtime defaults cover the common cases.

### Salience decay

A weekly job (or on-write overflow) compresses memory:

1. Scan NPCs with `count(npc_memory rows) > 2 * retention`.
2. Take the oldest `count - retention` rows.
3. Sonnet summarize them into one "earlier: <summary>" row with `salience: low`.
4. Delete the summarized-from rows.

Cheap: Sonnet call per overflow is ~$0.001. Runs rarely (most NPCs don't see enough events to overflow).

## The `ctx.assembleNarrativePrompt()` helper

One function, called by every module/runtime path that produces AI-generated narrative. Its job: make sure the model always has the right context without the caller thinking about it.

```ts
// packages/engine/ai/prompts/assemble.ts
export async function assembleNarrativePrompt(
  ctx: ActionCtx,
  args: {
    speaker_entity_id: Id<"entities">    // whose voice this is (an NPC, character, or the narrator entity)
    world_id: Id<"worlds">
    branch_id: Id<"branches">
    player_character_id: Id<"characters">  // the player whose action triggered this
    extra_context?: string                 // step-specific addition
    cache_breakpoint_after?: "bible" | "bible_plus_speaker"  // where to put cache_control
  },
): Promise<{
  system: AnthropicSystemBlocks
  user_context: string
}>
```

Output layout (wrapped for cache_control appropriately):

```
<system>
You are writing in-character for <speaker>. Follow the world bible.
Content rating: <rating>. Do not contradict established facts.
</system>

[CACHE BREAKPOINT — stable across all prompts in this world]

<world_bible>
  {bible.md serialized}
</world_bible>

<active_biome>
  {biome.description + biome.rules summary for context}
</active_biome>

[CACHE BREAKPOINT — stable across all prompts in this biome]

<speaker>
  name: <speaker.name>
  voice:
    style: <speaker.voice.style>
    examples:
      - ...
</speaker>

<speaker_memory>
  high_salience:
    - "Theo has been cooking in this diner since before James's parents met."
    - "He lost a son to the office dungeon."
  recent:
    - turn 47: dialogue_turn — "Theo grunted noncommittally when James mentioned the raise."
    - turn 44: the_player_visited — "Player arrived after a late night. Smelled of something wet."
  earlier: 6 older entries folded
</speaker_memory>

<relationships_involving_speaker_and_player>
  {relations table rows subject==speaker, object==player_character or vice versa}
</relationships_involving_speaker_and_player>

<player_current_context>
  character: <name>, level X, inventory summary: <list>
  recent actions: <last 3 turns>
</player_current_context>

<task>
  {extra_context from the caller}
</task>
```

The cache breakpoints matter for Anthropic prompt-caching economics (see `04_EXPANSION_LOOP.md` and `ISOLATION_AND_SECURITY.md` rule 7). Putting world_bible + biome stable-content behind one breakpoint lets that large chunk (~5-15K tokens) cache across every call in that biome for that world.

### Caller example

```ts
// A module step handler that generates NPC dialogue:
const prompt = await ctx.assembleNarrativePrompt(ctx, {
  speaker_entity_id: theo_id,
  world_id: ctx.world_id,
  branch_id: ctx.branch_id,
  player_character_id: ctx.character.id,
  extra_context: `The player said: "${player_input}". Respond in 1-3 sentences.`,
})

const result = await ctx.ai.narrate({
  model: "claude-sonnet-4-6",
  max_tokens: 256,
  system: prompt.system,
  messages: [{ role: "user", content: prompt.user_context }],
})
```

The module doesn't think about world bible, biome rules, speaker voice, memory, or relationships. They arrive. Consistency by default.

### What the caller overrides

`extra_context` is the only caller-specific piece. Everything else is assembled from world+speaker+player state. If a caller genuinely needs to *not* include memory (rare — a dream sequence where Theo shouldn't remember), the helper accepts `include_memory: false`.

## Memory-write after AI call

Dialogue turns are self-recording. Pattern:

```ts
// After the narrate call:
await ctx.db.insert("npc_memory", {
  world_id, branch_id,
  subject_entity_id: theo_id,
  event_type: "dialogue_turn",
  summary: result.text.slice(0, 80),
  salience: "medium",  // override via annotation if the turn was high-stakes
  turn: world.turn_counter,
  involved_entity_ids: [player_character_id],
  created_at: Date.now(),
})
await ctx.db.insert("npc_memory", {
  // same event, from the player's perspective
  subject_entity_id: player_character_id,
  ...
})
```

Each narrative AI call produces symmetric memory rows (for every involved entity with a `memory:` component).

## Salience heuristics

Caller can mark high-salience events:

```yaml
- { kind: narrate, prompt: "...", salience: high, memory_event_type: "first_meeting" }
```

Default salience is the NPC's `memory.default_salience`. Events tagged in `memory.track` override to high if the track entry says so:

```yaml
memory:
  track:
    - { event: "the_player_died_nearby", salience: high }
```

## Performance

### Memory query cost

The helper reads `npc_memory` by `by_subject_turn` index for recent + sorts by salience for high-retained. Typical call: ~20 rows scanned. Sub-millisecond.

### Prompt size

World bible (cached): ~5-15K tokens.
Biome rules + description: ~300-500 tokens.
Speaker voice + memory: ~500-1500 tokens.
Relationships: ~100-300 tokens.
Player context: ~200-400 tokens.
Extra context: caller-dependent, typically ~100-500 tokens.

Total non-cached: ~1.5-3K tokens per narrative call. Within Sonnet's budget; cache-amortizable.

### Cost

Per NPC dialogue turn: ~$0.003 Sonnet + cached bible (~90% off). Sustainable for a family session.

## Migration

Existing NPCs (none authored in Quiet Vale yet) can adopt `memory:` any time. Without it, dialogue falls back to current per-module prompt assembly (no memory, no shared context). Adding `memory:` is always additive.

## What this enables

- **Theo remembers what James told him** without Theo's module maintaining a per-conversation-turn state machine.
- **Anesh's long arcs** (Book 1-5 character arc) — 5 books of cumulative interactions compress into `memory_initial` priors + on-the-fly accumulating memory. No per-book re-authoring.
- **Goldfish-brain NPCs** are an explicit choice (omit `memory:`), not the default.
- **Portable NPCs across sessions.** Memory rows travel with the NPC entity through branches / forks.

## Dependencies

- `22_ITEM_TAXONOMY.md` — the `narrate` effect is the primary consumer of `assembleNarrativePrompt`.
- `21_BIOME_RULES.md` — biome rules inform the prompt's `<active_biome>` section.
- `23_WORLD_CLOCK.md` — `turn` field on memory rows uses `world.turn_counter`.
- `18_CHAT_ARCHITECTURE.md` — chat messages can optionally produce memory rows (configurable per NPC).

## Open questions

- **Cross-branch memory.** When a branch forks, memory rows copy or get a fresh start? **Recommendation: copy.** Memory is authored state; branches inherit it. A later `reset_npc_memory` mutation can wipe if a narrative wants a clean slate.
- **Memory visibility.** Can players see an NPC's memory log for debugging ("why is Theo acting like I stole from him")? **Recommendation: no in Wave 2.** Owner-only debug panel via the audit log suffices.
- **Memory export.** Should `weaver export` include `npc_memory` rows? **Yes** — they're authored/accumulated state belonging to the world. Export per-NPC memory as a sibling file `npcs/<slug>/memory.ndjson` or similar. Defer shape decision to export implementation.
