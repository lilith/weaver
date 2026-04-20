# Weaver — Testing

## Why this is possible

Weaver's game design has a crucial property: **the action space at any moment is bounded**. Every decision is either:
- A tap on one of N options, OR
- A free-text input that classifies into one of 8 atoms.

That means we can exhaustively crawl the state space. Automated testing isn't a nice-to-have — it's the mechanism that makes agent-dispatched development safe without human oversight.

Three independent testing systems run on every PR:

1. **State-space crawler** — explores game tree from seed states.
2. **VLM screenshot eval** — renders states to images, has a cheap model check correctness.
3. **Replay corpus** — recorded player sessions re-run against current code.

All three gate deploys via auto-rollback.

## Trinity #1 — State-space crawler

### What it does

For each PR, start from a curated set of **seed states** (fresh spawn, mid-game, post-combat, etc.). BFS-expand each state up to depth N, enumerating every valid action. For every reachable state, assert invariants.

### Invariants (non-negotiable, checked at every state)

1. Character inventory is consistent with world state (no dangling item refs).
2. No negative resources (gold, hp, energy) unless explicitly allowed.
3. All referenced entity IDs resolve to live entities.
4. Current flow stack is resumable (version handlers exist).
5. At least one forward action exists (no dead ends unless terminal-by-design).
6. Render produces valid JSON output (no undefined, no NaN, no unrendered `{{vars}}`).

### Implementation sketch

```ts
// packages/test/crawler.ts
async function crawl(seed: WorldState, depth: number) {
  const visited = new Set<string>()
  const queue: [WorldState, number][] = [[seed, 0]]
  const issues: Issue[] = []

  while (queue.length) {
    const [state, d] = queue.shift()!
    const hash = hashState(state)
    if (visited.has(hash)) continue
    visited.add(hash)

    // Invariant checks
    const stateIssues = checkInvariants(state)
    issues.push(...stateIssues)
    if (d >= depth) continue

    // Enumerate actions
    const actions = enumerateActions(state)  // from current location's options +
                                             // fuzzed free-text inputs (canonical set)
    for (const action of actions) {
      try {
        const nextState = await applyAction(state, action)  // pure, deterministic
        queue.push([nextState, d + 1])
      } catch (e) {
        issues.push({ kind: "crash", state, action, error: e })
      }
    }
  }

  return { visited: visited.size, issues }
}
```

### Budget

At depth 8 with average branching factor 3-4, ≈ 6,500 – 65,000 states per seed. Lilith sketched exactly this design in `todo.mdown`: "(2-4)^8 = 256-65,536, a reasonable number of states."

Run time: ≈ 30-90 seconds per seed on a standard Convex test harness. Cost: effectively free (all-deterministic with AI cache; no live LLM calls because the cache covers every reachable AI response from the corpus).

### Seeds

Maintained in `packages/test/seeds/`. Each seed is a JSON state snapshot. Seeds added whenever a new game mechanic lands. Starter set:

- `fresh_spawn.json` — character just onboarded
- `mid_exploration.json` — 20 locations visited, some NPCs met
- `combat_imminent.json` — about to trigger combat
- `post_combat.json` — combat just resolved
- `deep_branch.json` — on a sub-branch with imported character
- `inventory_full.json` — inventory at capacity

### Fuzzed free-text set

A small canonical set of free-text inputs is injected into every node's action enumeration:

```
["I go north", "I examine", "I wait", "I attack", "I climb it",
 "I take it", "I speak", "I leave", "I sleep", "nonsense xjklqwer",
 "", "I dream of flying", "I try to do something weird"]
```

Plus per-location LLM-generated plausible inputs (cached from a prior run). Each goes through the real intent classifier (Haiku) with cached responses.

### Gating

PR fails if:
- Any `crash` issue.
- > 0.5% of reached states violate any invariant.
- Coverage (states visited / states in previous baseline) < 95%.

## Trinity #2 — VLM screenshot eval

### What it does

For a sampled subset of reachable states, render the app to a screenshot. Send to a cheap multimodal model with a structured rubric. Return JSON evaluation.

### Rendering

Playwright + headless Chromium launches the dev server. Navigate to URL encoding the seed state + action history. Screenshot at mobile viewport (375x812, the iPhone SE size as worst-case) and desktop (1440x900).

