# Weaver — Wave 0 Spike

## Goal

Prove the scary parts in isolation. By end of Wave 0, a single player (you) can walk into a hand-authored location, pick an option, trigger AI-generated content, see art arrive on second visit, crash the process, resume exactly where you left off.

Duration: 1-2 weeks. You + 1 tight-loop agent. Small, careful, no parallelism here — the kernel is the foundation everything else stands on.

## Deliverables

At the end of Wave 0, you have:

1. **Convex project bootstrapped** with the full schema from `01_ARCHITECTURE.md`.
2. **Location rendering** for pure JSON locations (Path 1).
3. **One hand-authored location** with a meaningful option.
4. **Art generation pipeline** end-to-end: enqueue → fal.ai → R2 → entity update → UI refresh.
5. **World bible entity** hand-crafted (short version — 1 biome, 1 character, 1 style anchor).
6. **Durable runtime skeleton** — generator-based, event-logged, replayable.
7. **One durable flow** exercising the runtime (a simple "talk to NPC" exchange).
8. **Crash test**: kill the server mid-flow, restart, confirm player resumes at the exact yield point.
9. **SvelteKit shell** with mobile-first layout, reactive queries to Convex, PWA manifest.
10. **Auto-rollback infrastructure** stubbed (pre-deploy gate running at least one smoke test).

No: world bible builder UI, expansion loop, module system, browser module designer, combat, chat, multi-player, theme generation, attribution UI, tests beyond smoke. All those arrive in Wave 1.

## Week 1 — Foundation

### Day 1: Bootstrap

- [ ] Create Convex project (`npx convex dev`).
- [ ] Create SvelteKit project (`npx sv create` → SvelteKit minimal, TypeScript strict).
- [ ] Install: `convex`, `convex-svelte`, `@anthropic-ai/sdk`, `@fal-ai/client`, `zod`, `vite`, `tailwindcss@4`, `vite-plugin-pwa`.
- [ ] Wire env: `ANTHROPIC_API_KEY`, `FAL_KEY`, `R2_*` in Convex dashboard.
- [ ] Cloudflare: R2 bucket created, API token with `Object Read & Write`.
- [ ] Deploy SvelteKit skeleton to Cloudflare Pages; verify reachable.
- [ ] `convex deploy`; verify reachable.

### Day 2: Schema + first entity

- [ ] Define schema from `01_ARCHITECTURE.md` in `convex/schema.ts`.
- [ ] Write seed data script that creates: 1 world, 1 branch, 1 character (you), 1 world bible (minimal), 1 location (JSON).
- [ ] Basic Convex queries: `getLocation(id)`, `getCharacter(id)`, `getWorldBible(id)`.
- [ ] Svelte page `/play/[location_id]` reactively shows location.
- [ ] Render Location JSON's description_template with template engine (implement mustache-like parser, ~50 LOC).
- [ ] Render options as tappable buttons.

### Day 3: Effects + movement

- [ ] Implement effect atoms (`set`, `inc`, `goto`, `say`) as pure functions.
- [ ] Wire option tap → Convex mutation `applyOption(location_id, option_index)` that:
  - Evaluates option's `condition` against state.
  - Applies `effect` list.
  - If effect includes `goto`, returns new location_id.
- [ ] Add a second hand-authored location; walk between them.
- [ ] Add `safe_anchor: true` tag to the first location; confirm tag renders in header.

### Day 4: Art pipeline

- [ ] `art_queue` table in schema.
- [ ] Convex scheduled action `artWorker` runs every 10s.
- [ ] `enqueueArt(entity_id)` mutation inserts row, sets entity.art_status = "queued".
- [ ] Worker:
  - Builds FLUX.2 prompt from world bible + location.
  - Calls fal.ai via `@fal-ai/client`.
  - Downloads image, uploads to R2 via S3 API.
  - Updates entity with `art_ref` URL + `art_status = "ready"`.
- [ ] Svelte renders `art_ref` when status is "ready"; shows biome fallback otherwise.
- [ ] Verify end-to-end: enqueue one location's art, wait, reload, see image.

### Day 5: World bible in prompts + prompt caching

- [ ] `renderWorldBible(bible)` serializes bible to a text block.
- [ ] Convex action `generateLocation(hint, parent_id)` that:
  - Reads world bible, parent, neighbors.
  - Calls Opus 4.7 with world bible in system, `cache_control: ephemeral`.
  - Validates response against LocationSchema.
  - Inserts on success.
- [ ] Manual test: run this action, observe a new location appearing.
- [ ] Verify cache writes on first call, reads on subsequent calls within 5 min (check Anthropic usage dashboard).

## Week 2 — Durable runtime

### Day 6-7: Runtime scaffolding

