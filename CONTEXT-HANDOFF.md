# Weaver — Session Handoff

*Started 2026-04-19; last updated 2026-04-20. Read this first; then
`spec/LIMITATIONS_AND_GOTCHAS.md`; then CLAUDE.md URGENT block; then
the rest of `spec/`.*

This file is a snapshot of everything provisioned, wired, decided, and
explicitly deferred. Session-end-reload entry point.

## Fast-read for the next session

1. **`CLAUDE.md`** — standing rules, URGENT-block with applied/pending
   status per course-correction, Wave 2 POSTER_CHILD ask statuses.
2. **`spec/LIMITATIONS_AND_GOTCHAS.md`** — 35+ Convex / SvelteKit /
   Cloudflare / fal.ai / ESM / env-var reality checks from actual
   build. Each one would cost ~15 min to rediscover. Scan first.
3. **`UX_PROPOSALS.md`** — 5 open design questions with leanings but
   not-my-decisions, from Ask 3 / Ask 5 work. Wave-2 review.
4. **`spec/20_POSTER_CHILD_CAPABILITIES.md`** — five Wave-2 asks
   overview table + links to specs 21–24. Ask 3 + Ask 5 shipped;
   1, 2, 4 pending.
5. **`backstory/IMPORT_CONTRACT.md`** — what the data-authoring agent
   produces. `backstory/POSTER_CHILD.md` is the parallel "why" doc.

## Latest commit: `3a51b35` (main, Cloudflare Pages auto-deploy-on-push)

Prod live at https://theweaver.quest. Five accounts in household all
pre-authed on **The Quiet Vale** (`quiet-vale-f96pf4`, 20+ locations)
and **The Office** (`the-office`, 43 entities from Argus extraction,
23 FLUX arts queued).

---

## Where everything lives

| Resource | Value / URL | Notes |
|---|---|---|
| Domain | `theweaver.quest` | Registrar: Porkbun. NS delegated to Cloudflare (`bill.ns.cloudflare.com`, `cloe.ns.cloudflare.com`). |
| Cloudflare account | `338ad3b06716695d6e2c81c864e387d8` ("Lilith's Account") | Single account hosts DNS + Pages + R2. |
| Cloudflare zone | `theweaver.quest` — zone id `19f7207d9717d8bd8d22656a68725fa0` | Active. |
| Cloudflare Pages project | `weaver` — subdomain `weaver-6ab.pages.dev` | Source: GitHub `lilith/weaver`, branch `main`. |
| Custom domains on Pages | `theweaver.quest` (active), `www.theweaver.quest` (pending → active) | CNAME-flattened to `weaver-6ab.pages.dev`. |
| R2 buckets | `weaver-images` (public via `pub-8422ad246fe048628eff9d8f2d72146d.r2.dev`) and `weaver-general` (public via `pub-01eab3f7aa66406cad7ad759e82d9d97.r2.dev`) | `art.theweaver.quest` custom-bound to `weaver-images`. |
| Convex project | team `lilith-river`, project slug `weaver` | Dashboard: https://dashboard.convex.dev/t/lilith-river/weaver |
| Convex dev deployment | `friendly-chameleon-175` | URL `https://friendly-chameleon-175.convex.cloud`, site `https://friendly-chameleon-175.convex.site`. No prod deployment yet. |
| Anthropic | default workspace, $50 deposit → **Tier 2** | 1K RPM, 450K uncached ITPM, 90K OTPM per model family. $500/mo spend cap. Single key. |
| fal.ai | single key | Used for FLUX.2 [pro] gen + FLUX Kontext edits in Wave 1. |
| Resend | `theweaver.quest` verified (all 3 DNS records imported from Porkbun during Cloudflare scan) | Sender: `Weaver <noreply@theweaver.quest>`. |
| GitHub | `lilith/weaver` public | 3 commits so far: `1488590` initial, `bd2fa9c` Wave 0 bootstrap, `4d3bd0a` adapter swap. |

## Credentials ledger

