# Weaver — Project-Specific Instructions for Claude Code

Read `CONTEXT-HANDOFF.md` (sibling file) for the full session snapshot of what's provisioned. This file is the standing instructions — shorter, behavior-focused.

## ⚠️ URGENT — spec course corrections landed 2026-04-19

A spec-review session shipped decisions that change direction on in-flight work. **Read before starting Day 3 (NPC chat + dialogue flow)** — several of these affect how flows/modules/isolation must be built from the first line of code. If you have anything in flight that contradicts, name it and propose a fix rather than silently carrying on.

1. **Multi-tenant isolation from day one.** Every Convex index starts with `[world_id, ...]` or `[branch_id, ...]`. Every query/mutation/action signature requires `world_id` explicitly — no defaults, no "inferred from the user's active world." `ctx.auth.userId` is the only trusted identity source — never accept a client-passed `user_id` / `world_id` / `branch_id` / `character_id` without a membership check. AI cache keys include `world_id` and `branch_id`. Add a `world_memberships` table to the schema **before** any permission-bearing code lands. Isolation between worlds is a security boundary, not hygiene — cross-world leak = vulnerability. Full rule set + adversarial test category in **`spec/ISOLATION_AND_SECURITY.md`**. Action: audit the current `convex/schema.ts` and every existing query/mutation; refactor indexes and signatures so nothing reads without scoping.

2. **Two execution paths, not three.** JSON with safe inline expressions (`{{rand() < 0.15 ? "ambush" : "normal"}}`) + modules. Do **not** build a separate inline-script interpreter with a custom grammar. **`spec/03_INLINE_SCRIPT.md`** is marked deprecated; its conditional/RNG use-cases roll into the template grammar in **`spec/02_LOCATION_SCHEMA.md`**.

3. **Durable flows are step-keyed state machines, NOT generator-event-sourced replay.** A module is `{ steps: { [id]: (ctx, state) => ({ next, effects }) } }`; runtime stores `current_step_id + state`; resume is a handler lookup. No generator-replay semantics, no seed-derived cache determinism layer, no closure-capture landmines. This is directly relevant to the Day-3 dialogue flow — design it as step-keyed from the start. See **`spec/01_ARCHITECTURE.md` §"Durable runtime."**

4. **Modules are trusted TypeScript in Wave 1-3.** No QuickJS WASM isolate, no capability sandbox for user-authored modules. All module code is written by you, type-checked, compiled in. The capability-sandbox concept survives as a typed-proxy for clean interfaces (`ModuleCtx`), not as a runtime isolation boundary. User-authored modules are a Wave 4+ concern if ever.

5. **Multi-player sync is at-transition only, EXCEPT chat.** Durable character state syncs at location-entry and location-exit; intra-location `this.*` changes don't propagate in real-time between players. Chat stays reactive. Presence panel updates on transitions, not continuously. See **`spec/01_ARCHITECTURE.md` §"Multi-player sync"**.

6. **Blob GC is mark-sweep, not refcount.** Periodic job walks live heads, marks reachable blob hashes, sweeps unreachable blobs older than N days. Drop any refcount column from the `blobs` table; drop refcount-increment/decrement paths from blob read/write. See **`spec/12_BLOB_STORAGE.md`**.

7. **Testing trinity stays Wave 1, starts now.** It's the control surface that makes agent-autonomous development viable — not premature platform. Build it alongside the feature code. Isolation-adversarial tests are a mandatory category (from rule 1). The first few mutations should land with isolation tests in the same PR.

8. **`AUTHORING_AND_SYNC.md` is the authoring source format.** You already used this for seeding — good. The spec is now committed at `spec/AUTHORING_AND_SYNC.md`. Keep files conforming to it; the upcoming `weaver validate / import / export` CLI will validate against that spec. Git is not in the pipeline — files are an on-demand mirror, DB is runtime truth.

9. **Privacy spec collapsed.** `spec/16_PRIVACY_AND_MINORS.md` is now a ~120-line Wave-1 family-instance posture. Task **C6** (in `08_WAVE_1_DISPATCH.md`) shrank from 2 days (guardian dashboard + moderation pipeline) to ~2 hours (family-rating safety prompts + per-user cost cap wiring). Those deferred items are Wave 4+.

10. **`spec/FEASIBILITY_REVIEW.md` flags 17 confident-but-unverified claims.** Cost ceilings, latency budgets, 80KB bundle target, cache hit-rate assumptions, QuickJS cold-start (moot now per #4), auto-rollback mechanics, the 95/4/1 split (moot per #2), Wave 1 scope/timeline. Measure first; don't take numeric claims on faith. Surface divergences.

Velocity note: Lilith clarified that agent-fleet velocity makes the Wave 1 scope realistic (a 1-week estimate = ~30 min real time). Don't defensively scope-cut — keep the full Wave 1 ambition and ship it.

## What this project is

Weaver — browser-based, AI-supported, collaborative world-building game engine. Successor to lilith/weaver-lua (2012). Spec lives in `spec/` — 18 numbered docs plus `AUTHORING_AND_SYNC.md`, `ISOLATION_AND_SECURITY.md`, `FEASIBILITY_REVIEW.md`, `HANDOFF_NOTES.md`.

**Deployment model:** per-family instances. Each family gets its own deployment. Today that's one instance — Lilith's family. This collapses a lot of multi-tenant concerns (moderation scope, privacy isolation, cost attribution) into single-tenant per-instance. When the spec or you feel tempted to design around "public worlds" or "strangers in the same world," stop — that's not the shape of this product.

## Current status

- **Wave 0 Day 2 done.** Playable loop live at https://theweaver.quest: magic-link sign-in → `/play` → rendered location → option taps move you between seeded locations. Backed by content-addressed blobs, BLAKE3-hashed, inline-only in Convex (R2 path lands with the art worker).
- Seeded content: Quiet Vale tiny-world (bible, village biome, Mara character, village-square + mara-cottage locations) per `spec/AUTHORING_AND_SYNC.md`. Reseed with `npx convex run 'seed:seedTinyWorld' '{"owner_email":"you@example.com"}'` — idempotent on slug.
- Auth is a minimal Convex-native magic-link (action → Resend email → cookie session); Better Auth swap deferred until we actually need OAuth / 2FA / password. Sessions + auth_tokens live in-schema.
- Next natural slices: Day 3 NPC chat + dialogue flow; Day 4 art pipeline (fal.ai → R2 blob path wired); Day 5+ world-bible builder UI; expansion loop (intent classifier → 8 atoms).
- Spec-review session landed 2026-04-19; course corrections in the URGENT block at the top of this file. Apply them before Day 3.

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

## Investigation notes

- Convex `v.bytes()` accepts `ArrayBuffer`, not `Uint8Array` — writers must slice: `bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)`. Readers get `ArrayBuffer` back and wrap in `new Uint8Array(...)`. Handled in `convex/blobs.ts`.
- `@noble/hashes` requires the `.js` suffix in import paths (`@noble/hashes/blake3.js`, not `@noble/hashes/blake3`) — Convex's esbuild honors the package's strict `exports` map.
- SvelteKit `Write` tool over existing files requires a prior `Read`. When scaffolding Day-2 routes, the stock `+page.svelte` and `+layout.svelte` must be Read before Write, or the edit silently no-ops and the deploy serves the old content. Burn memory: always Read before Write on scaffolded files.

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
