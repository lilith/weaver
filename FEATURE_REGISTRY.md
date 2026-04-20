# Weaver — Feature Registry

*Single source of truth for every feature in the system. Status-tracked, flag-gated, playtest-observable. **Read before adding a new spec or pulling a shipped one.***

Why this file exists: Weaver is accumulating features fast. Some will survive playtest; some won't. The architecture has to make "pull a feature" a flag flip, not an archaeological dig. And it has to make the state of each feature legible across context-compaction boundaries so no one has to re-derive the state of the world from git history.

## How to read this file

Each feature carries these fields:

- **name** — short identifier, used as the flag key.
- **status** — `designed | implementing | playtesting | shipped | retired | pulled`. Definitions in §"Status definitions."
- **spec** — primary spec file (the authoritative design).
- **code** — where the feature's entry points live (Convex / packages / apps).
- **flag** — the `feature_flags` key that gates it at runtime.
- **deps** — other features this depends on (gates must resolve before enabling).
- **playtest** — link or inline notes capturing what worked, what didn't.
- **rollback** — what pulling this feature entails beyond flipping the flag.
- **owner** — who last touched this feature in a meaningful way.

## Status definitions

- **designed** — spec written; no code. Safe to iterate on the spec; no playtest exposure.
- **implementing** — code in flight. Flag exists in the DB but defaults off. Behind the flag is WIP; the world without the flag is still production-stable.
- **playtesting** — code complete; flag on for the family instance only. Observations accumulate in the `playtest` field. Kill-switch is one flag flip.
- **shipped** — flag default-on for new worlds; feature is part of the product.
- **retired** — feature was once shipped, has been superseded by another feature, flag forced off, code deleted after grace period. Spec stays as historical record (marked DEPRECATED).
- **pulled** — feature failed playtest; flag forced off; code may linger in a `pulled/` archive dir until decision to revive or delete. Spec stays (marked PULLED with the post-mortem inline).

Transitions: `designed → implementing → playtesting → shipped` is the happy path. Any state can transition to `pulled`. `shipped → retired` when a successor is shipped.

## Active registry

