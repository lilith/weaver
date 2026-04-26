# Context & recall — events log + tiered prompt assembler

**Status:** designed + foundation slice 2026-04-24. Wired into `ctx.narrate` (flows.ts) and `applyOption` (locations.ts) at v1; fuller wiring (expansion completion, item effects, era advance) is the next slice. The tiered assembler is implemented in `@weaver/engine/context` but not yet substituted into existing call sites — that's the third slice.

## Why

Narrative-heavy worlds need the AI to **remember** — every line the player has read, every NPC they've spoken with, every item they've handled — without choking on a 200K-token prompt every turn. Two architectural moves let us have both perfect recall and fast turns:

1. **Two truths kept separate.** *World state* is what's true (the bible, character HP, inventory). *Reading log* is what each character has actually witnessed. They overlap in single-player, diverge in async-sync. The reading log is the source of truth for "what does this player know."
2. **Tiered context assembler.** Every Opus/Sonnet/Haiku call goes through one shape: pinned bible (cache-stable, free after first call) → recent verbatim (last K events the player saw, full text) → compressed history (Haiku-summarized, salience-weighted, per-thread). The split lets us pin once, summarize cheaply, and only the tail invalidates per turn.

## Data shape

### `events` table

Append-only log; one row per narrative-significant beat. Columns:

| | |
|---|---|
| `world_id`, `branch_id` | scope |
| `character_id?` | the actor (null for ambient world events) |
| `location_id?` | where the event occurred |
| `npc_entity_id?` | NPC referenced/present |
| `item_slug?` | item involved |
| `thread_id?` | timeline-thread tag (null = canonical "main") |
| `kind` | discriminator — `narrate / dialogue / option_pick / location_enter / expansion / give_item / take_item / use_item / damage / heal / era_advance / world_seed` |
| `body` | the prose the player saw (≤8KB) |
| `payload?` | kind-specific extras |
| `salience` | `low / medium / high` — drives compression |
| `turn`, `at` | ordering |
| `embedding?` | reserved for v2 vector recall; unused at v1 |

### Indexes (compound, branch-prefixed per URGENT rule 1)

- `by_branch_location_time` → "everything that happened here"
- `by_branch_npc_time` → "every appearance of Mara"
- `by_branch_item_time` → "the orb's history"
- `by_branch_character_npc_time` → "us together" — primary dialogue-prompt slab
- `by_branch_character_thread_time` → "what this player witnessed in this thread" — primary narrate-prompt slab
- `by_branch_kind_time` → "every option the player picked"

### Single chokepoint: `internal.events.writeEvent`

Every call site producing player-visible text routes through one mutation. Sparse columns; only fill what's relevant. `flows.ts ctx.narrate` writes a `dialogue` (or `narrate`) event; `locations.ts applyOption` writes an `option_pick` plus one `narrate` per says-line plus a `location_enter` if movement occurred. The chokepoint also exists for items / damage / heal / expansion completion / era advance — those are wired in v2.

## Tiered assembler — `@weaver/engine/context`

Pure-logic helpers + types + per-call-site presets. No Convex, no network. Convex actions read slabs from the events table, then call `assemblePrompt({ pinned, verbatim, summary, npc_memory, task, call_site, ai_quality })` to build the request.

### Per-call-site policy

| call site | tier (standard) | verbatim | npc_memory | summary | temperature |
|---|---|---|---|---|---|
| narrate | sonnet | 6 | yes | yes | 0.9 |
| dialogue | sonnet | 12 | yes | yes | 0.85 |
| expansion | opus | 3 | no | yes | 0.95 |
| intent | haiku | 2 | no | no | 0.2 |
| icon_prompt | haiku | 0 | no | no | 0.7 |
| schema_design | opus | 0 | no | no | 0.4 |
| narrate_effect | sonnet | 4 | no | yes | 0.85 |
| haiku_summarize | haiku | 30 | no | yes | 0.3 |

### `ai_quality` toggle

Per-world preset on `worlds.ai_quality: "fast" | "standard" | "best"`. Set by the owner via `worlds.setAiQuality`. Maps:

- **fast** — Haiku for narrate/dialogue (200K context, $1/$5 per MTok), Sonnet for expansion. Prefer when a family wants the cheapest possible runtime; gives up subtlety on character voice.
- **standard** — current defaults; Sonnet narrative, Opus expansion.
- **best** — Opus for everything narrative (1M context, $5/$25). 5× the verbatim headroom and noticeably better voice; ~5× the cost. Worth flipping for "important" worlds or scenes.

Haiku 4.5 is **200K context** (not 1M). Sonnet 4.6 and Opus 4.7 are 1M. The assembler refuses to assemble a prompt larger than 80% of the model's input budget so we always leave room for output.

### Cache breakpoints

`anthropic.cache_control: ephemeral` markers go on:

1. End of system text — pinned bible + character bio. Cache-stable; first prompt pays, the next ~5 minutes ride the cache.
2. End of summary block — stable across turns between compactions; Haiku-summarized at quiet moments.

Verbatim + task always invalidate per call.

## Recall queries

`convex/events.ts` exposes both session-gated (member-readable) public queries and unsession internal queries the action layer composes:

- `eventsAtLocation` / `internalEventsAtLocation`
- `eventsForNpc` (any character's history with this NPC)
- `eventsForItem`
- `eventsForCharacterNpc` / `internalEventsForCharacterNpc` — primary dialogue slab
- `eventsForCharacterThread` / `internalEventsForCharacterThread` — primary narrate slab

All bounded by `limit` (default 30) + optional `min_salience`.

## Compaction (next slice)

Old events get folded into running summaries by Haiku at quiet moments. Per-thread compaction so timeline-jumping stays coherent. Salience drives priority: `high` events stay verbatim across many compactions; `low` events fold first. The exact cron + summary table shape is the next slice; the v1 assembler tolerates an absent summary just fine.

## What's deferred

- **Semantic recall (vector index).** `embedding` column is reserved; the action will compute cosine similarity in JS over a structured-pre-filtered slab when this lands. Defer until structured indexes prove insufficient (year+, multi-family).
- **Async-sync witness model.** Single character/single witness today; when multi-player ships, split `witnesses[]` from `events` so two players in the same room each see the events.
- **Compaction cron** + per-thread running-summary table. v2.
- **Full call-site substitution.** Existing `ctx.narrate` / expansion / intent calls still build their own prompts; the next slice rewrites each to call `assemblePrompt` so the cache breakpoints and tier-toggle take effect everywhere.
- **Admin surface for `ai_quality`.** Mutation exists; UI lives in `/admin/settings` next pass (a 3-button radio for fast/standard/best).

## Performance + maintainability

For the structured part — Convex's compound indexes are O(log n) lookups, our worst-case slab is bounded at `limit:30` per query, and a long campaign produces ~25K events per character (5/turn × 5K turns × 1 character). Well below where Convex feels slow. **No Postgres needed**; no extension required.

When semantic recall ships, it lives in the same Convex row via the `embedding` column — no second database. If we ever outgrow that (multi-family scale, millions of events), Railway-managed Postgres + pgvector is the natural escape hatch, but it's a v3 problem.

## Isolation

- `events` rows are world+branch-scoped. Every read query resolves session → membership before returning rows.
- Internal queries skip session resolution; the calling action is responsible for upstream auth.
- `setAiQuality` is owner-only; adversarial Playwright test alongside the mutation.
