# Weaver — Project-Specific Instructions for Claude Code

Read `CONTEXT-HANDOFF.md` (sibling file) for the full session snapshot of what's provisioned. This file is the standing instructions — shorter, behavior-focused.

## ⚠️ URGENT — spec course corrections landed 2026-04-19

A spec-review session shipped decisions that change direction on in-flight work. Core corrections are now applied; remaining items are tracked below with status. If you have anything in flight that contradicts a still-pending item, name it and propose a fix rather than silently carrying on.

**2026-04-20 integration pass (this block's latest revision):** POSTER_CHILD asks from `backstory/POSTER_CHILD.md` are integrated — overview in `spec/20_POSTER_CHILD_CAPABILITIES.md`, deep-dives in `21_BIOME_RULES.md`, `22_ITEM_TAXONOMY.md`, `23_WORLD_CLOCK.md`, `24_NPC_AND_NARRATIVE_PROMPTS.md`. Household sharing spec lives at `HOUSEHOLD_AND_SHARING.md` (named-space, not numbered). Ask 3 (clock) and Ask 5 (prompt assembler) are shipped.

**Status legend:** ✅ applied in code · 🟡 partially applied · ⏳ pending · 📘 spec-only (no code yet required).

1. ✅🟡 **Multi-tenant isolation from day one.** Every Convex index starts with `[world_id, ...]` or `[branch_id, ...]`. Every query/mutation/action signature requires `world_id` explicitly — no defaults, no "inferred from the user's active world." `ctx.auth.userId` is the only trusted identity source — never accept a client-passed `user_id` / `world_id` / `branch_id` / `character_id` without a membership check. AI cache keys include `world_id` and `branch_id`. Add a `world_memberships` table to the schema **before** any permission-bearing code lands. Isolation between worlds is a security boundary, not hygiene — cross-world leak = vulnerability. Full rule set + adversarial test category in **`spec/ISOLATION_AND_SECURITY.md`**.
   *Applied in `63f1007` for schema shape, index layout, slug-based addressing, `requireMembership` helper. Identity-source rule is only **partially** applied — see item 11 for the `session_token`-vs-`ctx.auth` gap.*

2. ✅ **Two execution paths, not three.** JSON with safe inline expressions (`{{rand() < 0.15 ? "ambush" : "normal"}}`) + modules. Do **not** build a separate inline-script interpreter with a custom grammar. **`spec/03_INLINE_SCRIPT.md`** is marked deprecated; its conditional/RNG use-cases roll into the template grammar in **`spec/02_LOCATION_SCHEMA.md`**.
   *Path-2 (inline-script) was never built; safe-inline template grammar not yet implemented — when you add conditionals/RNG to the template engine, implement the extended grammar from `02_LOCATION_SCHEMA.md` §"Template grammar."*

3. ✅ **Durable flows are step-keyed state machines, NOT generator-event-sourced replay.** A module is `{ steps: { [id]: (ctx, state) => ({ next, effects }) } }`; runtime stores `current_step_id + state`; resume is a handler lookup. No generator-replay semantics, no seed-derived cache determinism layer, no closure-capture landmines. This is directly relevant to the Day-3 dialogue flow — design it as step-keyed from the start. See **`spec/01_ARCHITECTURE.md` §"Durable runtime."**
   *Schema has `flows.current_step_id` + `state_json` + `flow_transitions` per `63f1007`. Runner (the code that walks steps) is Day 3 work.*

4. 📘 **Modules are trusted TypeScript in Wave 1-3.** No QuickJS WASM isolate, no capability sandbox for user-authored modules. All module code is written by you, type-checked, compiled in. The capability-sandbox concept survives as a typed-proxy for clean interfaces (`ModuleCtx`), not as a runtime isolation boundary. User-authored modules are a Wave 4+ concern if ever.

5. ⏳ **Multi-player sync is at-transition only, EXCEPT chat.** Durable character state syncs at location-entry and location-exit; intra-location `this.*` changes don't propagate in real-time between players. Chat stays reactive. Presence panel updates on transitions, not continuously. See **`spec/01_ARCHITECTURE.md` §"Multi-player sync"**.
   *Not yet relevant — single-player Day 2. Lands naturally when multi-player presence ships in Wave 1.*

6. ✅ **Blob GC is mark-sweep, not refcount.** Periodic job walks live heads, marks reachable blob hashes, sweeps unreachable blobs older than N days. Drop any refcount column from the `blobs` table; drop refcount-increment/decrement paths from blob read/write. See **`spec/12_BLOB_STORAGE.md`**.
   *Schema is shape-correct; mark-sweep job itself not yet built (and won't matter until R2 lands).*

7. ⏳ **Testing trinity stays Wave 1, starts now.** It's the control surface that makes agent-autonomous development viable — not premature platform. Build it alongside the feature code. Isolation-adversarial tests are a mandatory category (from rule 1). The first few mutations should land with isolation tests in the same PR.
   *Flagged in `63f1007` as "first PR with isolation tests should be Day 3." **Do it — don't let it slip past the Day-3 dialogue flow PR.** Every new mutation from here on ships with a matching isolation test.*

8. ✅ **`AUTHORING_AND_SYNC.md` is the authoring source format.** You already used this for seeding — good. The spec is now committed at `spec/AUTHORING_AND_SYNC.md`. Keep files conforming to it; the upcoming `weaver validate / import / export` CLI will validate against that spec. Git is not in the pipeline — files are an on-demand mirror, DB is runtime truth.

9. 📘 **Privacy spec collapsed.** `spec/16_PRIVACY_AND_MINORS.md` is now a ~120-line Wave-1 family-instance posture. Task **C6** (in `08_WAVE_1_DISPATCH.md`) shrank from 2 days (guardian dashboard + moderation pipeline) to ~2 hours (family-rating safety prompts + per-user cost cap wiring). Those deferred items are Wave 4+.

10. 📘 **`spec/FEASIBILITY_REVIEW.md` flags open claims.** Cost ceilings, latency budgets, 80KB bundle target, cache hit-rate assumptions, auto-rollback mechanics, Wave 1 scope/timeline. Measure first; don't take numeric claims on faith. Surface divergences. (§4 QuickJS, §6 95/4/1 split, §13 inline-script authoring UX are marked resolved by this session.)

11. 🟡 **`session_token` argument pattern vs `ctx.auth.userId`.** Current Convex mutations accept a `session_token` argument and resolve `user_id` server-side via `resolveSession(ctx, token)`. This satisfies the *spirit* of rule 1 (identity is server-resolved, never client-claimed-user_id) but not the *letter* (`ISOLATION_AND_SECURITY.md` rule 4 specifies `ctx.auth.userId`). Two paths to full compliance:
   - **(recommended) Keep `session_token` pattern for now**, with a hard discipline: no mutation ever accepts `user_id` as an argument, and every mutation signature lists either `session_token` or derives user via `resolveSession(ctx)` from a Convex HTTP action with the cookie. Add a **lint rule / grep gate** in CI: `grep -r 'user_id: v\.id("users")' convex/*.ts` → any hits in mutation `args` are a PR-blocker unless explicitly whitelisted. Remove when Better Auth lands and `ctx.auth.getUserIdentity()` is available natively.
   - **(alternative) Wire Convex custom auth now** — use `auth.config.js` with a custom JWT validator that accepts the magic-link session token and exposes `ctx.auth.getUserIdentity()`. More code to throw away when Better Auth lands, but rule-4 compliant today. Choose only if isolation-adversarial testing turns up a concrete vulnerability the lint rule can't catch.
   Default to the first option until Better Auth replaces the interim auth. Track this in known bugs until resolved.

Velocity note: Lilith clarified that agent-fleet velocity makes the Wave 1 scope realistic (a 1-week estimate = ~30 min real time). Don't defensively scope-cut — keep the full Wave 1 ambition and ship it.

## Wave 2 targets — consolidated

Four feature clusters are designed and registry-tracked; all gated behind flags (default off) and playtest-driven to ship. Full status surface in **`FEATURE_REGISTRY.md`** at repo root. Start there before picking up any feature.

### POSTER_CHILD asks — `spec/20_POSTER_CHILD_CAPABILITIES.md`

| Ask | Spec | Status | Flag |
|---|---|---|---|
| 1. Biome rules (time_dilation, hooks, spawn_tables) | `21_BIOME_RULES.md` | designed | `flag.biome_rules` |
| 2. Item taxonomy (`kind:` + first-class orbs) | `22_ITEM_TAXONOMY.md` | designed | `flag.item_taxonomy` |
| 3. World clock (`hhmm`, day-of-week, `tick_minutes`) | `23_WORLD_CLOCK.md` | ✅ shipped `a6985aa` | `flag.world_clock` (on) |
| 4. NPC memory auto-injected into dialogue | `24_NPC_AND_NARRATIVE_PROMPTS.md` | designed | `flag.npc_memory` |
| 5. Shared `assembleNarrativePrompt` helper | `24_NPC_AND_NARRATIVE_PROMPTS.md` | ✅ shipped `d761c03` | — (library) |
| 7. Party composition | **subsumed** by async-sync campaign | — | — |

### Design-direction additions (2026-04-20)

| Feature | Spec | Status | Flag |
|---|---|---|---|
| Art curation (wardrobe of modes, eye-icon, communal variants) | `ART_CURATION.md` | designed | `flag.art_curation` |
| Expansion streaming (Opus stream + skeleton render) | `04_EXPANSION_LOOP.md` §Streaming | designed | `flag.expansion_streaming` |
| Predictive text prefetch (click-into-nowhere) | `04_EXPANSION_LOOP.md` §Predictive text prefetch | designed | `flag.text_prefetch` |
| Async-sync campaign (catch-up panels) | `ASYNC_SYNC_PLAY.md` | designed | `flag.campaign_events` |
| Eras and progression (per-entity × per-era state) | `25_ERAS_AND_PROGRESSION.md` | designed | `flag.eras` |
| Biome palette auto-gen (UX-05 resolution) | `10_THEME_GENERATION.md` §Auto-gen | designed | `flag.biome_palette_gen` |

### Sprawl-resistance architecture

**`FEATURE_REGISTRY.md`** + **`PLAYTEST_LOG.md`** + per-spec status headers = every feature is pullable by flag flip, its design survives context-compaction, and flag transitions are evidence-driven. The code-agent side of this (wire the `isFeatureEnabled` helper + retrofit existing seams) is listed in FEATURE_REGISTRY's "Immediate TODOs" section — it's the next implementation pass when the code agent resumes.

### Recommended sequencing for the code agent

The registry carries dependencies (`deps` column). Suggested next-session order:

1. **Wire `feature_flags` infrastructure** — schema already in `09_TECH_STACK.md`; add `isFeatureEnabled` helper in `packages/engine/src/flags/`; seed flags per registry defaults.
2. **Pick from `designed` features that have no pending deps** — start with ART_CURATION (blocks nothing, frees big playtest surface), or text-prefetch + streaming (both improve live play).
3. **Every implementation PR adds its adversarial-isolation test** per URGENT rule 7.
4. **Every feature lands at status `implementing` in the registry**, then `playtesting` after family-instance flag-on, then `shipped` after PLAYTEST_LOG entries warrant.

## Open design questions (during playtest)

- **UX-01 (time-gated option hiding).** Landed as (b) gray-out-with-hint v1; (d) authored `hidden_until` / `teaser_when` fields to follow after playtest observations. See `UX_PROPOSALS.md`.
- **UX-03 (wait affordance).** Trying (b) global "wait a moment" button. If family finds it breaks flow, fall back to per-location implicit waits or remove entirely. Playtest-driven.
- **Art mode v1 list** — starting with 5 modes (ambient_palette, banner+CSS-variants, portrait_badge, tarot_card, illumination). Add postcard / map_view / hero_full as v2 if family wants them.

## Open design questions — main agent picks

These came out of the integration pass with a recommendation; main agent resolves them during implementation and records the choice in `17_DECISION_LOG.md`.

- **Character role enum.** Three candidate enums in flight across spec / extraction / importer. Recommendation: IMPORT_CONTRACT's `player_character | travelling_npc | antagonist | pet`, location-bound NPCs stay in `npcs/<slug>.md` with no role. See `spec/AUTHORING_AND_SYNC.md` §"Character role enum — OPEN QUESTION."
- **Cross-type relationships** (`characters[].relationships[].with:` targeting an npc slug). Recommendation: accept. `backstory/index.md` already documents the tension; the importer's cross-type-rels commit (in `671bbdb`) implies the de-facto answer is already "accept" — ratify in the decision log.
- **Quiet Vale backup to a separate repo.** User-flagged 2026-04-20. `scripts/backup-world.mjs` + private `weaver-family-worlds` repo. Spec shape in `HOUSEHOLD_AND_SHARING.md` §"Quiet Vale backup to a separate repo." Schedule before any destructive refactor touching world content.

## What this project is

Weaver — browser-based, AI-supported, collaborative world-building game engine. Successor to lilith/weaver-lua (2012). Spec lives in `spec/` — 18 numbered docs plus `AUTHORING_AND_SYNC.md`, `ISOLATION_AND_SECURITY.md`, `FEASIBILITY_REVIEW.md`, `HANDOFF_NOTES.md`.

**Deployment model:** per-family instances. Each family gets its own deployment. Today that's one instance — Lilith's family. This collapses a lot of multi-tenant concerns (moderation scope, privacy isolation, cost attribution) into single-tenant per-instance. When the spec or you feel tempted to design around "public worlds" or "strangers in the same world," stop — that's not the shape of this product.

## Design direction: async + sync play

**`spec/ASYNC_SYNC_PLAY.md`** — the multi-player shape. *Async by
default, sync when it happens.* Clock is monotonic and advances on
any action; late-arriving players see a catch-up panel with
retroactive agency ("were you with them?" → portal in, or skip). This
resolves several open design questions and defines Wave 2-3 multi-
player surface. **Read before touching multi-player or clock code.**

## Current status (2026-04-20, end of Wave 1 Day ~3 equivalent)

**Live at https://theweaver.quest.** Full core loop shipped and playable:
magic-link sign-in → worlds list → /play/[world]/[loc] → pick/weave/
save-to-map → journal. Five-person household pre-authed to shared Quiet
Vale. The Office imported from backstory extraction (43 entities, 23
FLUX scene arts queued).

**Shipped capability shifts (of the 5 in `spec/20_POSTER_CHILD_CAPABILITIES.md`):**
- Ask 3 — **world clock** done. branches.state carries
  `{ time: {iso, hhmm, day_of_week, day_counter, week_counter,
  tick_minutes}, turn }`. Turn-end tick on every applyOption. Option
  `condition:` strings evaluated server-side via a minimal safe
  expression grammar (==, !=, <, <=, >, >=, &&, ||, !, path lookup,
  string/number/bool literals). Conditionally-hidden options filter
  correctly; each returned option carries `original_index` so picks
  still resolve unambiguously.
- Ask 5 — **shared narrative prompt assembler** done.
  `convex/narrative.ts` exposes `assembleNarrativePrompt` +
  `internal.narrative.buildPrompt`. Cache_control on the world-bible
  block means 90%-off every call after the first in a 5-min window.
  Expansion already migrated.

**Not yet shipped (next session):** Ask 1 (biome rules — spec 21),
Ask 2 (item taxonomy — spec 22), Ask 4 (NPC memory).

**Other shipped this session:** art pipeline (fal.ai FLUX.schnell →
R2 blob → location page), AI journey summary (Sonnet on close),
isolation-adversarial test catch-up (URGENT rule 7 — 12 scenarios
covering every world-scoped mutation), cross-type relationship
acceptance in the importer, inline-blob cap raised to 64KB for real
payloads, custom-domain artz.theweaver.quest, household preauth +
world ownership transfer to river.lilith@gmail.com as canonical
primary.

**Deferred per user:** per-location chat (spec defers a wave or two —
"we're in the same room"). Quiet Vale→separate-repo backup still
pending. FAL_KEY now has correct id:secret format.

**UX_PROPOSALS.md** at the repo root is a running log of design
tensions surfaced while building — 5 items so far. Review before
Wave 2 shipping.

## Stack (locked)

- **Frontend:** SvelteKit 2 (Svelte 5 runes) / Vite 8 / Tailwind 4 (+typography) / `@sveltejs/adapter-cloudflare`, `apps/play/`
- **Backend + DB:** Convex, root-level `convex/`
- **LLM:** Claude Opus 4.7 (`claude-opus-4-7`) narrative / Sonnet 4.6 (`claude-sonnet-4-6`) dialogue / Haiku 4.5 (`claude-haiku-4-5-20251001`) intent + VLM
- **Image gen:** FLUX.2 [pro] via fal.ai; FLUX Kontext for edits
- **Storage:** Cloudflare R2 (`weaver-images` + `weaver-general` buckets). Custom domain `art.theweaver.quest` bound to images bucket.
- **Hosting:** Cloudflare Pages (project `weaver`, auto-deploy on push to `main`)
- **Auth:** Convex-native magic link via Resend (Wave 0 interim); Better Auth planned when OAuth/2FA/password join the scope
- **Node 22, pnpm 10, workspaces** (`apps/*`, `packages/*`)

Node version: do not downgrade. Vite 8 requires 22.12+.

## Dev workflow

```bash
# Each session
npx convex dev                       # keep running — pushes schema + functions, watches
cd apps/play && pnpm dev             # SvelteKit dev server
# Secrets
npx convex env set KEY value         # for server-side (Convex actions)
# .env at repo root                  # for scripts you run locally (S3, CF API, seeds)
```

Never edit `convex/_generated/` by hand — regenerated on every `convex dev`.

## Key behavioral rules for future sessions

These override defaults and reflect hard-earned preferences:

1. **Gitignored `.env` is the source of truth for local scripts.** Read it freely. Never commit. Never paste contents into chat or commit messages. `.env.example` is the committed template (public values only — account IDs, bucket names, endpoints). If you need a key, it's there.
2. **Secrets have two homes:** `.env` (for scripts the agent runs locally) and Convex deployment env (for Convex functions at runtime). Keep them in sync. `CF_DNS_API_TOKEN` and `CF_PAGES_KEY` only go in `.env` — they're operator creds, not app runtime.
3. **Single-tier infra.** Default to one Anthropic workspace, one Convex project, one Cloudflare account, one R2 token. Skip dev/staging/prod splits unless there's a specific reason (cost circuit-breaker, compliance). Caches and keys amortize better unsplit. See `feedback_infra_scale` memory.
4. **Public repo from day one.** `lilith/weaver` on GitHub is public; assume every commit and doc is world-readable. No secrets, no internal-only language, no disparaging third parties.
5. **Commit messages are attribution-free.** No Co-Authored-By Claude, no "Generated with Claude Code" footers. Clean commits that read like a human wrote them.
6. **Ask before destructive.** User authorized one-off DNS record deletion in the setup session with explicit consent; treat that as scoped to that moment, not a blanket grant. Deleting resources (Pages projects, Convex projects, DNS records, R2 objects), dropping tables, force-pushing, rewriting history — all require a fresh explicit green light.
7. **Real-world-feasibility framing.** The spec-writer is less technical; don't treat spec claims as authoritative just because they're written down. When a spec claim looks optimistic (cost estimates, latency budgets, sub-linear scaling, 50ms isolate cold-starts, etc.), flag it and propose the cheaper path. `CONTEXT-HANDOFF.md` has a "Spec review guidance" section with the specific claims I'd push back on.
8. **Mobile-first is real, not aspirational.** Every UI decision considers 375px touch and a 4G network. 44px touch targets. Optimistic updates. Avoid bringing in dependencies that push the bundle beyond the 80KB target — flag before adding.
9. **No `jj` / `.workongoing` protocol here.** Those are for the Rust/work repos. This is a standard git repo in `~/fun/`.

## Things intentionally deferred

- `vite-plugin-pwa` activation — its peer range stops at Vite 7. Re-enable when they publish a Vite-8-compatible release. Wave 0 Day 10 polish anyway.
- Convex custom domain — $25/mo Pro plan, not worth it. Convex URLs are server-to-client over XHR, never user-visible.
- `packages/engine/` and `packages/test/` — workspaces configured for them but no code yet. Land when the core engine types outgrow living in `convex/` alone.
- All Wave 1 features (world bible builder, expansion loop, chat, multi-player, etc.).

## Story research & reference material

`backstory/` at the repo root is a **separate private git repo** (gitignored
by weaver) holding imported source material and LLM-extracted reference data
for specific stories used as authoring inspiration. It is multi-story; today
it holds one story (`argus-daily-grind`, 789K words across 5 volumes).

- Weaver itself is multi-story, multi-instance. **Nothing story-specific ever
  lands in this repo** — no character names, no location slugs, no copyrighted
  excerpts. All of that stays in `backstory/`.
- Agents working in `backstory/` should read `backstory/CLAUDE.md` and
  `backstory/EXTRACTION_SPEC.md`.
- The extracted/ output is shaped to match Weaver's authoring file format
  (`spec/AUTHORING_AND_SYNC.md`) so entities can later be imported into a
  Weaver world as grounding material if Lilith chooses.

## Known bugs

- `vite-plugin-pwa@1.2.0` peer range ends at Vite 7 — installed but not registered in `vite.config.ts`. PWA activation deferred until upstream ships Vite 8 support, or Day-10 polish swaps to a different PWA strategy.
- 3 dependabot advisories on GitHub (1 high, 1 moderate, 1 low) on default branch. Not yet triaged.
- **`session_token` argument pattern deviates from `ISOLATION_AND_SECURITY.md` rule 4** (which specifies `ctx.auth.userId`). Interim by design — see URGENT item 11 for the resolution path. Until then, add the lint/grep gate described there before any PR touches a mutation.
- **Isolation-adversarial test category not yet built** (URGENT item 7). First PR that adds a Day-3 mutation must also add the corresponding adversarial test in `packages/test/isolation/` — do not let this backlog grow.
- **R2 blob path + mark-sweep GC job not yet implemented.** Blobs are inline-only in Convex today. Lands when the art worker wires fal.ai → R2 (Day 4).
- **Quiet Vale backup to a separate repo pending.** The family's active shared world is only in Convex right now. User flagged 2026-04-20: "Quiet Vale needs a back up soon to a different repo." Design a `scripts/backup-world.mjs` that exports world state (entities, components, artifact_versions, blobs) to a tarball + pushes to a dedicated `weaver-family-worlds` git repo. Restore is `npx convex import` (Pro) or a custom importer re-creating entities from blob hashes. Spec 12 §Periodic snapshot has the shape. Do not delete or overwrite Quiet Vale.
- **`preauthorizeHousehold` is forward-only.** Adds memberships to existing worlds; doesn't auto-share future ones. When Lilith creates a new shared world, the mutation must be re-run. See `project_household_and_worlds` memory.

## Investigation notes

**Canonical consolidated list: `spec/LIMITATIONS_AND_GOTCHAS.md`.** 35 hard-won lessons from build (Convex runtime, SvelteKit 2 quirks, Cloudflare Workers != Node, fal.ai / Anthropic API quirks, ESM packaging, E2E harness, dev-loop velocity). Read that doc for the complete set. Hot items that cost the most time stay inline here as quick reference:

- **Convex `v.bytes()` accepts `ArrayBuffer`, not `Uint8Array`** — slice at boundary. See gotcha #1.
- **`@noble/hashes` requires `.js` suffix** in import paths. Gotcha #20.
- **Read before Write on scaffolded files** — otherwise Claude Code's Write silently no-ops. Gotcha #14.
- **Convex query vs mutation `ctx.db`** — queries are read-only; no `.patch`. Gotcha #5.
- **`pnpm dev` ≠ Pages runtime** — use `wrangler pages dev apps/play/.svelte-kit/cloudflare` as pre-push gate. Gotcha #15 + #32.
- **fal.ai key format: `<uuid>:<secret>`** — not just `<uuid>`. Gotcha #17.

Everything else: `spec/LIMITATIONS_AND_GOTCHAS.md`. When encountering a new gotcha, add it there, not here.

## Spec status

`spec/` is the authoritative design surface. Numbered docs (00–18) cover the product; named docs cover cross-cutting concerns:

- `AUTHORING_AND_SYNC.md` — file format + validator + import/export CLI for AI-authored content.
- `ISOLATION_AND_SECURITY.md` — multi-tenant isolation rules and security-adversarial test category.
- `FEASIBILITY_REVIEW.md` — flagged spec claims to verify before committing to them.
- `HANDOFF_NOTES.md` — session-handoff notes; preserved historical context.

When a spec changes, update in place (same filename). The URGENT block at the top of this file tracks only the course-corrections the next agent must act on immediately; stale entries get removed from that block once the correction is applied. `CONTEXT-HANDOFF.md` "Spec review guidance" is older context; `FEASIBILITY_REVIEW.md` supersedes it.

## Session-end checklist

Before ending a session:
1. `git status` clean or committed.
2. Commits pushed to `main` (public Pages auto-deploys on push).
3. Update `CONTEXT-HANDOFF.md` "Where everything lives" + "Code state" if anything changed.
4. Update this file's "Current status" / "Known bugs" / "Investigation notes" if anything changed.
