# Weaver — Overview

## What this is

A browser-based, AI-supported, collaborative world-building game engine. Successor to the original Weaver (lilith/weaver-lua, 2012). Designed for small family groups expanding out to larger worlds, with every location, character, NPC, item, and encounter carrying reference-consistent generated art, visible author attribution, and editability by prompt.

The engine is text-adventure-first (p/choose/goto, LoGD-style chat, free-text expansion) with per-location generated scene art that arrives on second visit. No tile map in the critical path. Every artifact in the world — locations, NPCs, items, art, UI themes — is an entity, versioned, editable by prompt, and attributed to a pseudonym.

## Core principles

1. **Durable state is sacred; transient state is disposable.** Identity, inventory, settlement structure, relationships, chronicle — never lost. Fights, dialogues, open scenes — version-pinned, escape-handled, force-resolvable on code changes.

2. **Locations are not code by default.** Three execution paths exist: structured JSON (95% of content), inline scripts (4%), full modules (1%). Runtime picks the cheapest that handles the request.

3. **The world bible is the source of truth for consistency.** Style anchor, character refs, biome anchors, tone, theme — all cached and passed to every generation call. AI creativity is maxed on prose, hard-constrained on facts.

4. **Expansion is authorship.** Dead ends don't exist. A player typing "I climb the tower" creates the tower, attributed to them. A family of five playing becomes a family of five co-authors.

5. **Mobile-first, desktop not second-class.** Touch targets ≥44px, single-screen-at-a-time, optimistic updates, offline-capable, ≤80KB initial bundle. Desktop earns its second pane.

6. **Testability is a first-class feature.** State-space crawler, VLM screenshot eval, replay corpus, auto-rollback. Agents can develop modules unsupervised because every path is multiple-choice or free-text, and every free-text is classified before dispatch.

7. **Attribution matters.** Every authored artifact carries a user pseudonym (never real identity in UI). Visible contribution is a soft incentive.

8. **Everything edits by prompt.** Locations, scripts, images, NPCs, theme — any artifact has an "Edit with prompt" affordance. Every edit creates a new version; rollback always available.

9. **Per-family self-hosted deployment; default content rating "family."** One instance per family. Each family runs their own Cloudflare / Convex / Anthropic / fal.ai accounts. Wave 1–3 stay single-tenant per instance; cross-family public deployment is Wave 4+ and has a separately-specified privacy/moderation story. See `16_PRIVACY_AND_MINORS.md`.

## Locked technical decisions

| Decision | Choice |
|---|---|
| Frontend | SvelteKit 5 (runes) + Vite 8 + Tailwind 4 |
| Backend + DB | Convex (managed, self-host possible via FSL) |
| LLM (narrative + intent) | Claude Opus 4.7 (`claude-opus-4-7`) with 1M context + prompt caching |
| LLM (chat NPCs, simple ops) | Claude Sonnet 4.6 / Haiku 4.5 |
| Image gen | FLUX.2 [pro] via fal.ai (primary); Nano Banana 2 for edits |
| Storage (generated art) | Cloudflare R2 (zero egress) |
| Hosting | Cloudflare Pages (unlimited bandwidth free) |
| Auth | Better Auth + Resend magic links |
| Voice (optional, later) | Whisper WebGPU in-browser |
| Runtime execution | Generator-based durable workflows for modules; direct interpreter for inline scripts; pure data rendering for JSON locations |

## Wave structure

- **Wave 0** (1–2 wk): engine kernel spike. Durable runtime, entity/component/relation store, one location, art gen loop, persistence across crash. No family yet.
- **Wave 1** (3–4 wk): MVP — world bible builder, location lifecycle with three execution paths, free-text expansion, background art queue, multi-player presence, per-location chat, mentorship log, testing trinity, auto-rollback. Combat hardcoded with clean boundary. Closed beta with family of 5.
- **Wave 2** (4–6 wk): module system + capability sandbox + browser module designer, New Day loop, NPCs with memory, module-injected encounters. Combat refactored into first real module.
- **Wave 3** (4–6 wk): branches, dreaming, cross-branch character portability, era chronicle, voice input.
- **Wave 4** (optional): 2D overhead tile view as a second UI on same data.

## Glossary

**Artifact** — any authored entity: location, NPC, item, encounter, script, image, theme, character.

**Author pseudonym** — per-branch handle displayed on artifacts; real user_id used only for permissions.

**Biome anchor** — canonical reference image + description for a type of location (forest, village, tundra). Used as style ref for all locations of that biome.

**Branch** — named parallel version of the universe. Different from Era (which is chronological). Families fork worlds for "what if" without losing the original.

**Character ref** — canonical reference image + description for a character. Passed as ref image to FLUX.2 for all new scenes featuring that character.

**Chronicle** — AI-written permanent history of the world, appended at era transitions.

**Dream** — a throwaway execution context. State changes are discarded on completion. Used for what-ifs, AI previews, player experiments.

**Entity** — a row in the `entities` table. Everything is an entity: locations, characters, NPCs, items, fights, conversations, refs, themes.

**Era** — chronological chapter of a world. Transition produces a chronicle entry and locks prior era's durable artifacts.

**Expansion** — player-driven world growth via free-text or unmodeled-option resolution.

**Family-mod** — a user with moderation powers within a specific world or world group.

**Flow** — an active execution context with a stack, like Weaver's original concept. Can be nested, saved/restored by name, throwaway (dream), or capability-filtered.

**Hook** — a named event a module subscribes to (`arrive_location`, `new_day`, `idle_player`, `era_advancing`, etc.).

**Inline script** — a small p/choose/rand program evaluated directly without the durable runtime. Pure function from (state, input) → (new_state, output).

**JSON location** — a pure-data location row rendered by template. No code, no runtime, fully testable as a fixture.

**Mentorship log** — append-only record of every edit, override, rejection, and AI suggestion. Per-family style learns from it.

**Module** — a sealed, capability-restricted package that subscribes to hooks and adds components, predicates, actions, or screens. Full durable workflow runtime.

**New Day** — master game loop. Energy/turns regenerate, buffs roll, dead resurrect.

**Predicate** — a tagged relation between entities (e.g., `fed_doe`, `knows_secret`). Stored in the `relations` table.

**Replay corpus** — set of snapshot-action-pairs used to regression-test migrations and changes.

**Safe anchor** — a location flagged as valid respawn point; player force-returned there if their current execution is unrecoverable.

**Theme** — generated JSON mapping world vibe to CSS variables (colors, typography, motion). Regenerable anytime.

**Trinity (testing trinity)** — state-space crawler, VLM screenshot eval, replay corpus. All three run on every PR.

**World bible** — the aggregate canonical reference set (style, characters, biomes, tone, theme). Cached in LLM prompts via prompt caching; never drifts.