Two storage locations by intent:
- **Convex deployment env** — read by Convex functions at runtime. Set via `npx convex env set KEY VAL`. Survives across code changes. Already populated with: `ANTHROPIC_API_KEY`, `FAL_KEY`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_IMAGES_BUCKET/_ENDPOINT/_PUBLIC_URL`, `R2_CACHE_BUCKET/_ENDPOINT/_PUBLIC_URL`, `PUBLIC_APP_URL`.
- **Local `.env`** — gitignored; agents in this repo use these for scripts that run locally (CF API calls, ad-hoc tests, seed scripts). Mirrors Convex env where overlap exists. Also contains `CF_DNS_API_TOKEN` (scope: DNS Edit + Zone Read on this zone) and `CF_PAGES_KEY` (scope: Pages Edit on this account). Neither belongs in Convex — they're infra-operator creds, not app runtime.

`.env.example` is committed and **intentionally publishes** non-secret values: account ID, bucket names, R2 endpoint URLs, R2 public URLs, domain, sender email. These authenticate nothing.

**Key hygiene notes for reviewer:** user agreed that keys temporarily appearing in conversation transcripts were acceptable; declined rotation. If reviewing session spots a leak via another vector, revisit.

## Code state

Committed layout:

```
weaver/
├── apps/play/             SvelteKit 2 / Svelte 5 runes / Vite 8 / Tailwind 4.
│                          Stock `sv create` output + @sveltejs/adapter-cloudflare.
│                          No Weaver routes yet. Builds cleanly; deploy confirmed.
├── convex/
│   ├── schema.ts          Full schema from spec/09_TECH_STACK.md — all 15 tables
│   │                      (users, worlds, branches, characters, entities,
│   │                      components, relations, art_queue, flows, events,
│   │                      chat_threads, chat_messages, mentorship_log,
│   │                      cost_ledger, themes, artifact_versions).
│   │                      Deployed. No functions yet.
│   ├── README.md          Convex boilerplate, unchanged.
│   └── _generated/        gitignored, regenerated by `npx convex dev`.
├── spec/                  12 design docs from files.zip, committed verbatim.
│                          See "Spec review guidance" below before treating
│                          any claim as authoritative.
├── .env.example           Public template.
├── .env                   Gitignored. Secrets.
├── .env.local             Gitignored. Convex-written deployment ids.
├── .gitignore             Merged pnpm + sv + Weaver-specific lines.
├── pnpm-workspace.yaml    Workspaces: apps/*, packages/*. onlyBuiltDependencies
│                          auto-added for esbuild and @tailwindcss/oxide.
├── package.json           Root. Has `convex`, `@anthropic-ai/sdk`,
│                          `@fal-ai/client`, `@aws-sdk/client-s3`, `zod`.
├── README.md              Project landing page.
└── LICENSE                AGPL-3.0.
```

No `packages/engine/` or `packages/test/` yet — those land during Wave 0 Day 2+.

## Spec review guidance

Twelve documents in `spec/`. User's framing: spec-writer is **less technical**; a real-world-feasibility pass is needed. When the reviewer session opens them, approach skeptically. Notes from implementing against them:

**Things the spec is confident about that may or may not survive contact with reality — flag for challenge:**

- **Three execution paths (JSON / inline script / durable module)** — Elegant on paper. Risk: the split ratio (95/4/1) is a guess; once family play starts, the "4% inline" bucket may balloon into "30% — everyone wants a tiny random encounter." Worth asking: would two paths (JSON + module) cover the same ground with less engine surface?
- **Event-sourced generator replay for durable flows** — Clever, but JS generator semantics + Convex mutation boundaries + "cache AI by seed" + escape handlers on version GC is a lot of moving parts. At least one of those sub-claims will be wrong on first implementation. Where?
- **QuickJS WASM isolate for user-authored modules** — 50ms wall-clock limit, 10MB memory. Has anyone actually measured cold-start of a QuickJS WASM module inside a Convex action? The spec assumes this is fine; it might be 200ms and unusable on mobile.
- **Testing trinity budget — "~$0.20 per PR"** — Depends entirely on cache hit rates and the size of the state-space at depth 8. If the fuzzed free-text set grows or caching degrades, this could 10x.
- **Free-text expansion "2–4s text, 4–7s art"** — Opus 4.7 with 8K context + generation is plausibly 2–4s. But "art on next visit" only lands if players move on quickly. For family-of-5 sessions where everyone's watching one screen, visible wait for first render may hurt the "magical" feel.
- **World bible prompt caching economics** — Spec assumes aggressive cache hits. Current rule (verified against Anthropic docs this session): cache reads don't count toward ITPM on 4.x models, 0.10x input price on reads, 1.25x on 5m-TTL writes, minimum 4096-token prefix for Opus 4.7. Bible at 5–15K tokens easily clears that. But **caches are workspace-isolated as of 2026-02-05**. Not a problem at current single-workspace setup, but relevant if the reviewer proposes splitting envs.
- **Mobile-first with ≤80KB initial bundle** — SvelteKit + Convex client + reactive subscriptions... possible, but current stock scaffold is already ~15KB gzipped before any app code. 80KB ceiling becomes a real constraint; worth flagging.
- **PWA + offline via Convex built-in queue** — Convex's offline behavior is real but opinionated. Untested whether reactive queries degrade gracefully on poor networks. `vite-plugin-pwa` also doesn't yet declare Vite 8 support (peer range ends at 7) — installed but with a warning.
- **Attribution / pseudonym model** — Spec describes it cleanly but doesn't grapple with: what happens when a kid picks a pseudonym an adult objects to? Moderation UX isn't fleshed out. Reviewer should press.
- **"$150–$200 total Wave 1 dev cost"** — Based on rough per-call multiplications. Real agent-fleet parallelism in Wave 1 is where I'd expect the budget to slip, especially if any agent loops on a failing build.
- **The combat-refactored-into-module promise** — "Clean boundary" is load-bearing. Spec doesn't define the actual module interface concretely. Wave 1 hardcoded combat may develop couplings that make the Wave 2 extraction hard.

**Claims I verified and found solid:**

- Anthropic pricing structure and rate-limit tiers (matches current docs).
- Convex schemaless payload + typed component_type pattern (worked cleanly — deploys fine, indexes as expected).
- Cloudflare Pages + SvelteKit adapter-cloudflare → `.svelte-kit/cloudflare` output (built + deployed successfully).
- R2 S3 + public URL model (buckets exist, custom domain bound).
- Resend DNS auto-import during Cloudflare zone scan (the 3 verification records were already present, domain verified without manual intervention).

**Things the spec explicitly deferred that are still deferred here:**

- vite-plugin-pwa activation (Day 10 polish anyway).
- R2 custom-domain CNAME for `art.theweaver.quest` — *now added* (user did it during session).
- Convex custom domain — *explicitly declined*; $25/mo Pro plan not worth it since Convex URLs are server-to-client only.
- All Wave 1 code.

## Open questions for the next session

1. **Where does inline-script authoring live in the UI for a 7-year-old?** Spec waves at "browser designer, voice input, AI-suggest." Reality: a text editor with Weaver grammar is not a 7-year-old UX. Either the script path only works for adults (say so), or the AI-suggest has to be airtight.
2. **How does a family-mod approve a kid's prompt edit?** Spec mentions mod queue but doesn't describe the approval UX or notification path.
3. **Does "auto-rollback" on deploy presume Convex version pinning the spec hasn't actually verified works this way?** Worth checking against Convex docs — spec makes a strong claim.
4. **What's the migration path for real user data if Wave 0 schema needs breaking changes?** The spec says "migrations are append-only pure functions" — but the schemas referenced by component_type aren't in Convex's type system, so migrations for payload shapes are all in application code. This is fine *if* the test/replay corpus is good enough, which depends on the trinity actually being implemented on schedule.
5. **Single-device family UX vs. multi-device presence** — Spec says "world bible builder is one-device-passed-around" but later says "multi-player presence" and "per-location chat threads." The handoff between those modes isn't designed.
6. **Cost ledger enforcement** — Spec describes per-world daily cap with graceful "the world is resting tonight." What about cost ledger *before* the world exists (during onboarding)? A family could accidentally burn $5 in the bible builder if retries stack.

## Preferences I learned this session (applies to future sessions)

- **One of everything — no enterprise tiering.** One Anthropic workspace, one key, one Convex project, one Cloudflare account. Saved in memory as `feedback_infra_scale.md`.
- **Full autonomy via gitignored `.env`.** Agent reads keys directly; never commits; never paste into chat. Saved as `feedback_autonomous_env.md`.
- **Public repo from day one.** `.env.example` publishes non-secret IDs; commit messages and docs go straight to public.
- **Attribution-free commits.** No Co-Authored-By / "Generated with Claude" lines.
- **Ask before destructive.** DNS record deletion was approved explicitly; I don't have blanket destructive-action authority.

## What the next session should do first

1. Read this file.
2. `git log --oneline -10` to confirm head is at `4d3bd0a` (or further).
3. Skim `spec/00_OVERVIEW.md` and `spec/01_ARCHITECTURE.md`, then the newer spec files the user adds, with skeptical eye per "Spec review guidance" above.
4. Before implementing any new spec: flag tensions in the review document and surface to user. Goal is a feasible plan, not fidelity to the written spec.
5. Verify nothing has drifted (`.env` vs `npx convex env list`, DNS records, Pages project status).
