# Weaver — Project-Specific Instructions for Claude Code

Read `CONTEXT-HANDOFF.md` (sibling file) for the full session snapshot of what's provisioned. This file is the standing instructions — shorter, behavior-focused.

## URGENT block — resolved / deferred status (2026-04-20)

The 11-item spec-review block from 2026-04-19 is substantially resolved. Status legend: ✅ shipped · 🟡 partial · 📘 spec-only (deliberate) · ⏳ deferred.

1. ✅ **Multi-tenant isolation.** All indexes start with `[world_id, ...]` or `[branch_id, ...]`. `resolveMember` helper enforces membership. 35/35 adversarial Playwright tests pass against every world-scoped mutation/query.
2. ✅ **Two execution paths.** JSON options + template grammar (ternary / arithmetic / rand / dice / has / length / bracket subscript) + step-keyed flows. Spec 03 inline-script stays marked DEPRECATED; never built.
3. ✅ **Step-keyed flows shipped.** `flows.current_step_id + state_json`; counter + dialogue + combat modules live in `convex/modules/*`. No generator-replay anywhere. `flow_transitions` diagnostic table is spec-only for now.
4. 📘 **Trusted-TS modules only.** Wave 1-3 posture preserved.
5. ⏳ **Multi-player at-transition sync** — not yet relevant. Still single-player deployments.
6. 🟡 **Blob GC is mark-sweep** — shape correct; mark-sweep job not yet built. `convex/crons.ts` shows the pattern (weekly `runtime_bugs` GC).
7. ✅ **Isolation-adversarial tests are real.** 35 scenarios, every new mutation lands with one. URGENT rule 7 resolved.
8. ✅ **`AUTHORING_AND_SYNC.md` shipped.** `weaver export / validate / sync / push / fix` are the on-demand files↔DB mirror. Convex is runtime truth.
9. 📘 **Privacy spec collapsed.** Family-rating posture.
10. 🟡 **FEASIBILITY_REVIEW claims** — mostly validated in flight (cost ceilings held, cache-hit behavior confirmed). Some still on paper.
11. 🟡 **`session_token` pattern vs `ctx.auth`.** Spirit satisfied (never client-claimed user_id); letter awaits Better Auth. Grep gate NOT YET in CI — add if needed. Not a playtest-blocker.

## POSTER_CHILD asks (spec 20) — all shipped

Ask 1 biome rules · Ask 2 item taxonomy · Ask 3 world clock · Ask 4 NPC memory · Ask 5 narrative prompt assembler. See per-spec status headers in `spec/21_BIOME_RULES.md`, `22_ITEM_TAXONOMY.md`, `24_NPC_AND_NARRATIVE_PROMPTS.md` for what's shipped vs. deferred per ask.

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

**All 5 POSTER_CHILD asks shipped** (spec/20):
- Ask 1 — biome rules (spec 21) ✅ time_dilation + on_enter/on_leave/on_turn hooks + ambient_effects (seeded-RNG `chance` gating) + spawn_tables (atmospheric tier). `flag.biome_rules` on for sandbox, Quiet Vale, The Office. Commit `0ad8b67`, polish `b67baf3`.
- Ask 2 — item taxonomy (spec 22) ✅ kind discriminator, per-kind blocks, structured inventory `{slug: {qty, kind, ...}}`, give/take/use/crack_orb effects, narrate effect (Sonnet, via scheduler, flushes to `pending_says`). `flag.item_taxonomy` on. Commit `8764aec`.
- Ask 3 — world clock ✅ (pre-existing).
- Ask 4 — NPC memory (spec 24) ✅ `npc_memory` table + `<speaker_memory>` injection in assembleNarrativePrompt + auto-write on narrate with `memory_event_type`. `flag.npc_memory` on. Commit `b5a6da2`.
- Ask 5 — shared narrative prompt assembler ✅ (pre-existing, extended for Ask 4).

