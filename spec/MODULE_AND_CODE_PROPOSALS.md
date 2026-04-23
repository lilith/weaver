# Module & code proposals

**Status:** designed 2026-04-22. Landed behind `flag.module_overrides` and `flag.code_proposals` (default off). Two related admin surfaces that let a world owner prompt changes to the game, staying inside the "trusted TS only" posture.

## Why two surfaces

User feedback during play splits cleanly into two shapes:

- *"enemies should hit harder at night"* → tune a parameter. No code change needed.
- *"combat should have a block option"* → new structural behavior. Needs a code change.

Conflating them forces every tuning pass through the repo's CI/deploy loop, which is slow and scary. Separating them lets tuning land in seconds (owner approves → runtime picks up the override on the next flow step) and keeps structural changes on the careful path (plan → GitHub issue → human + agent writes the code → CI → merge → deploy).

## Module overrides (runtime)

Modules declare their **override surface** as a schema of named slots. Slots are typed (`number`, `string`, `template`, `boolean`) with defaults and short descriptions. Step handlers read via `ctx.tune(key)` or `ctx.template(key, vars)`; the runtime merges per-world overrides on top of defaults at step dispatch time.

### Slot schema

```ts
type OverridableSlot =
  | { kind: "number"; default: number; min?: number; max?: number; description: string }
  | { kind: "string"; default: string; description: string; max_len?: number }
  | { kind: "template"; default: string; placeholders: string[]; description: string }
  | { kind: "boolean"; default: boolean; description: string };
```

A module adds `overridable: Record<string, OverridableSlot>` to its `ModuleDef`. Every tunable in step-handler code must correspond to a declared slot — calls to `ctx.tune("unknown")` throw at step-dispatch time so typos fail loudly.

### Template interpolation

`template` slots use a flat `{{placeholder}}` grammar — no conditionals, no expressions. Distinct from the `packages/engine/src/template/` grammar used in option labels/effects, which supports ternary and arithmetic. Keeping the module-prompt grammar dumb means Opus-proposed overrides can't accidentally break step logic via template mischief.

### Data shape

Two tables (convex/schema.ts):

**`module_overrides`** — the applied per-world state. One row per `(world_id, module_name)`.
- `overrides_json: Record<slot_key, slot_value>`
- `version: number` — monotonic, incremented every apply. Used for optimistic concurrency.
- `updated_by_user_id`, `updated_at`

**`module_proposals`** — the workflow trail. Never deleted.
- `feedback_text` — what the owner typed
- `current_overrides_snapshot` — state at suggest time (for rollback audit)
- `suggested_overrides` — Opus's output
- `rationale` — Opus's one-paragraph explanation
- `expected_version` — module_overrides.version at suggest time
- `status: "draft" | "applied" | "dismissed"`
- `applied_at`, `applied_version` when applied

### Flow

1. Owner opens `/admin/modules/<slug>`, types feedback in the module's textarea.
2. `suggestModuleEdit` action → Opus (Opus 4.7, tight system prompt) returns only the slot keys that should change, with reasons. Caps at 3000 output tokens.
3. UI shows a diff (before → after per changed slot) + rationale.
4. Owner clicks "apply". `applyModuleEdit` mutation version-checks, merges overrides, bumps `module_overrides.version`, marks proposal `applied`. Fails fast if another apply landed between suggest and apply.
5. Runtime: `startFlow` / `stepFlow` queries `module_overrides` once per step dispatch. Zero additional round-trips on the hot path; resolution is O(1) by `(world_id, module_name)` index.

### Owner gate + isolation

- Owner-only (matches bible-editor). Family mods and players cannot suggest/apply.
- All mutations/queries resolve `world_slug` → world, then check `world.owner_user_id === user_id`.
- Every mutation has a matching adversarial-isolation Playwright test (URGENT rule 7).

### Flag

`flag.module_overrides` — default off. When off, the runtime skips the override lookup entirely (slot defaults win). When on, the lookup runs. Admin UI refuses suggest/apply when the flag is off for the world.

## Code proposals (repo)

For structural changes that need new code paths. Keeps the "trusted TS only" posture — nothing executes at runtime; every change goes through a human + agent path.

