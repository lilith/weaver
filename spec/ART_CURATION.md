# Weaver — Art Curation

*How art lives in Weaver: text-only by default, a wardrobe of treatments per entity, communal cycling and regeneration, reference-board-driven style convergence.*

## Core stance

Pseudorealistic AI art doesn't survive repeated play. Characters drift between scenes, locations lose their through-line, the uncanny valley shows up every third gen. The Weaver answer is three-fold:

1. **Text is the default.** New worlds ship with no art. A page is text + palette tint + typography. The family can read and weave without ever seeing an image.
2. **Art is opt-in, cycle-able, and shared.** A small eye affordance reveals the art wardrobe for the current entity. Visitors cycle modes, regenerate variants, vote, curate. Changes are world-visible — everyone benefits from one person's curation.
3. **Stylization wins over realism.** Every mode leans stylized (watercolor, ink-wash, illumination, tarot, line art, anime). Photoreal is discouraged because it amplifies inconsistency. The wizard omits it from quick-picks.

## The wardrobe — modes at a glance

| Mode | Layout | Source | Consistency strategy |
|---|---|---|---|
| `ambient_palette` | gradient / tinted background | no gen (extract from existing blob or style anchor) | purely palette; no figurative content |
| `banner` | 21:9 strip behind location title, readable text overlaid | FLUX gen, "atmospheric wide shot, no characters" | small surface; blur-friendly |
| `vignette` | same image as banner, heavy edge-darkening CSS | shared blob with `banner` | most of the image hidden |
| `blurred_backdrop` | same image as banner, 20%-blur + low opacity full-page | shared blob with `banner` | inconsistency dissolves in blur |
| `portrait_badge` | 48-96px circular portrait beside character names | FLUX gen with 3-view character ref sheet | tight crop, same ref every time |
| `tarot_card` | 3:5 card with ornate border, popover display | FLUX gen "tarot illustration, single subject, stylized" | frame does the stylistic work |
| `illumination` | drop cap + margin vignette on prose | FLUX gen "illuminated manuscript capital + vignette" | medieval variability *is* the style |
| `postcard` | small framed image in-prose, as diegetic artifact | FLUX gen "weathered postcard illustration of this scene" | narrative alibi for imperfection |
| `map_view` | hand-drawn top-down room sketch | FLUX gen "top-down D&D-style room map" | structural, not representational |
| `hero_full` | full scene image at top of page | FLUX gen "establishing shot of this location" | legacy; retained for families who want it |

**Wave 2 ships** the first five: `ambient_palette`, `banner` (+ `vignette` + `blurred_backdrop` as CSS-only variants sharing one blob), `portrait_badge`, `tarot_card`, `illumination`. The other four (`postcard`, `map_view`, `hero_full`) are v2 additions — schema extensible; shipping more modes adds rows in `entity_art_renderings`, no migration.

