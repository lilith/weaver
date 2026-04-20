# Weaver — Handoff Notes

Read this first if you're the new agent picking up this project.

## Current project state

This is the Weaver engine — a browser-based, AI-supported collaborative world-building game. Designed for a family of 5 in closed beta, then broader. Primary developer: Lilith (experienced Rust systems programmer, image-processing specialist, the original Weaver-lua author from 2012). She handed off to you mid-spec-generation to continue execution.

Wave 0 (engine spike) has not yet started. The spec is complete, the API keys are being set up in parallel by Lilith. Your next steps depend on what phase she's ready for you to pick up.

## Spec pack inventory

All specs live in this directory. Read in this order for initial orientation:

1. **`00_OVERVIEW.md`** — vision, locked decisions, glossary. Start here.
2. **`12_BLOB_STORAGE.md`** — content-addressed immutable blobs; foundational; added late.
3. **`13_FORKING_AND_BRANCHES.md`** — how branches, dreams, state-fork testing, and cross-branch portability all fall out of the blob architecture.
4. **`01_ARCHITECTURE.md`** — engine kernel, three execution paths, durable runtime, capability sandbox, scaling, migration. Major load-bearing doc.
5. **`02_LOCATION_SCHEMA.md`** — Zod schema + worked examples.
6. **`03_INLINE_SCRIPT.md`** — the 4% path grammar + evaluator.
7. **`04_EXPANSION_LOOP.md`** — free-text to atom dispatch, world-bible prompts, art queue.
8. **`05_WORLD_BIBLE_BUILDER.md`** — 15-min family onboarding.
9. **`06_TESTING.md`** — trinity: crawler, VLM eval, replay corpus.
10. **`07_WAVE_0_SPIKE.md`** — day-by-day plan for the engine kernel (1-2 weeks).
11. **`08_WAVE_1_DISPATCH.md`** — per-task agent briefs for the MVP (3-4 weeks).
12. **`09_TECH_STACK.md`** — exact versions, install commands, `.env.example`, schema starter.
13. **`10_THEME_GENERATION.md`** — bible-to-CSS-variables theme system.
14. **`11_PROMPT_EDITING.md`** — universal "Edit with prompt" pattern.
15. **`14_COST_MODEL.md`** — aggregated costs, family-size scaling, budget controls.
16. **`15_VOICE_INPUT.md`** — Whisper WebGPU on-device transcription.
17. **`16_PRIVACY_AND_MINORS.md`** — COPPA posture, guardian tools, moderation, data flows.
18. **`17_DECISION_LOG.md`** — one-liner rationale per locked decision.
19. **`HANDOFF_NOTES.md`** — this file.

## What's new since the original 12-file pack

The first 12 files (00–11) were generated in a prior session. A review revealed gaps; the following files were added in the handoff session:

- **`12_BLOB_STORAGE.md`** (new, foundational) — content-addressed immutable blob architecture. Amends portions of `01_ARCHITECTURE.md`, `09_TECH_STACK.md`, and `11_PROMPT_EDITING.md`.
- **`13_FORKING_AND_BRANCHES.md`** (new) — full fork design built on blobs. Amends `01_ARCHITECTURE.md` and `06_TESTING.md`.
- **`14_COST_MODEL.md`** (new) — aggregated cost/scaling model. Amends `04_EXPANSION_LOOP.md`, `08_WAVE_1_DISPATCH.md`, `11_PROMPT_EDITING.md`.
- **`15_VOICE_INPUT.md`** (new) — Whisper WebGPU integration detail. Amends `05_WORLD_BIBLE_BUILDER.md`, `04_EXPANSION_LOOP.md`, `09_TECH_STACK.md`, `11_PROMPT_EDITING.md`.
- **`16_PRIVACY_AND_MINORS.md`** (new) — COPPA-conservative privacy posture. Amends `00_OVERVIEW.md`, `04_EXPANSION_LOOP.md`, `06_TESTING.md`, `08_WAVE_1_DISPATCH.md`, `09_TECH_STACK.md`.
- **`17_DECISION_LOG.md`** (new) — rationale reference.

## Important amendments to fold into the original 12

When you next touch the original docs, apply these amendments. Do this when you're editing the docs anyway, not as a separate task — it's lower-risk to update on-demand than in a big rewrite pass.

### `01_ARCHITECTURE.md`
- Add §"Blob storage" pointing to `12_BLOB_STORAGE.md`.
- Rewrite §"The store" to describe entity + components as pointers into the blob store; payloads move out-of-line.
- Add §"Branches and forking" pointing to `13_FORKING_AND_BRANCHES.md`.
- Note: the `.always.` cross-cutting hook pattern from weaver-lua isn't yet speced; Wave 2 concern; add stub section noting this as a known future feature.

### `02_LOCATION_SCHEMA.md`
- Note that `payload` is stored as a blob referenced by `artifact_versions.blob_hash`; the schema itself is unchanged.

### `04_EXPANSION_LOOP.md`
- §"Rate limits & cost ceilings" move specific numbers to `14_COST_MODEL.md`; keep concepts here.
- Add §"Moderation" stub pointing to `16_PRIVACY_AND_MINORS.md`.
- §"Two triggers" note voice is an input method for free-text.

### `05_WORLD_BIBLE_BUILDER.md`
- §"Step 4 — Characters" voice input hint should link to `15_VOICE_INPUT.md`.