```ts
// packages/test/vlm.ts
for (const state of sampledStates) {
  const url = `http://localhost:3000/_test/render?state=${encodeURI(state)}`
  await page.goto(url)
  await page.waitForSelector("[data-ready]")
  const mobile = await page.screenshot({ clip: { x: 0, y: 0, width: 375, height: 812 } })
  const desktop = await page.setViewportSize({ width: 1440, height: 900 }).screenshot()
  const eval = await evalScreenshot([mobile, desktop], state)
  results.push(eval)
}
```

### Rubric

Structured JSON response from Haiku 4.5 with vision (cheap, ~$0.0005/check).

```ts
const RUBRIC = `You are evaluating a rendered screen from a text-adventure game.
Return strict JSON.

Check:
- ui_valid: is the UI rendered with no overlapping/clipped elements, legible text, valid buttons?
- text_coherent: is the displayed text coherent and complete (no "{{vars}}", no undefined, no lorem ipsum)?
- actions_visible: is at least one tappable action visible?
- art_status: is the scene art loaded, loading (placeholder visible), or failed?
- matches_description: does the visible art roughly match the text description (if art loaded)?
- tone_match: does the visual + prose tone match the world bible's declared tone?
- author_byline_visible: is an author pseudonym visible?
- any_visible_errors: are there any visible error messages or broken states?

Return:
{
  "ui_valid": true | false,
  "text_coherent": true | false,
  "actions_visible": true | false,
  "art_status": "loaded" | "loading" | "failed" | "none",
  "matches_description": true | false | null,
  "tone_match": true | false | null,
  "author_byline_visible": true | false,
  "any_visible_errors": true | false,
  "notes": "one sentence describing any issue"
}`
```

### Sampling

Sample ~1-2% of states visited by the crawler (up to 200 screenshots per PR). Skew sampling toward:
- Freshly generated content (new locations from the expansion loop).
- States with art newly generated.
- Edge cases: inventory full, combat active, chat full, etc.

### Cost

200 screenshots × 2 viewports × $0.0005 = $0.20 per PR. Trivial.

### Gating

PR fails if:
- > 2% of screenshots have `ui_valid: false`.
- Any screenshot has `any_visible_errors: true`.
- Any screenshot has `text_coherent: false` (a serious regression indicator).

## Trinity #3 — Replay corpus

### What it is

Accumulated recorded player sessions. Each session is a list of (user_input, timestamp, expected_resulting_state_hash, expected_rendered_output_hash). Sessions come from:

- **Synthetic corpus** — hand-crafted in test/corpus/synthetic/, used to codify expected behavior.
- **Family-internal production corpus** — recorded sessions from the family instance. Stays on-instance; no cross-family sharing. Anonymization was part of the earlier public-worlds story and is not a Wave 1 requirement — see `16_PRIVACY_AND_MINORS.md`.

### What it tests

On every PR, the replay runner:

1. Applies any outstanding migrations to old-schema snapshots.
2. Replays every session's actions against current code + AI cache.
3. Asserts final state hash matches expected OR migration-explained deviation.
4. Asserts rendered output hashes match at checkpointed moments.

```ts
// packages/test/replay.ts
for (const session of corpus) {
  const state = await applyMigrations(session.initial_state)
  for (const step of session.actions) {
    const result = await applyAction(state, step.action)
    state = result.new_state
    if (step.expected_output_hash) {
      if (hashOutput(result.output) !== step.expected_output_hash) {
        // Could be an intended change (new feature). Diff shown in PR.
        issues.push({ kind: "output_diff", step, actual: result.output })
      }
    }
  }
  if (hashState(state) !== session.expected_final_state_hash) {
    issues.push({ kind: "state_drift", session })
  }
}
```

### Handling intentional changes

Replay diffs are not automatically blocking. When a PR intentionally changes behavior (e.g., combat tuning), the PR author reviews diffs and either:

1. Marks each diff as "intentional" — updates corpus hashes in the same PR.
2. Fixes the code if the diff is unintentional.

A diff review UI shows before/after renders side by side for easy inspection.

### Gating

PR fails if:
- Any unresolved `state_drift` issue (corruption).
- More than 20 `output_diff` issues without being marked intentional (too many changes for one PR, needs splitting).

## Auto-rollback

### Pre-deploy (PR gate)

All three trinity checks plus unit tests plus typecheck must pass. CI runs on every push.

### Post-deploy (shadow + canary)

New version deploys to a **shadow environment** on merge. For 1 hour, a fraction of production traffic is **mirrored** (not redirected) — real requests hit both prod and shadow, shadow's responses are compared to prod's. Divergences are logged but don't affect users.

After shadow is clean (< 0.1% divergence rate), traffic cuts over fully. If any of the following happen post-cutover, auto-rollback fires:

- Crash rate > 0.5% of requests.
- New-error-class detection (Sentry or equivalent).
- Player-session abnormal termination rate > 1%.
- Explicit family-mod "something broke" button pressed 3+ times in 5 minutes.

Rollback mechanism: Convex supports version pinning; auto-rollback re-pins production deployment to the previous known-good version. All in-flight flows continue on the version they started on (durable runtime keeps old handlers loaded).

### The never-lose-state guarantee

Between durable runtime + version-pinned encounters + escape handlers + auto-rollback, the player-visible guarantee is:

- A running fight that started on v4.2 finishes on v4.2, even if v4.3 deployed mid-fight.
- A player who logs out for a month and comes back to a system that's now v6.0 has their old v4.2 encounter auto-resolved by the v4.2 escape handler (or, if v4.2 was GC'd, by a generic "scene ended quietly" handler).
- Durable character state is never lost. Transient scene state is always resolvable.

## Unit tests

In addition to the trinity, standard unit tests cover:

- Location schema validation (positive and negative cases).
- Inline script parser, validator, evaluator.
- Intent classifier prompt formatting.
- World bible consistency checker.
- Migration chain correctness (golden inputs).
- RNG determinism (seed → same output).
- AI cache key stability.

Run via `pnpm test`; Vitest.

## Property-based tests

For the inline script evaluator and effect application, fast-check generates thousands of random valid inputs per test run. Asserts: no exceptions, invariants hold, state mutations are schema-valid.

## Integration tests

E2E against a local Convex dev deployment + Playwright:

- Complete world bible build flow (mocked AI responses).
- New location expansion flow (from free-text to persisted entity).
- Multi-player presence (two browsers, state syncs).
- Offline → reconnect → queue drains.

## Manual QA

Closed beta is the family. Their play is the manual QA. Feedback captured as structured reports from an in-app "something felt off" button — logs current state + last 20 actions + a text note.

## Cost summary

Per PR, all testing:
- State-space crawler: ~$0 (cached)
- VLM screenshot eval: ~$0.20
- Replay corpus: ~$0 (cached)
- Unit + property + integration: $0
- **Total: ~$0.20 per PR.**

For a team running 50 PRs/week: $10/week in test costs. Worth it.