`ambient_palette` is free — no LLM call. The color band is extracted from whichever blob already exists for the entity (banner if present, character portrait if that's the only one) or from the world's style-anchor if nothing has been conjured yet. Every world has at least `ambient_palette` available by default.

## Multiple variants per mode

Every regen produces a new row — variants accumulate. The tarot_card mode might hold five variants by week four; visitors cycle through them, vote, delete the ones they dislike. The wardrobe grows organically.

### Cycling interaction

Eye icon is the entry:

- **Never opened on this entity.** Eye icon dim. Tap → mode picker (grid of 5 mode thumbnails, or text labels if unconjured). Pick one → queues first variant for that mode. Brewing state appears. When ready, art reveals.
- **One or more modes conjured.** Eye icon has a subtle filled dot. Tap → current canonical variant displays. Beside the displayed art: tiny dots per mode (colored-in for modes with at least one variant, outlined for modes with none). Tap a dot to swap mode. Long-press (or a menu) for variant-level operations within the current mode.
- **Variant-level operations** (once a mode is displayed):
  - ↻ regen — produces a new variant, joins the wardrobe.
  - ⌫ delete — marks this variant hidden (soft-delete; author-visible in a recovery drawer).
  - ↑ upvote — adds to world reference board under this mode's kind.
  - ✎ feedback — free-text note; accumulated notes feed next regen's prompt context.
  - ⇆ prev / next variant — cycle through existing variants for this mode; ordered by upvote count desc, then recency.

### Communal semantics

Per the 2026-04-20 direction: **changes are world-visible, not per-character**. Anyone with member access can regen, delete, upvote, or add feedback. The wardrobe accumulates communally; the reference board is world-scoped.

A per-character setting (`characters.art_mode_preferred`) selects which mode shows *by default* when that character visits a location. If tarot is their preference and the location has no tarot variants, they fall through to the top-voted mode that does exist (or `ambient_palette` as the final fallback).

Variants are never permanently deleted. "Delete" marks them hidden; a world-owner can unhide via a recovery panel. The underlying blob stays in the store (content-addressed; may be referenced elsewhere; mark-sweep GC eventually reclaims if fully unreferenced).

## Schema

Additions to `convex/schema.ts` (also specced in `09_TECH_STACK.md`):

```ts
entity_art_renderings: defineTable({
  world_id: v.id("worlds"),
  entity_id: v.id("entities"),
  mode: v.string(),                    // "banner" | "portrait_badge" | "tarot_card" | ...
  variant_index: v.number(),           // 1, 2, 3 within a mode; incremented per regen
  blob_hash: v.optional(v.string()),   // set when ready; absent while queued/generating
  status: v.union(
    v.literal("queued"),
    v.literal("generating"),
    v.literal("ready"),
    v.literal("failed"),
    v.literal("hidden"),                // soft-deleted
  ),
  prompt_used: v.string(),             // for regen / debug / feedback context
  requested_by_user_id: v.id("users"),
  requested_by_character_id: v.optional(v.id("characters")),
  upvote_count: v.number(),            // denormalized from art_feedback, updated on vote
  created_at: v.number(),
  updated_at: v.number(),
})
  .index("by_entity_mode", ["entity_id", "mode", "upvote_count"])
  .index("by_world", ["world_id"])
  .index("by_status", ["status", "created_at"]),

art_feedback: defineTable({
  world_id: v.id("worlds"),
  rendering_id: v.id("entity_art_renderings"),
  user_id: v.id("users"),
  action: v.union(
    v.literal("upvote"),
    v.literal("downvote"),
    v.literal("delete"),
    v.literal("undelete"),
    v.literal("regen_requested"),
    v.literal("reference_board_add"),
    v.literal("feedback_comment"),
  ),
  comment: v.optional(v.string()),     // for feedback_comment action
  created_at: v.number(),
}).index("by_rendering", ["rendering_id"]).index("by_world_user", ["world_id", "user_id"]),

art_reference_board: defineTable({
  world_id: v.id("worlds"),
  rendering_id: v.id("entity_art_renderings"),
  kind: v.string(),                    // "style" | "character:<slug>" | "biome:<slug>" | "location:<slug>" | "mode:<mode-name>"
  added_by_user_id: v.id("users"),
  caption: v.optional(v.string()),
  order: v.number(),
  created_at: v.number(),
}).index("by_world_kind", ["world_id", "kind", "order"]),

// On characters
characters.art_mode_preferred: v.optional(v.string()),   // default mode to display on visits
```

## Mode-aware prompts

Each mode has a prompt template parameterized by `{world_style_anchor}`, `{entity_description}`, `{entity_kind}`, and any biome context:

```ts
// packages/engine/src/art/prompts.ts
export const MODE_PROMPTS = {
  banner: (ctx) => `Atmospheric wide shot, 21:9 aspect. ${ctx.entity.description}. ${ctx.world.style_anchor.prompt_fragment}. No characters, no text, moody light.`,

  portrait_badge: (ctx) => `Portrait, 3/4 view, neutral background. ${ctx.entity.portrait_prompt}. ${ctx.world.style_anchor.prompt_fragment}. Shoulders up, expressive face.`,

  tarot_card: (ctx) => `Tarot card illustration, portrait orientation, ornate art-nouveau border. Single subject: ${ctx.entity.name}. ${ctx.entity.description}. ${ctx.world.style_anchor.prompt_fragment}.`,

  illumination: (ctx) => `Illuminated manuscript capital letter for "${ctx.entity.name[0]}", with margin vignette depicting ${ctx.entity.description}. Gold leaf, rich pigments. ${ctx.world.style_anchor.prompt_fragment}.`,

  postcard: (ctx) => `A weathered postcard illustration of ${ctx.entity.description}. Slightly faded edges. ${ctx.world.style_anchor.prompt_fragment}. No modern text on the card.`,

  map_view: (ctx) => `Hand-drawn top-down map sketch, D&D style, of ${ctx.entity.description}. Cross-hatching, compass rose, scale bar. On aged parchment.`,

  hero_full: (ctx) => `Establishing shot, 16:9 landscape. ${ctx.entity.description}. ${ctx.world.style_anchor.prompt_fragment}.`,
}
```

All modes inherit the world's style anchor. Biomes with `palette.atmosphere` set pass that as an additional mood tag. Characters pass their canonical portrait ref sheet as a FLUX reference image for every portrait-mode gen.

## Reference board feeds future gens

When `art_reference_board` has upvoted renderings for a kind, FLUX calls matching that kind pass the referenced blobs as `ref_image_url` inputs:

- New portrait for character X → check `art_reference_board.by_world_kind("character:<X-slug>")` → pass top 2-3 hashes as refs. FLUX stays consistent with the family's approved take on X.
- New banner for biome Y → check `"biome:<Y-slug>"` → refs.
- New tarot for any entity → check `"mode:tarot_card"` → family's approved tarot style is the reference for future tarot gens anywhere.

Reference-board upvotes therefore compound: the world's art converges toward family taste session by session.

## Retrofit of existing worlds

Per 2026-04-20 direction: both Quiet Vale and The Office retrofit to no-art default immediately.

Migration:

1. For every existing entity with `art_blob_hash` set: create one `entity_art_renderings` row with `mode: "hero_full"`, `variant_index: 1`, `blob_hash: <existing>`, `status: "ready"`, `upvote_count: 0`, `requested_by_user_id: <world-owner>`.
2. Clear `entities.art_blob_hash` — the legacy field stops being the source of truth. (Keep the column for one deploy in case of rollback, then drop.)
3. `entities.art_status` repurposes: becomes a UI hint only, derived from `has any renderings?` at render time.
4. On next load, a location in Quiet Vale shows text only with an eye icon bearing a filled dot (because a `hero_full` rendering exists). Family cycles modes → finds the legacy art under hero_full → can promote it by adding to reference board, or delete it, or switch to banner for a fresh gen.

No art is lost; all of it is accessible. The *display default* flips from "show the hero_full automatically" to "show nothing; offer the cycle."

This migration ships as an internal mutation `_dev.migrateArtToRenderings` runnable once per world. Idempotent.

## Art is user-click only

Per the eye-icon affordance locked earlier in the conversation:

- **No auto-gen on location insert.** The scheduler-triggered `scheduleArtForEntity` from commit `76e6221` stops firing on seed + expansion. It remains available as an internal action invoked only by `art.conjureForEntity`.
- **Eye icon click → conjure.** User-facing mutation `art.conjureForEntity(session_token, entity_id, mode)` enforces membership, respects `checkBudgetOrThrow`, enqueues FLUX gen, returns the `entity_art_rendering` row reactively.
- **Never pre-expands.** Unlike text prefetch (which speculates on likely-next text), art never prefetches. Cost + the "art should feel earned" principle.

## Budget and cost

- One variant gen: ~$0.03 (FLUX.2 [pro] 1MP, via fal.ai).
- `ambient_palette`: free (no gen).
- `banner + vignette + blurred_backdrop`: one $0.03 gen covers all three via CSS variants.
- `portrait_badge`: ~$0.03 per new portrait; character portraits also feed the reference board for scene gens → amortizes.
- Expected family weekly art cost with wardrobe cycling: $0.50-1.50 depending on curation energy. Far lower than the pre-retrofit auto-gen model which was closer to $5-10/week of unrequested art.

Budget check: every `conjureForEntity` call passes through `checkBudgetOrThrow`. Families near cap see a soft refusal ("art budget for today is low — try again after midnight UTC"). Prevents a zealous curation session from burning the whole budget.

## Interaction with era (when spec 25 lands)

An entity can carry per-mode renderings for each era:

- `entity_art_renderings.era: v.optional(v.number())` — present = era-specific rendering; absent = era-agnostic (default before era system ships).
- On era transition, existing era-agnostic renderings inherit implicitly; authors or visitors can conjure era-specific variants if the entity visibly changes with the era (Fort Door pre-invasion vs post-invasion).
- The mode-picker shows variants for the current active-era first; other-era variants are accessible via a "see other eras" drawer.

This means art can evolve with the story: a family who played Fort Door as cozy in Era 1 has cozy variants; after the Era 2 invasion, fresh conjures produce scorched variants. Both stay in the DB; visitors can always look back.

## Failure modes

- **FLUX rejects prompt (safety filter).** Status → `failed`. User sees a friendly "the scene couldn't be conjured" message and the regen button. No exception bubbles to the UI.
- **FLUX returns garbled output** (the Bengali-digit hex case from `LIMITATIONS_AND_GOTCHAS.md`). Post-gen validation; retry once with a cleaner seed; if still bad, mark failed.
- **Visitor regens mid-read.** The reactive query swaps the displayed rendering with the new one live. Previous variant stays accessible via the variant dots.
- **Budget exhausted.** Conjure mutation throws `BudgetExceeded`; UI shows the friendly cap message; variants already in the wardrobe remain viewable.

## Test surface

- **Unit:** mode-prompt construction; variant-index increment is monotonic; `upvote_count` denormalization stays consistent with `art_feedback`.
- **Isolation-adversarial** (per `ISOLATION_AND_SECURITY.md` rule 32):
  - Conjure from a character not in the world → rejected.
  - Upvote a rendering in a world I'm not in → rejected.
  - Reference-board insert cross-world → rejected.
- **Integration:** retrofit migration on a fixture world produces expected renderings; every legacy `art_blob_hash` becomes a ready `hero_full` variant; no art loss.
- **E2E** (Playwright): eye-icon cycling on a seeded location reveals modes in upvote order; regen produces a new variant; delete hides it but it remains in the recovery drawer.

## Implementation outline

1. Schema additions (`09_TECH_STACK.md`): `entity_art_renderings`, `art_feedback`, `art_reference_board`, `characters.art_mode_preferred`.
2. Internal mutation `_dev.migrateArtToRenderings` — migrate existing `art_blob_hash` values into the new table. Run once per world.
3. Remove `scheduleArtForEntity` auto-call from `seed.ts`, `expansion.ts`, `import.ts`. Retain the internal action; only `art.conjureForEntity` invokes it.
4. Mode-prompt library in `packages/engine/src/art/prompts.ts`.
5. User-facing mutations: `art.conjureForEntity`, `art.regenVariant`, `art.deleteVariant`, `art.upvoteVariant`, `art.addFeedback`, `art.addToReferenceBoard`, `art.removeFromReferenceBoard`.
6. Convex queries: `art.getRenderingsForEntity(world_id, entity_id)` returns variants grouped by mode, ordered by upvote desc.
7. FLUX call path: consult reference board for matching kind, pass refs; apply style-anchor; include recent feedback comments in prompt context.
8. UI component `SceneArt.svelte`: eye icon with state-aware styling, mode-picker grid, cycling dots, variant controls on hover.
9. Retrofit mutation invoked on Quiet Vale and The Office before next deploy.

## Open questions

- **Reference-board size caps.** Unbounded curation could add 100+ upvoted renderings per kind, inflating FLUX prompt size. Cap at top-N by upvote, with a family-mod override? Start at 5.
- **Cross-world reference sharing.** Can The Office borrow Quiet Vale's style? Today: no — reference board is world-scoped per isolation rules. Future cross-family sharing is Wave 4+.
- **Era-specific prompts.** When spec 25 ships, does `tarot_card` for Theo in Era 1 vs Era 3 get a different prompt variant? Probably — Era 3 Theo has lost more, the prompt should reflect that. Specced in era spec, implemented in the prompt library.
- **Default preferred mode.** New characters default `art_mode_preferred: null` (fall through to `ambient_palette`). Or should it default to `tarot_card` which is evocative and cheap? Start with `ambient_palette` default — users explicitly upgrade their preference.

## Why this lands

Three wins:

1. **No uncanny-valley footprint.** The default is no art; every art visible was explicitly summoned by a family member. The world never forces a bad FLUX output on anyone.
2. **Compounding family taste.** Every upvote, every deletion, every feedback comment trains the next gen. Week six's art is visibly better than week one's.
3. **Cheap to run, cheap to explore.** Under a dollar a week of FLUX cost for a moderately curating family. If nobody ever opens the eye, zero art cost ever.

The art is always the family's, not the AI's.