### `06_TESTING.md`
- Rewrite §"Seed states" to describe state-fork testing as the harness primitive; the old in-memory snapshot sketch was approximate, blobs make it cleaner.
- §"Replay corpus" add anonymization requirements pointing to `16_PRIVACY_AND_MINORS.md`.

### `08_WAVE_1_DISPATCH.md`
- Add task **C6**: "Guardian dashboard + moderation primitives (est. 2 days)." Required before minor onboarding. See `16_PRIVACY_AND_MINORS.md` for the implementation checklist.

### `09_TECH_STACK.md`
- Add `@noble/hashes`, `@xenova/transformers` to dependencies (check current versions).
- Schema starter additions: `blobs` table, `users.is_minor` / `guardian_user_ids` / `permissions`, `branches.transient` / `branches.expires_at`, `artifact_versions.blob_hash` / `components.blob_hash` / `entity.current_version`.
- Add `cost_ledger` daily-cap enforcement pattern.
- Add `scheduled action: transient_branch_gc` for cleanup of expired dream / test branches.

### `11_PROMPT_EDITING.md`
- §"Versioning" update: `artifact_versions` stores `blob_hash` not `payload`; rollback is a pointer update.
- Voice input available in edit modal's prompt field.

## Where to start

Depends on what Lilith needs right now. Ask her.

**If Wave 0 is about to begin:**
- Re-read `07_WAVE_0_SPIKE.md` with `12_BLOB_STORAGE.md` in hand. Decide whether to integrate blobs in Wave 0 (recommended: yes, because it affects schema) or add them as the first Wave 1 task.
- Recommendation: **integrate blobs into Wave 0**. It's additive and non-disruptive at Wave 0 schema scale, and it saves a migration later. Modify the Day 2 "Schema + first entity" task to include the `blobs` table and the out-of-line payload pattern from the start.
- Verify Lilith's Tier 1 API keys are set up: Anthropic, Convex, fal.ai, Cloudflare R2. If not, she cannot run the engine spike.

**If Wave 0 is mid-flight:**
- Ask Lilith where she is. If pre-Day 4, fold blobs in. If Day 4+, defer to Wave 1.
- Run the smoke test from `07_WAVE_0_SPIKE.md` §"Smoke test" at any checkpoint; that's the "it works" gate.

**If Wave 1 is beginning:**
- Review Wave 1 dispatch plan in `08_WAVE_1_DISPATCH.md`.
- First task for you: task **A1** (schema expansion + migration framework). Include the blob storage additions from `12_BLOB_STORAGE.md`.
- Then orchestrate agent dispatch for Phase B tasks in parallel.

## Open items I (the previous agent) flagged

These are noted in the specs but worth re-surfacing:

1. **`.always.` cross-cutting hooks from weaver-lua** — the convention for code that runs on every turn (weather, time, regen). Wave 2 concern but should be designed before the module system lands. I added a brief mention in `01_ARCHITECTURE.md` (pending amendment) but no full spec.

2. **Chat architecture lineage from weaver-chat** — user → profile → display_name nesting, HMAC-signed transport if we ever split chat out as its own service. Wave 1 implements chat in-process so HMAC isn't relevant yet, but the profile/identity model should be explicit. Light spec; consider writing `18_CHAT_ARCHITECTURE.md` if Wave 2 splits chat out.

3. **Zero-retention Anthropic endpoint** — worth pursuing once past Wave 1 closed beta, required before cross-family deployment.

4. **Encryption at rest for private-world mode** — mentioned in `12_BLOB_STORAGE.md` §"Open questions." Not Wave 1. Flag for Wave 3+.

5. **Better Auth + Convex integration specifics** — `@convex-dev/better-auth` setup has concrete steps I glossed over. The agent doing Wave 1 task C5 will need to work these out. Reference: `https://convex.dev/docs/auth/better-auth` — check current version.

## Working with Lilith

Lilith is:
- Deeply technical (Rust image processing, compression codecs, systems programming).
- Opinionated (hence the rationale-heavy decision log; she pushes back on vague choices).
- Direct — no filler prose in responses, she'll say "no" without ceremony.
- On a time budget (wedding July 9, HOA litigation, parenting, running a business).
- Writes the original Weaver. The design has ancestry she knows viscerally; respect that history but also be willing to modernize (she welcomes this).

Prefer:
- Short, direct messages with concrete decisions or questions.
- Numbers and concrete tradeoffs, not hedged generalities.
- Markdown artifacts for anything substantial; inline for quick answers.
- No .docx files (explicitly noted in her preferences).

If unsure on a decision: propose a choice with rationale, ask her to confirm or redirect. Don't ask open-ended "what would you like" questions when you could give her a concrete option to react to.

## What to do if stuck

1. Check `17_DECISION_LOG.md` — the rationale may already be captured.
2. Check the relevant numbered spec file for guidance on the topic.
3. Write out your options with tradeoffs, ask Lilith directly, let her pick.

## Final orientation

The soul of Weaver is that **every decision a player makes grows the world, in a way that feels authored and coherent**. The engine is the scaffold that makes this possible without human moderation on every turn. Keep this in mind when making trade-offs — when in doubt, favor the choice that preserves the feeling of "this world was made by us, for us."

Good luck. You're picking up a well-specified project; the hard work is execution.