### Shape

**`code_proposals`** table:
- `world_id` — proposals are scoped to a world (the owner writes feedback about "their" combat module, even though the code is shared)
- `feedback_text` — the owner's request
- `plan_json` — Opus's structured implementation plan (title, summary, rationale, suggested_changes[], new_tests[], open_questions[], estimated_size)
- `status: "draft" | "opened" | "closed" | "dismissed"`
- `github_issue_number`, `github_issue_url` when opened
- `author_user_id`, `created_at`, `updated_at`

### Flow

1. Owner opens `/admin/code/<slug>`, types feedback.
2. `suggestCodeChange` action → Opus drafts a structured plan (no code diffs — a *plan*).
3. UI shows the plan in a readable form (title / summary / rationale / per-file what's changing / new tests / open questions).
4. Owner clicks "open github issue". `openCodeIssue` action calls GitHub REST (`POST /repos/<owner>/<repo>/issues`), assigns to `lilith`, stores issue number + URL on the proposal, status → `opened`.
5. The actual code change happens off-system — Lilith runs Claude Code locally against the issue, or a scheduled agent consumes the issue. Merging the eventual PR triggers Pages auto-deploy.

### Why issue, not PR

v1 stops at the issue for three reasons:

1. **No code-gen in Convex.** Runtime code execution would break the trusted-TS posture.
2. **Human judgment stays central.** A plan is a brief; the code review happens against actual diffs on GitHub, not against JSON.
3. **Simpler surface to build.** GitHub Issues API needs only a PAT with `issues: write`. PR creation needs branch management, tree APIs, review flows.

v2 could add an optional "also draft a PR via a scheduled agent" button; not in scope for this pass.

### Env vars

- `GITHUB_REPO` — `"lilith/weaver"` (configurable in case of rename)
- `GITHUB_REPO_PAT` — fine-grained PAT scoped to the repo with `issues: write`. Stored in Convex env (`npx convex env set`).

### Flag

`flag.code_proposals` — default off. Admin UI and actions both refuse when off. When env vars are missing, `openCodeIssue` throws with a clear error (the owner shouldn't see "github api 401" — they should see "code proposals aren't configured").

### Isolation

Same owner-only gate as module overrides. Non-owners cannot suggest, open issues, or dismiss. Adversarial tests enforce this.

## Testing (local, before deploy)

This project runs a single Convex deployment (`friendly-chameleon-175`) — no staging tier. To verify changes before pushing to main:

### 1. Unit tests — pure logic (fastest, no Convex)

`packages/engine/src/modules/` gets a `overrides.test.ts` covering:
- Template interpolation (happy path, missing placeholders, extra placeholders)
- Slot validation (type check, min/max, max_len)
- Merge logic (override wins over default; unknown keys rejected)

Run via `pnpm -C packages/engine test` (vitest, already installed transitively via apps/play).

### 2. Unit tests — Convex logic with `convex-test`

`convex-test` runs Convex functions against an in-memory DB. Covers:
- Version check fails when expected_version is stale
- Owner gate rejects non-owner session tokens
- `activeOverridesFor` returns `{}` when no overrides row exists
- Apply increments version and writes the expected overrides_json

Install: `pnpm -w add -D convex-test` (at the repo root). Run via `pnpm test` (new script at root).

### 3. Playwright adversarial isolation tests

Extend `apps/play/tests/isolation.spec.ts` with: user B cannot suggest/apply/dismiss/list proposals against user A's world. Runs against the live dev deployment — same shape as every other isolation test in the suite.

### 4. Pre-push gate

Before `pnpm run push-convex` + `git push`:

1. `pnpm -w run test` (unit tests)
2. `pnpm -C apps/play check` (svelte-check)
3. `node scripts/weaver.mjs gameplay-sweep` (cheap CLI gameplay integration)
4. `pnpm -C apps/play exec wrangler pages build .svelte-kit/cloudflare` (Pages-runtime build check; gotcha #15)

Only after all four pass: `pnpm run push-convex` then `git push`.

This sequence catches 90% of breakage without needing a separate staging Convex. The Playwright suite (against live deployment) is the last gate — run it if you're nervous about a specific change.
