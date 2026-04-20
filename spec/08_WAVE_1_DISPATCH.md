# Weaver — Wave 1 Dispatch

## Goal

Ship the MVP: a playable product for a family of 5, 3-4 weeks after Wave 0 wraps. Locked scope:

- World bible builder (15-min onboarding).
- Location lifecycle with all three execution paths.
- Free-text expansion loop (intent classifier → 8 atoms → handlers).
- Background art queue.
- Multi-player presence + per-location chat threads.
- Pseudonym attribution on all artifacts.
- Theme generation during bible build.
- Prompt-based editing of locations, scripts, and images.
- Mentorship log (captured, not yet used for style steering).
- Testing trinity (all three: crawler, VLM eval, replay corpus).
- Auto-rollback on deploy.
- Combat system (hardcoded with clean module boundary).
- Closed-beta auth (Better Auth + Resend magic links, family whitelist).

Out of scope for Wave 1:
- Module system / capability sandbox (Wave 2).
- Browser module designer (Wave 2).
- New Day loop (Wave 2).
- Branches, dreaming, era chronicle, voice input (Wave 3).
- 2D tile view (Wave 4).

## Team structure

- **You** (Lilith) hold the engine kernel, AI integration layer, schema changes, and test infrastructure decisions.
- **Agent fleet** (Claude Opus 4.7 primary, Sonnet 4.6 secondary) takes content and UI tasks in parallel.
- **1 trusted agent** runs the integration branch: merges ready PRs, runs the trinity, rebases.

Expected agent parallelism: 6-10 agents simultaneously, each on an independent branch, each with their own task brief.

## Task briefs

Each brief is a self-contained document given to an agent at dispatch. Structure:

- Task ID
- Dependencies (must be merged first)
- Deliverable description
- Acceptance criteria (tests that must pass)
- SKILL.md references (relevant skills pre-loaded into the agent's context)
- Files the agent may touch
- Files the agent must NOT touch
- Expected effort (in agent-hours)
- Owner (the agent ID or "unassigned")

### Phase A — Foundations (week 1, mostly serial, 1-2 agents + you)

#### A1. Schema expansion and migration framework

**Depends on:** Wave 0 complete.
**Deliverable:** Full Convex schema from `01_ARCHITECTURE.md`, migration framework, seed migration from Wave 0 state.
**Acceptance:**
- All tables + indexes present.
- Migration runner applied to Wave 0 data without loss.
- Unit tests for migration v0→v1.
**Files:** `convex/schema.ts`, `convex/migrations/`, `packages/engine/migrate.ts`.
**Not touched:** UI code.
**Effort:** 0.5 day.
**Owner:** you.

#### A2. World bible entity + builder backend

**Depends on:** A1.
**Deliverable:** `worldBible` entity schema, mutations to create/update, Convex actions that call Opus for tone refinement and for style candidate generation.
**Acceptance:**
- Can create a world bible via Convex mutation from a test script.
- Can generate 3 candidate style images in parallel.
- Can add characters, biomes, facts, taboos.
**Files:** `convex/worldBible/*`, `packages/engine/schemas/worldBible.ts`.
**Effort:** 1 day.
**Owner:** agent.

#### A3. Intent classifier + atom dispatcher

**Depends on:** A1.
**Deliverable:** Haiku 4.5 intent classifier as Convex action; atom dispatcher routing to 8 handler functions.
**Acceptance:**
- Classifier runs on a corpus of 100 sample inputs with >95% correct atom assignment.
- Dispatcher has stubs for all 8 handlers; each returns structured result.
- Cached responses so tests don't pay per-run.
**Files:** `convex/intent/*`.
**Effort:** 1 day.
**Owner:** agent.

#### A4. Testing trinity scaffolding

**Depends on:** A1.
**Deliverable:** Crawler, VLM eval harness, replay runner. Seed state library. One seed of each test type working.
**Acceptance:**
- `pnpm test:crawler` runs a 30-second crawl and reports.
- `pnpm test:vlm` renders 20 screenshots and evaluates.
- `pnpm test:replay` runs the 3-session seed corpus.
- All three wired into CI (GitHub Actions), posting results to PR.
**Files:** `packages/test/*`, `.github/workflows/trinity.yml`.
**Effort:** 2 days.
**Owner:** you + 1 agent in pair.

### Phase B — Core loop (week 2, high parallelism, 4-6 agents)

These tasks run concurrently. Each agent gets one.

#### B1. Location expansion handler (create_location atom)

**Depends on:** A2, A3.
**Deliverable:** The `create_location` handler — stub entity creation, Opus generation call, validation, insertion.
**Acceptance:**
- Given a hint and parent location, produces a valid LocationSchema entity within 5s.
- Consistency check: new location doesn't reference unknown characters or contradict established facts.
- Retry logic (up to 2 retries) on validation failure.
- Full test coverage in replay corpus.
**Files:** `convex/intent/handlers/createLocation.ts`, `packages/engine/generation/locationPrompt.ts`.
**Effort:** 2 days.

#### B2. Art queue and worker

**Depends on:** A1.
**Deliverable:** `art_queue` table, scheduled worker, fal.ai integration, R2 upload, status tracking, biome fallback images.
**Acceptance:**
- Enqueuing an entity triggers generation within 10s.
- Failed generations retry 3x then mark failed.
- Biome fallback set of 8 baseline images pre-uploaded.
- Art updates propagate to clients via Convex reactive queries.
**Files:** `convex/art/*`, `packages/engine/art/*`.
**Effort:** 2 days.

#### B3. Move / examine / take / talk / attack handlers

**Depends on:** A3.
**Deliverable:** The 5 simpler atom handlers.
**Acceptance:**
- Move: resolves target, updates character location, triggers on_enter.
- Examine: produces narration; no state change.
- Take/give: inventory mutation.
- Talk: routes to NPC dialogue flow or Sonnet exchange.
- Attack: emits start_combat event with target.
- Each handler has 10+ tests in unit + replay corpus.
**Files:** `convex/intent/handlers/{move,examine,take,talk,attack}.ts`.
**Effort:** 3 days (can be split across 2-3 agents).

#### B4. World bible builder UI

**Depends on:** A2.
**Deliverable:** 7-step Svelte onboarding flow matching `05_WORLD_BIBLE_BUILDER.md`.
**Acceptance:**
- Mobile-first layout (single-screen steps, bottom action).
- Multi-family-member handoff pattern working.
- Voice input (Whisper WebGPU) for text fields.
- Generates parallel candidates during steps 3-5.
- Theme preview in step 7.
- End-to-end: fresh family completes bible in <15 min.
**Files:** `apps/play/src/routes/onboarding/*`, `apps/play/src/lib/onboarding/*`.
**Effort:** 3 days.

#### B5. Location rendering + options UI (mobile + desktop)

**Depends on:** A1.
**Deliverable:** Full location page UI: description, options, art area, chat panel, author byline.
**Acceptance:**
- Mobile (375px) and desktop (1440px) layouts.
- Touch targets ≥44px.
- Optimistic updates on option tap.
- Reactive to Convex state changes (another player moves, art arrives).
- Chat panel slides up from bottom on mobile, sidebar on desktop.
**Files:** `apps/play/src/routes/play/[location]/*`, `apps/play/src/lib/ui/*`.
**Effort:** 3 days.

#### B6. Per-location chat

**Depends on:** A1, B5.
**Deliverable:** Per-location chat thread with reactive messaging, profile-level identity, mute/ignore.
**Acceptance:**
- Messages posted to a location thread visible to all players at that location.
- Profile attribution (display name from character pseudonym).
- Mute: client-side, stored in character settings.
- Chat history persists across sessions.
- Pagination of old messages.
**Files:** `convex/chat/*`, `apps/play/src/lib/chat/*`.
**Effort:** 2 days.

### Phase C — Integration + polish (week 3, 3-4 agents + you)

#### C1. Combat system (hardcoded)

**Depends on:** B3 (attack handler).
**Deliverable:** Text-based turn combat with AI narration of outcomes.
**Acceptance:**
- On start_combat event, enter combat mode.
- Turn loop: enumerate actions (attack, defend, use item, flee), player picks, resolve with dice + AI narrate.
- Combat ends on one side reaching 0 HP or flee success.
- Drops / gold / XP applied on victory.
- Death returns player to nearest safe anchor with a penalty.
- Clean module-boundary interface (list in code comments) so Wave 2 refactor into module is trivial.
**Files:** `convex/combat/*`, `apps/play/src/lib/combat/*`.
**Effort:** 4 days.

#### C2. Theme generation + Tailwind variable binding

**Depends on:** A2.
**Deliverable:** Theme JSON generation from world bible, wired to Tailwind 4 CSS variables at root.
**Acceptance:**
- Theme generator produces valid JSON matching ThemeSchema.
- Changes propagate instantly via Convex reactive query.
- "Regenerate theme" action works.
- See `10_THEME_GENERATION.md` for full spec.
**Files:** `convex/themes/*`, `apps/play/src/lib/theme/*`.
**Effort:** 2 days.

#### C3. Prompt-based editing (images and code/JSON)

**Depends on:** B1, B2.
**Deliverable:** Universal "Edit with prompt" affordance on every artifact.
**Acceptance:**
- Image edit: queues FLUX Kontext edit, new version produced, diff view.
- Location JSON edit: Opus rewrites against bible + existing, validator runs, diff shown, confirm/reject.
- Inline script edit: same as JSON, with script-specific validation.
- Versioning: every edit creates a new version; previous restorable.
- Mentorship log entry for every edit.
- Permissions: owner all, author own, family-mod any-with-attribution.
- See `11_PROMPT_EDITING.md` for full spec.
**Files:** `convex/editing/*`, `apps/play/src/lib/editing/*`.
**Effort:** 3 days.

#### C4. Multi-player presence + attribution UI

**Depends on:** A1, B5.
**Deliverable:** "Where is everyone" panel, live location updates, pseudonym display everywhere, history view on artifacts.
**Acceptance:**
- Panel shows each character's current location in real time.
- Location byline shows `discovered by <pseudonym>`.
- "View history" on any artifact shows version list with authors and timestamps.
- Never shows real user_ids.
**Files:** `apps/play/src/lib/presence/*`, `apps/play/src/lib/attribution/*`.
**Effort:** 2 days.

#### C5. Better Auth + Resend magic links + family whitelist

**Depends on:** A1.
**Deliverable:** Auth flow, closed-beta whitelist, per-family-mod admin controls.
**Acceptance:**
- Magic link via email works on mobile and desktop.
- Whitelist gates: only emails on the list can sign up.
- World owner can invite by email.
- Family-mod role assignable.
**Files:** `apps/play/src/routes/auth/*`, `convex/auth/*`.
**Effort:** 1 day.

### Phase D — Deploy + closed beta (week 4, you + 1 agent)

#### D1. Deploy pipeline + auto-rollback

**Deliverable:** GitHub Actions → Convex deploy → Cloudflare Pages deploy, with shadow environment and auto-rollback wired.
**Acceptance:**
- Merge to main deploys automatically.
- Shadow runs trinity for 1 hour pre-cutover.
- Post-cutover monitors for 1 hour; auto-reverts on threshold breach.
- Sentry integrated for error tracking.
**Effort:** 2 days.

#### D2. Onboard family

**Deliverable:** Gen, Jason, and 2 other family members onboarded into beta.
**Tasks:**
- Invite via Resend magic links.
- Together, build a first world bible (you moderate).
- Play a 30-min session together.
- Capture feedback; open issues for top 5 pain points.
**Effort:** 1 evening.

#### D3. Iteration loop

Days 25-28 are buffer: fix the top issues from D2 feedback. Prioritize mobile UX snags, not architecture.

## Integration branch policy

- `main` is the integration branch; never commit directly.
- Every task PR rebases onto `main` before merge.
- Trinity must pass on the PR branch before merge.
- Merges are fast-forward; no merge commits.
- The integration agent (a single trusted agent) runs merges in sequence, resolving conflicts with authoring agents via PR comments.

## Coordination rhythm

- Daily: integration agent posts a status summary (what merged, what's in flight, what's blocked) to a shared doc.
- Every other day: you review open PRs for architectural consistency.
- Weekly: you + integration agent do a 30-min retro on what's slowing progress.

## Budget expectations

Wave 1 development cost (LLM + image gen):

- Dispatch + review (Opus for planning, Sonnet for code): ~$50-100
- Test trinity runs on PRs: ~$10/week × 4 weeks = $40
- Art generation during development: ~$30
- World bible builds during testing: ~$20

**Total Wave 1 development cost: ~$150-200.**

Playtest costs (family of 5 playing during D2/D3): covered by your normal per-family budget of ~$16/week.

## Ship criteria

Wave 1 ships when:

1. Family of 5 plays a 30-min session without any crash or "I'm stuck" moment.
2. Trinity coverage ≥ 95% on main branch.
3. Free-text expansion works end-to-end in <5 seconds median.
4. Generated art arrives within 30 seconds of first visit for 90% of new locations.
5. Every artifact shows attribution.
6. Prompt-based editing works on locations, scripts, and images.
7. Combat text-narrated session completes without state corruption.
8. Auto-rollback triggered at least once in staging, verified to work.
9. You + family feel it's fun, not just technically correct.

Criterion 9 is the non-negotiable one.