| # | name | status | spec | flag | deps | owner |
|---|---|---|---|---|---|---|
| 1 | blob_storage | shipped | `spec/12_BLOB_STORAGE.md` | — (foundational) | — | build |
| 2 | multi_tenant_isolation | shipped | `spec/ISOLATION_AND_SECURITY.md` | — (foundational) | blob_storage | build |
| 3 | magic_link_auth | shipped | `spec/09_TECH_STACK.md` §Auth | — | — | build |
| 4 | step_state_machine_flows | **shipped** | `spec/01_ARCHITECTURE.md` §Durable runtime | `flag.flows` (on: sandbox/qv/office) | multi_tenant_isolation | build |
| 5 | expansion_loop | shipped | `spec/04_EXPANSION_LOOP.md` | `flag.expansion` (forced on) | blob_storage | build |
| 6 | drafts_and_journeys | shipped | `spec/19_JOURNEYS_AND_JOURNAL.md` | `flag.journeys` | expansion_loop | build |
| 7 | art_pipeline_scheduled | **retired** (by `art_curation`) | — | superseded | — | build |
| 8 | household_sharing | shipped | `spec/HOUSEHOLD_AND_SHARING.md` | — | magic_link_auth | build |
| 9 | importer_cli | shipped | `spec/AUTHORING_AND_SYNC.md` | `flag.import_cli` (on) | multi_tenant_isolation | build |
| 10 | world_clock | shipped | `spec/23_WORLD_CLOCK.md` | `flag.world_clock` (on) | — | build |
| 11 | narrative_prompt_assembler | shipped | `spec/24_NPC_AND_NARRATIVE_PROMPTS.md` §Ask 5 | — (library) | world_clock | build |
| 12 | art_curation | **playtesting** (wardrobe + ref-image pipe shipped) | `spec/ART_CURATION.md` | `flag.art_curation` (on: sandbox/qv/office) | blob_storage, effect_router | build |
| 13 | expansion_streaming | **playtesting** | `spec/04_EXPANSION_LOOP.md` §Streaming | `flag.expansion_streaming` (on: sandbox/qv/office) | expansion_loop | build |
| 14 | text_prefetch | **playtesting** | `spec/04_EXPANSION_LOOP.md` §Predictive text prefetch | `flag.text_prefetch` (on: sandbox/qv/office) | expansion_loop | build |
| 15 | async_sync_campaign | designed | `spec/ASYNC_SYNC_PLAY.md` | `flag.campaign_events` | drafts_and_journeys | spec |
| 16 | eras_and_progression | **playtesting** (v1 + v2 catchup) | `spec/25_ERAS_AND_PROGRESSION.md` | `flag.eras` (on: sandbox/qv/office) | narrative_prompt_assembler | build |
| 17 | biome_rules | **playtesting** | `spec/21_BIOME_RULES.md` | `flag.biome_rules` (on: sandbox/qv/office) | world_clock, effect_router | build |
| 18 | item_taxonomy | **playtesting** | `spec/22_ITEM_TAXONOMY.md` | `flag.item_taxonomy` (on: sandbox/qv/office) | effect_router | build |
| 19 | npc_memory | **playtesting** | `spec/24_NPC_AND_NARRATIVE_PROMPTS.md` §Ask 4 | `flag.npc_memory` (on: sandbox/qv/office) | narrative_prompt_assembler | build |
| 20 | chat | designed (deferred) | `spec/18_CHAT_ARCHITECTURE.md` | `flag.chat` | multi_tenant_isolation | spec |
| 21 | theme_generation | **shipped** (admin via bible AI-feedback) | `spec/10_THEME_GENERATION.md` | `flag.theme_gen` (deprecated — folded into bible admin) | — | build |
| 22 | biome_palette_auto_gen | **shipped** (Opus-gen stored in biome entity) | `spec/10_THEME_GENERATION.md` §UX-05 | `flag.biome_palette_gen` (default on) | theme_generation, importer_cli | build |
| 23 | effect_router | **shipped** | `packages/engine/src/effects` + `convex/effects.ts` | — (foundational) | — | build |
| 24 | feature_flags_runtime | **shipped** | `FEATURE_REGISTRY.md` + `packages/engine/src/flags` | — (foundational) | — | build |
| 25 | two_way_content_sync | **shipped** | `spec/AUTHORING_AND_SYNC.md` | — | importer_cli | build |
| 26 | module_counter | shipped (reference) | `convex/modules/counter.ts` | `flag.flows` | step_state_machine_flows | build |
| 27 | module_dialogue | **playtesting** | `convex/modules/dialogue.ts` | `flag.module_dialogue` | step_state_machine_flows, narrative_prompt_assembler, npc_memory | build |
| 28 | module_combat | **shipped** | `convex/modules/combat.ts` | `flag.module_combat` | step_state_machine_flows, effect_router | build |
| 29 | runtime_diagnostics | **shipped** | `packages/engine/src/diagnostics` + `convex/diagnostics.ts` | — (foundational) | effect_router | build |
| 30 | expression_grammar_v2 | **shipped** | `packages/engine/src/clock/index.ts` | `flag.expression_grammar_v2` (superseded; grammar always on) | — | build |
| 31 | admin_ui | **shipped** | `apps/play/src/routes/admin/*` | — | art_curation, eras_and_progression, feature_flags_runtime | build |
| 32 | ref_image_pipe | **shipped** | `convex/art_curation.ts runGenVariant` | — (folded into art_curation) | art_curation | build |
| 33 | runtime_bugs_cron | **shipped** | `convex/crons.ts` + `convex/diagnostics.ts gcRuntimeBugs` | — | runtime_diagnostics | build |

*Table maintenance: each row updated when status changes. Add a row when a new spec lands; never delete — mark `retired` or `pulled` instead.*

## Per-feature detail

Long-form notes per feature live below. Keep concise; link out to specs for full design.

### 12. art_curation

**Flag:** `flag.art_curation` (default off; toggled on per-world at playtest).

**Seam:** `apps/play/src/lib/art/SceneArt.svelte` reads the flag; when off, no eye icon renders and the page is text-only regardless of `entity_art_renderings` contents. When on, the wardrobe UI is live.

**Rollback plan:** flip the flag. No schema change to revert; `entity_art_renderings` rows persist and become dormant. Existing `art_blob_hash` on entities is already migrated to renderings (see spec §Retrofit) — if art_curation is pulled for good, a revert-migration reads the top-upvoted `hero_full` variant per entity and writes it back to `art_blob_hash`, restoring the pre-feature UX.

**Playtest hypothesis:** text-only default + eye-icon-on-demand + variant cycling produces a more-loved art experience than auto-show-hero. Observations accumulate in `PLAYTEST_LOG.md` under `art_curation`.