**Wave-2 game systems + runtime (all shipped this cycle):**
- Feature flags runtime (`flag.*` resolution char→user→world→global) — `9efbf42`.
- Effect router (`convex/effects.ts` — central dispatcher) — `8764aec`.
- Step-keyed flow runtime + counter + dialogue + combat modules — `83d25d4`, `fd0ddd7`.
- Text prefetch (`flag.text_prefetch`) — speculative expansion on unresolved-target options, draft visited_at distinguishes pre-warmed from played — `7a8f7aa`.
- Two-way content sync — `weaver export / validate / push / sync / fix` CLI — `0680473`.
- Runtime diagnostics — `runtime_bugs` table + sanitizers on hot paths + `weaver bugs` + weekly GC cron — `57e49ef`, `02a6774`.
- Expression grammar v2 — ternary, `+ - * /`, `rand()/dice()/min/max/pick/has/length`, bracket-subscript — `57e49ef`, `6017f50`.
- Biome palette auto-gen (Opus → stored in biome entity payload) — `57e49ef`.
- Expansion streaming (`flag.expansion_streaming`) — live prose chunks via Anthropic streaming API + reactive Convex row + `<StreamingPanel>` → navigates on done — `4e81239`.
- Art curation (spec ART_CURATION.md, `flag.art_curation`) — `entity_art_renderings` + `art_feedback` + `art_reference_board`, 5 Wave-2 modes (ambient_palette/banner/portrait_badge/tarot_card/illumination), retrofit migration. Wardrobe UI with eye-icon reveal + mode picker + variant controls + "↻ roll again" tap-to-cycle. `b47bee1`, `9fda9e0`, `2ed577f`.
- **Reference-image pipe** — `runGenVariant` consults the reference board (priority: entity → biome → mode → style), when a ref exists switches to `fal-ai/flux-pro/kontext` with `image_url = <public R2 URL of top-1 pinned blob>`. Cheap schnell fallback when no refs. — `9836bca`.
- Eras v1 + v2 (spec 25, `flag.eras`) — `worlds.active_era`, `chronicles` table, `advanceEra` action (Opus chronicle with bible-voice pin), `characters.personal_era`, `pendingEraCatchup` query, `acknowledgeEraCatchup` mutation, in-game catch-up panel on play page, era badge. `/admin/eras/<slug>` page. — `b67baf3`, `9836bca`.
- Admin UI surfaces — `/admin/<slug>` index, `/admin/art/<slug>` reference-board manager, `/admin/bible/<slug>` AI-feedback bible editor (Opus suggests diff → owner approves → new artifact_version with optimistic concurrency check), `/admin/eras/<slug>` — `2ed577f`, `b67baf3`.

**Tests:** 28/28 CLI gameplay-sweep (cheap path), 38/38 with `--long` (hits Sonnet + combat rounds); 35/35 Playwright (28 isolation + 4 Wave-2 UI + 3 core); 0 svelte-check errors; clean Cloudflare build on push.

**Live at:** https://theweaver.quest. Pages auto-deploys on push to main.

**Explicitly deferred** (in FEATURE_REGISTRY, not blocking):
- Async-sync campaign (spec ASYNC_SYNC_PLAY) — waiting on real multi-player need.
- Eras v3 — per-era authoring files, era-gated entity visibility, era_version_map runtime consultation.
- Chat (spec 18) — Lilith's call: "we're in the same room."
- Quiet Vale → separate-repo backup.

**Creative reimagine in progress:** Lilith flagged both live worlds as "meh/endgame walking sim" on 2026-04-20. Brief for a creative agent at `tasks/REIMAGINE_WORLDS.md` — wire combat/inventory/modules/eras into Quiet Vale + The Office without touching code.

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

## ⚠️ ONE Convex deployment — never run `npx convex deploy`

**We have ONE live Convex deployment backing theweaver.quest: `friendly-chameleon-175`.** The Convex account also has a `animated-dodo-350` slot marked "prod", but it's empty and unused — `npx convex deploy` (without flags) targets it by default, and running it silently breaks nothing (prod stays stale) but wastes a deploy.

**To push code to the real deployment:**

```bash
pnpm run push-convex                 # = CONVEX_DEPLOYMENT=dev:friendly-chameleon-175 convex dev --once
```

This is what the root `package.json` has. Do NOT:
- `npx convex deploy` — pushes to unused prod slot.
- `pnpm run deploy` — the root script has a guard that exits with an error explaining this.

**Cloudflare Pages** (`PUBLIC_CONVEX_URL` in both preview + production env) points at `friendly-chameleon-175`. Our site, our CLI (`~/.weaver-cli.json` → `friendly-chameleon-175`), and every script in `scripts/*.mjs` all target the same deployment. Single tier, per user preference (`feedback_infra_scale`).

**If `animated-dodo-350` ever needs removal:** only the Convex dashboard can delete a prod deployment. Leave it idle; don't bother.

**`scripts/weaver.mjs` — the agent CLI.** Non-interactive, one-shot-per-invocation, LLM-optimized. Build/explore your own sandbox world (author mode: full rwx) or read-only inspect someone else's world with narrow non-destructive fix caps (observer mode, auto-detected from world ownership). Supports the full play loop + clock fast-forward + direct state mutation + hidden-option dry-run (the UX-01 inspection surface the browser can't show). Back-plane lives in `convex/cli.ts`. Usage: `node scripts/weaver.mjs help`. Session persisted to `~/.weaver-cli.json`. Use it before driving the browser when the question is "does this feel LitRPG-y / fun / coherent" — it's an order of magnitude faster than Playwright for that loop.

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
- **Isolation-adversarial tests** — 35 Playwright scenarios now cover every world-scoped mutation/query shipped through 2026-04-20. Every new mutation must add a matching test alongside its commit. ~~URGENT rule 7 resolved.~~
- **R2 blob path + mark-sweep GC job not yet implemented.** Art blobs go to R2 via the FLUX worker; arbitrary mark-sweep of unreferenced blobs is still a TODO. Runtime `runtime_bugs` cron shows the pattern for weekly jobs if you wire it.
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