- [ ] Implement generator-based flow runner:
  - `Flow` is `function* (ctx)`.
  - Runner drives generator, each `yield op` is recorded to `events` table.
  - Resume: re-run generator, match yields against log, feed recorded results back.
- [ ] Implement ops: `p`, `choose`, `mutate`, `goto`.
- [ ] Wire one durable flow — talking to a simple NPC named "Violet":
  ```ts
  async function* violetGreeting(ctx: FlowCtx) {
    yield p`Violet wipes the counter. "Welcome, traveler."`
    const pick = yield choose({ greet: "Greet her back", silent: "Say nothing" })
    if (pick === "greet") {
      yield p`She smiles. "Safe roads, then."`
    }
  }
  ```
- [ ] Start flow from a JSON location's option: `{"target": "#module:violet_arc/violetGreeting"}`.
- [ ] UI shows each yielded `p` and blocks on `choose`.

### Day 8: Event log + replay

- [ ] Append-only `events` table with `flow_id`, `op_index`, `op`, `result`, `seed`.
- [ ] Replay mode: restart server, load `flow_id`, re-run generator, confirm same output up to last recorded yield.
- [ ] Crash test: kill the action mid-generator (force throw), restart, confirm player sees "resume" and picks up at the exact prior yield.
- [ ] Document determinism caveats: `now()` must come from ctx, not `Date.now()`; RNG must use `ctx.rng()`.

### Day 9: Version pinning + escape handler (minimal)

- [ ] Add `schema_version` stamping to Flow definitions.
- [ ] Registry map `{module_name: {version: handler}}`.
- [ ] Simulate deploying a v2 of `violet_arc` while a v1 flow is live: start flow, change code to v2, register new handler, confirm live flow still runs on v1.
- [ ] Write a stub escape handler for `violet_arc` v1 that just logs "ended quietly."
- [ ] Simulate GC: manually remove v1 handler from registry while flow is mid-run; confirm escape handler fires and player returns to safe anchor.

### Day 10: Polish + integration

- [ ] SvelteKit mobile layout: single-pane, bottom-anchored actions, slide-up chat panel (empty for now, just the UI scaffold).
- [ ] Service worker caches: shell + world bible + visited locations.
- [ ] PWA install prompt works on mobile.
- [ ] Desktop layout: sidebar for chat (still empty), main area for current location.
- [ ] Write a smoke test that exercises: load app → enter location → pick option → goto new location → art renders → assert no crashes. Runs in CI on every push.
- [ ] Wire Sentry or equivalent for error reporting.

## Smoke test (the "it works" checkpoint)

At the end of Wave 0, this sequence must pass:

1. Cold load of app on mobile — first paint < 2s on a 4G simulated connection.
2. World bible visible (hand-crafted, 1 character + 1 biome + 1 style anchor).
3. You arrive at location "home_porch." Description renders with your character name interpolated.
4. Three options visible; tap "Head toward the village center."
5. Arrive at "village_square." Art loads (was pre-generated or comes in within 15s).
6. Tap "Talk to Violet." Durable flow starts. See "Violet wipes the counter..." Tap "Greet her back." See "She smiles..."
7. Kill the browser tab mid-flow right before the choice. Reload. Flow resumes exactly where it was.
8. Run a manual expansion: from village_square, imagine "the old well" option is unresolved → manually trigger `generateLocation(hint="the old well")` via a debug button → within 10s, new location exists with valid JSON, linked as an option.
9. Art for the new location arrives within 30s on next visit.

If all 9 pass, Wave 0 is done.

## Deliverable: repo state

- `apps/play` — SvelteKit app
- `convex/` — schema, queries, mutations, actions (art worker, location generator, flow runner)
- `packages/engine/` — shared types, schemas, effect atoms, template engine, flow runtime
- `packages/test/` — smoke test
- `.env.example` — complete template
- `README.md` — setup + run instructions

~3000-5000 lines of real code. Reviewable in an afternoon by Lilith.

## What Wave 0 is NOT

No world bible builder UI. Bible is seeded by hand.
No expansion loop for free-text. Expansion is manual-triggered only.
No module system. Durable flows hand-coded.
No capability sandbox. Flows run trusted.
No browser designer. Everything authored in code/JSON files.
No theme generation.
No attribution UI. Pseudonyms present in schema but hardcoded.
No chat. Scaffold only.
No combat.
No multi-player. Single character, single session.
No testing trinity beyond the smoke test. Full trinity in Wave 1.

## Guardrails

- Resist scope creep. If you find yourself building a feature that feels like Wave 1, stop and note it.
- Commit frequently. A clean commit history is the best documentation for Wave 1 agents.
- Every file should have a 3-line module docstring: purpose, public API, constraints.
- All new schemas carry `schema_version: 1` from day one — the migration ladder starts at Wave 0.
- All AI calls route through `packages/engine/ai/` — one chokepoint for caching, retry, cost tracking.