**Deps:** `blob_storage` (renderings' blobs). No transitive UI deps.

### 13. expansion_streaming

**Flag:** `flag.expansion_streaming` (default off; on per-world at playtest).

**Seam:** `convex/expansion.ts` branches on flag — off uses `messages.create` with buffered response; on uses `messages.stream` with progress-row updates. Client `apps/play/src/routes/play/[world_slug]/[loc_slug]/+page.server.ts` subscribes to the progress row when flag is on; otherwise waits for the buffered response.

**Rollback plan:** flip the flag. The progress-row schema (if added) stays as optional fields; unused without the flag.

**Playtest hypothesis:** streaming reduces perceived latency on expansion from "8s blank wait" to "6s of watching handwriting." Observations: does the partial-prose render feel native or glitchy?

### 14. text_prefetch

**Flag:** `flag.text_prefetch` (default off; per-world when playtesting).

**Seam:** `apps/play/src/routes/play/[world_slug]/[loc_slug]/+page.server.ts` checks the flag before kicking off speculative `ctx.scheduler.runAfter` calls for unresolved-target options.

**Rollback plan:** flip the flag. Any pre-committed-pending drafts (`draft: true, visited_at: null`) that were never visited get swept by the normal mark-sweep GC at their 30-day window.

**Playtest hypothesis:** prefetch reduces perceived expansion latency to near-zero for the hot case (user picks a prefetched option). Cost is under $1/week. Observations: does prefetch actually hit the right options (hit-rate), or does the family mostly pick free-text / the non-prefetched options?

### 15. async_sync_campaign

**Flag:** `flag.campaign_events` (default off).

**Seam:** a new Convex helper `recordCampaignEvent(ctx, ...)` is called from mutations that matter — but only if flag is on. When off, `campaign_events` never accumulates. Catch-up panel queries skip entirely.

**Rollback plan:** flip the flag. `campaign_events` rows persist as a log; no consumers read them. `characters.last_caught_up_at` also persists as a dormant field.

**Playtest hypothesis:** catch-up panels make async play feel like campaign-play, not disconnected solo. Observations: does the "I was with them" option get picked? Does it reduce confusion when family members play out of sync?

### 16. eras_and_progression

**Flag:** `flag.eras` (default off).

**Seam:** the bible serializer checks the flag before filtering by `world.active_era`; if off, all era-tagged content is visible to the AI regardless of era. Entity visibility gating checks the flag before hiding era>active entities. Advance-era mutation refuses if flag is off.

**Rollback plan:** flip the flag. Existing `artifact_versions.era` values become unused metadata; the era_version_map is ignored at read time. Chronicles are readable but never auto-generated. If pulled for good, future writes drop the era field and the era_version_map; entities collapse back to single-current-version.

**Playtest hypothesis:** era-gating produces the serial-fiction discovery feel without losing the sandbox between beats. Observations: does the family feel the era structure (positive) or constrained by it (negative)? Do they naturally reach the end of Era 1 before asking for Era 2?

**Big risk to watch in playtest:** one-file-per-era authoring may feel over-engineered when the family's world isn't multi-book. For single-era worlds (Quiet Vale), the feature should be effectively invisible.

### 17. biome_rules

**Flag:** `flag.biome_rules` (default off).

**Seam:** the turn-end tick handler checks the flag before applying biome `time_dilation` to clock advance and before firing `on_enter_biome` / `on_turn_in_biome` hooks. When off, biomes stay purely descriptive; no rule effects fire.

**Rollback plan:** flip the flag. Authored `rules:` blocks on biomes stay as metadata; unread. Spawn tables don't fire.

**Playtest hypothesis:** the office feels fluorescent-cold and mechanical; the sewer feels dangerous; the apartment feels safe — without per-location authoring of every nuance. Observations: does the atmosphere shift feel tangible in play, or just numeric?

### 19. npc_memory

**Flag:** `flag.npc_memory` (default off).

**Seam:** `assembleNarrativePrompt` checks the flag before including `<speaker_memory>` block. `record_memory` helper is a no-op when flag is off.

**Rollback plan:** flip the flag. `npc_memory` rows persist but unused.

**Playtest hypothesis:** NPCs remember recent interactions; Theo reacts to what happened last session. Observations: are the memory-driven lines noticeably richer, or is context length becoming an issue? Does the decay policy work?

### 22. biome_palette_auto_gen

**Flag:** `flag.biome_palette_gen` (default off).

**Seam:** `scripts/import-world.mjs` and `convex/import.ts` check the flag before calling Opus per un-palette biome.

**Rollback plan:** flip the flag. Biomes without palettes fall through to world-level theme; no per-biome tint until manually authored.

**Playtest hypothesis:** imported worlds look cohesive without manual palette authoring. Observations: does the auto-gen produce palettes that fit the biome description, or does it drift toward generic tones?

## The feature-flag runtime

### Schema

```ts
// convex/schema.ts
feature_flags: defineTable({
  flag_key: v.string(),                      // "flag.art_curation" etc.
  scope_kind: v.union(
    v.literal("global"),
    v.literal("world"),
    v.literal("user"),
    v.literal("character"),
  ),
  scope_id: v.optional(v.string()),          // null for global; world_id / user_id / character_id otherwise
  enabled: v.boolean(),
  set_by_user_id: v.optional(v.id("users")),
  set_at: v.number(),
  notes: v.optional(v.string()),
})
  .index("by_key_scope", ["flag_key", "scope_kind", "scope_id"]),
```

### Resolution order

When checking `flag.<name>` for a given (world, user, character) context:

1. Character-scoped override → if set, use it.
2. User-scoped override → if set, use it.
3. World-scoped override → if set, use it.
4. Global default → the registry's default for this flag.

Each level can override the level above it. Default state for new flags is **off** unless the registry explicitly marks a flag as `shipped` (then global default is on).

### Per-feature helper

```ts
// packages/engine/src/flags/index.ts
export async function isFeatureEnabled(
  ctx: QueryCtx | MutationCtx,
  flag_key: string,
  scope: { world_id?: Id<"worlds">, user_id?: Id<"users">, character_id?: Id<"characters"> },
): Promise<boolean> {
  // Check character → user → world → global in order.
  // Cache per-request to avoid N queries.
}
```

Every seam uses this helper. No direct `feature_flags` reads in feature code.

### Seam discipline rule

When a feature lands, it MUST have exactly one seam per user-visible interaction. No scattering flag-checks across five files. Example:

```ts
// GOOD — single seam
export async function resolveLocation(ctx, args) {
  const eraEnabled = await isFeatureEnabled(ctx, "flag.eras", { world_id: args.world_id })
  if (eraEnabled) return eraAwareResolve(ctx, args)
  return baselineResolve(ctx, args)
}

// BAD — flag check duplicated, can drift
export async function resolveLocation(ctx, args) {
  if (await isFeatureEnabled(ctx, "flag.eras", ...)) { /* filter A */ }
  // ... 200 lines later ...
  if (await isFeatureEnabled(ctx, "flag.eras", ...)) { /* filter B */ }
}
```

Enforce via code review: grep for `isFeatureEnabled` occurrences; any flag appearing in >3 call sites is a refactor signal.

## Directory pattern for feature modularity

```
convex/
├── features/
│   ├── art_curation/
│   │   ├── index.ts              # exposed mutations / queries / actions
│   │   ├── conjure.ts
│   │   ├── variants.ts
│   │   ├── feedback.ts
│   │   └── retrofit.ts
│   ├── eras/
│   │   ├── index.ts
│   │   ├── advance.ts
│   │   ├── stage_shift.ts
│   │   └── bible_filter.ts
│   ├── streaming/
│   │   └── ...
│   └── text_prefetch/
│       └── ...
```

Each feature dir is self-contained. Entry points are only in `index.ts`; cross-feature imports go through `index.ts` exports.

Pulling a feature (`retired` or `pulled` status): rename `features/<name>/` to `features/pulled/<name>/` and delete the `index.ts` re-exports. Code is archived, not deleted. Spec stays on disk with updated status header.

## Spec-header status convention

Every spec file (numbered or named) begins with a status block:

```markdown
# Weaver — <Feature Name>

**Status:** <designed | implementing | playtesting | shipped | retired | pulled>
**Flag:** `flag.<name>` (or `—` for foundational features without a flag)
**Registry:** `FEATURE_REGISTRY.md#<N>`
**Last updated:** 2026-04-20

<content>
```

When a feature's status changes, the spec's header updates in the same commit. Spec content body stays — retired specs read as "this is how it worked when it was live." Future agents see the state at a glance.

## Playtest log

`PLAYTEST_LOG.md` at repo root — a dated log of observations per feature during playtest. Format:

```markdown
## 2026-04-22 — art_curation playtest session 1

Participants: lilith, river.lilith, jason
Duration: 45 min

Observations:
- Eye icon feels discoverable; everyone clicked within first 3 min.
- tarot_card mode was the unanimous favorite; illumination felt "busy" on mobile.
- Cycling between variants via the dots was confusing at first — jason thought
  they were bullet points. Added hint tooltip idea to `UX_PROPOSALS.md` (UX-08).
- Regen latency on FLUX acceptable (~5s). Delete was instant.

Verdict: continue playtest; add tooltip on variant-dots before next session.
Flag stays on for family-instance.
```

Observations drive flag status transitions. A feature with three positive playtest sessions moves `playtesting → shipped`. A feature with recurring friction moves `playtesting → pulled` (or `→ designed` if a redesign is in order).

## Rollback procedure (detailed)

When a feature must be pulled:

1. **Flag off globally.** `feature_flags` row with scope=global, enabled=false, notes="pulled 2026-MM-DD because <reason>".
2. **Registry update.** Row status → `pulled`. Playtest field updated with post-mortem. Spec header updated. Commit.
3. **Archive code.** `features/<name>/` → `features/pulled/<name>/`. Update `convex/_generated/api.d.ts` references. Commit.
4. **Data stays.** Schema fields added by the feature remain optional; existing data is harmless dormant. No migration required to pull.
5. **Restore path preserved.** The archive can be re-animated if playtest learnings suggest a redesign: flip status to `designed`, move back to `features/<name>/`, update spec.

A pull is **never destructive to data**. Code archive + flag flip = instant revert.

## What's on disk vs. in context

- **On disk (persistent across all sessions):** this file (FEATURE_REGISTRY.md), PLAYTEST_LOG.md, every spec file in `spec/`, CLAUDE.md, LIMITATIONS_AND_GOTCHAS.md, UX_PROPOSALS.md, FEASIBILITY_REVIEW.md.
- **In user memory (persistent across agent sessions for the same user):** `/home/lilith/.claude/projects/-home-lilith-fun-weaver/memory/MEMORY.md` + pointed-at files. Holds user-role facts, feedback patterns, project shape.
- **In session context (lost on compaction):** everything else. In-flight thought, mid-session decisions, running feedback.

Rule: **anything that matters beyond the current turn goes on disk or in memory.** Don't trust the session to remember. If a playtest session produces an insight, it goes in PLAYTEST_LOG.md before the session ends. If a feature's flag state changes, it goes in this registry.

## When to add a feature

A feature goes into this registry the moment its spec is written. New spec → new row, status `designed`, flag key reserved. No row → no flag → no seam → easier review before the feature creeps into the codebase.

If a proposed change doesn't warrant a registry entry, it's probably too small to be a feature — fold it into an existing feature or make it a non-flagged implementation detail.

## When to retire a feature

A feature is retired when a successor feature ships that does the same job better. The retired feature's flag stays in the DB (forced off) so any historical data that referenced it still renders correctly. The spec stays on disk with the status header updated.

Retirement is NOT the same as pulling. Retired = "this worked, we replaced it." Pulled = "this didn't work, we're not using it." Both leave forensic trails.

## Open conventions

- **Flag naming:** `flag.<snake_case_feature_name>`. Hierarchical flags (`flag.art_curation.tarot`) possible for fine-grained sub-feature gating.
- **Who can flip flags:** world-scoped flags by world-owner or family-mod; user-scoped by the user themselves; global by instance-owner (requires audit log entry).
- **Flag sunset:** when a `playtesting` feature is `shipped`, its flag stays as an emergency kill-switch for a grace period (~30 days), then the flag-check seam can be removed in a cleanup PR. The flag row stays in the DB for audit.

## Immediate TODOs from the 2026-04-20 integration

- [ ] Add `feature_flags` table to `09_TECH_STACK.md` schema.
- [ ] Add spec-header status conventions to every numbered/named spec currently on disk.
- [ ] Seed `feature_flags` with the flags listed in the registry above, set to the registry's default states.
- [ ] Add `isFeatureEnabled` helper to `packages/engine/src/flags/index.ts`.
- [ ] Retrofit the shipped features' seams to use the helper (most are currently hard-on; wrap them).
- [ ] Create `PLAYTEST_LOG.md` at repo root (empty header-only starter).

These are implementation tasks for the next code-session — not blocking further spec work. The architectural pattern is committed; the code follows on next opportunity.
