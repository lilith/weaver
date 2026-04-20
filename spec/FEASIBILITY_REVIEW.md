# Weaver — Spec Feasibility Review

*Flags for the implementing agent. Not edits to the spec — read this alongside, push back on the specific claim if it doesn't hold on contact with reality.*

**Update 2026-04-19 (spec-review session):** sections §4 (QuickJS cold-start), §6 (95/4/1 path split), and §13 (inline-script authoring UX) are **resolved** — no runtime isolate in Wave 1-3 (§4 moot), execution paths collapsed to two (§6 resolved), inline-script path deprecated (§13 resolved). See `17_DECISION_LOG.md` for details.

**Update 2026-04-20 (design-direction session):** section §3 (80KB bundle) **resolved (missed)** — actual build is 139KB server + 30KB client; target relaxed to 120-160KB. See §3 body. Several new claims queued for playtest measurement:

- **Predictive prefetch hit rate** — spec claims prefetch saves 5-8s on the hot-case click; depends on players actually picking the prefetched options. Target: measure hit-rate during playtest; if <50% hit, revisit prefetch scope.
- **Era-transition stage-shift cost** — spec claims ~$1-2 per transition. Measure during first real era advance on The Office.
- **Art-curation weekly cost** — spec claims $0.50-1.50/week with text-only default. Measure during family's first month of playtest.
- **Biome-palette auto-gen accuracy** — spec claims Opus produces palette hex that fits the biome. Measure palette-acceptance rate after import; if authors keep overriding, re-examine the prompt.

The specs in this directory are opinionated and confident. Some of that confidence is load-bearing (blob architecture, entity/component model, three execution paths); some is load-bearing-but-unverified (cold-start budgets, cost estimates, bundle sizes, cache hit rates). This document is the unverified list.

When you implement something listed here, measure first, implement second, and surface the finding to Lilith if reality diverges from the spec.

## High-confidence-low-evidence claims

### 1. `$0.20 per PR` for the full testing trinity

**Claim** (`06_TESTING.md` §"Cost summary"): 200 VLM screenshots × 2 viewports × $0.0005 = $0.20. Crawler + replay are $0 because "all-deterministic with AI cache."

**Why shaky:**
- "AI cache covers every reachable AI response" only holds if the cache has full prior coverage. On a fresh PR that introduces a new bible field, every cached prompt key is invalidated — cold cache across the whole seed space.
- $0.0005 per VLM check is Haiku vision's bottom rate today; image size or prompt length can push it up.
- Crawler cost can spike if fuzzed free-text inputs generate novel combinations not in cache.

**What to check first:** Run the trinity once on a seed state with a cold cache. Log actual cost. If it's > $2 on cold, assume the per-PR budget is an order of magnitude higher when prompts change.

**Fallback if the claim fails:** Cap trinity runs to changed-file-adjacent seeds on PR; run the full trinity nightly.

### 2. `2–4s text, 4–7s art` for free-text expansion

**Claim** (`04_EXPANSION_LOOP.md` §"The pipeline"): Opus 4.7 generates a valid location in 2-4s, fal.ai FLUX.2 [pro] generates art in 4-7s.

**Why shaky:**
- Opus 4.7 time-to-first-token with 8K+ context (cached bible + context) can exceed 3s by itself. Full JSON generation with validation retries can stretch further.
- fal.ai wall-clock varies with queue depth at request time.
- The spec asserts "player moves on before art is ready; next visit shows art." If a family of 5 sits on one screen watching Jason's first visit, that's a different UX — the 7-second art wait becomes visible.

**What to check first:** Measure p50 and p95 for both calls under realistic conditions (cached bible, typical context size). Measure specifically for the "one-screen-watching" case — is the art load visible in a way that hurts the "magical" feel?

**Fallback:** Seed more aggressive biome-fallback art; regenerate in place over the fallback with a crossfade so the "forming" moment is less jarring.

### 3. `~80KB initial bundle` target on mobile — **RESOLVED (missed)**

**Measured 2026-04-20** (`spec/LIMITATIONS_AND_GOTCHAS.md` §"Worth measuring but not yet"): current production build emits **139KB server + ~30KB client-gzipped**. The 80KB target was aspirational; reality is ~2x higher once Convex client + reactive subscriptions + Tailwind + auth + PWA shell land.

**Resolution:** target updated to **120-160KB initial client bundle**, honestly. Documented in `spec/00_OVERVIEW.md` principle #5 as the realistic ceiling. If a feature threatens to push past 160KB, it's a review signal to consider lazy-chunking before merge.

**Follow-up:** a real code-split audit hasn't happened yet. A 30-minute audit pass (`vite build --reporter verbose`, identify chunks-over-10KB, consider dynamic imports for rare surfaces) should land before Wave 2 ships. Tracked in FEATURE_REGISTRY under a future implementation task.

### 4. QuickJS WASM isolate cold-start

**Claim** (`01_ARCHITECTURE.md` §"Capability sandbox"): Modules run inside QuickJS WASM isolate with 50ms wall-clock, 10MB memory. This is asserted, not measured.

**Why shaky:** QuickJS cold-start inside a Convex action (where the action itself has boot cost) may be 200ms or more. 50ms is plausible for a warm isolate; it's aggressive for cold.

**What to check first:** Before any user-authored module work lands, prototype a QuickJS WASM isolate in a Convex action and measure cold-start on a typical Wave 2 module body. If cold-start is >100ms consistently, the mobile UX contract for module-backed locations (should feel as snappy as JSON locations) is broken.

**Fallback options:**
- Defer user-authored modules to Wave 3; Wave 1-2 modules stay trusted V8.
- Pre-warm isolates via Convex Component partitioning.
- Batch multiple module invocations into one isolate instance per request.

This is a Wave 2 concern but it shapes Wave 1 decisions (module interface design), so surface early.

### 5. Auto-rollback via Convex version pinning

**Claim** (`06_TESTING.md` §"Auto-rollback"): On threshold breach, auto-rollback re-pins production deployment to the previous known-good version. In-flight flows continue on the version they started on.

**Why shaky:** Convex supports deploy history and rollback, but the spec describes a specific mechanism (per-version handler preservation during rollback with in-flight flow continuity) that needs verification. The durable-runtime story depends on it.

**What to check first:** Before D1 (Wave 1 deploy pipeline task), spike a simple Convex redeploy + rollback and verify:
1. Does a rollback preserve in-flight action state?
2. Can two versions of the same action handler coexist during a rollover window?
3. What happens to a running `ctx.scheduler`-enqueued job across a version change?

**Fallback if Convex doesn't support the described pattern:** Version flows explicitly in the schema (`flow.module_version`) and refuse to resume flows whose version handler is missing, triggering the escape handler path. That's the spec's described fallback anyway — confirm it's implementable without relying on Convex's deploy mechanics.

## Ratio / scale claims

### 6. `95% JSON / 4% inline / 1% module` execution-path split

**Claim** (`00_OVERVIEW.md`, `01_ARCHITECTURE.md`): 95% of content fits pure JSON, 4% needs inline scripts, 1% needs full modules.

**Why shaky:** This is a guess. A family that wants little random encounters everywhere ("a squirrel scurries by, 30% chance") could push inline-script share to 20-30%. If inline ends up being the majority, the "tiny interpreter" layer needs more robust tooling (debugger, profiler, error UX) than the spec budgets for.

**What to check first:** After the world bible builder ships and the first 50 locations exist, count the distribution. If inline is >15%, the path-2 surface needs upgrading before Wave 2.

**Counter-design:** Two paths (JSON + module) might cover the same ground with less engine surface. Inline scripts exist because modules are "heavy"; if a lightweight module invocation (no event log, no replay, no capability sandbox) is cheap enough, inline could collapse into it. Consider before over-investing in Path 2.

### 7. World bible prompt-caching economics

**Claim** (`04_EXPANSION_LOOP.md` §"World bible prompt caching"): Aggressive cache hit rates make bible context effectively free after the first call.

**What's actually true** (verified this session against Anthropic's current docs):
- 4.x-family models: cache reads don't count toward ITPM.
- Cache reads: 0.10x input price.
- Cache writes: 1.25x on 5-minute-TTL (the spec's assumption).
- Minimum prefix for cache: 4096 tokens on Opus 4.7. Bible at 5-15K tokens easily clears.
- **Caches are workspace-isolated as of 2026-02-05.** Not a problem with single-workspace setup (the current shape). Becomes a problem if per-family deployment later splits into per-family workspaces.

**What to check first:** Watch the cache hit rate during the first week of family play. If it's below 70%, something is invalidating keys more than expected (bible edits? system prompt drift? stamping?). Log cache metrics from day one in `packages/engine/ai/cache.ts`.

### 8. `$150-200` total Wave 1 development cost

**Claim** (`08_WAVE_1_DISPATCH.md` §"Budget expectations"): Dispatch + review $50-100 + trinity $40 + art $30 + bible builds $20 = $150-200 total.

**Why shaky:** 6-10 parallel agents is assumed. If any agent loops on a failing build, or if the trinity's $0.20/PR estimate is wrong (see §1), this budget slips. Real agent-fleet cost is the biggest unknown in the project.

**What to check first:** Set a hard $50 budget for Phase A. Measure burn at end of Phase A; extrapolate. If Phase A costs $150, Wave 1 will cost $500+. Flag to Lilith immediately.

**Instrumentation required:** `cost_ledger` must tag every call with the dispatching agent id so per-agent cost is visible. If that's not done from Day 1, the budget overrun is invisible until it's too late.

### 9. Wave 1 ships in 3-4 weeks with 6-10 agent parallelism

**Claim** (`08_WAVE_1_DISPATCH.md`): Full Wave 1 scope in 3-4 weeks.

**Why shaky:** Locked scope lists 15+ major features. Phase A alone (foundations) is ~4-5 task-days with Lilith on the schema + trinity scaffolding. Phase B's six parallel tasks assume agents don't block each other on schema questions. Integration agent overhead is non-trivial.

**What to check first:** End of week 1, count merged PRs vs. Phase A plan. If Phase A isn't fully merged by day 7, Wave 1 is not 4 weeks; replan.

## Under-designed claims

### 10. The combat "clean module boundary" promise

**Claim** (`08_WAVE_1_DISPATCH.md` C1): Wave 1 hardcodes combat but with a "clean module-boundary interface (list in code comments) so Wave 2 refactor into module is trivial."

**Why shaky:** The interface isn't concretely specified. "Code comments" is a placeholder. Under pressure (and Wave 1 is under pressure), combat state will couple to character state directly, and the Wave 2 extraction will be painful.

**What to check first:** Before combat implementation starts (C1), write the module interface the Wave 2 refactor needs. Make combat implement that interface literally — the interface lives in `packages/engine/modules/combat.interface.ts` (even if there's only one implementation in Wave 1). Any coupling that bypasses the interface is a bug.

**Related gap:** No spec describes the general module manifest format / declared capabilities / event subscriptions. Wave 2 needs this before combat extraction. Flag now.

### 11. Attribution + moderation UX

**Claim** (`00_OVERVIEW.md` §7, `04_EXPANSION_LOOP.md` §"Attribution propagation"): Every artifact carries author pseudonym.

**Not specified:** What happens when a minor picks an off-color pseudonym? Moderation UX is gestured at in `16_PRIVACY_AND_MINORS.md` but the family-instance collapse simplified that away. For Wave 1 family-instance scope, this is Lilith's judgment call, not a system feature — but call it out so it's not surprising.

**What to do:** Add a single allowed-character constraint on pseudonyms (`[a-zA-Z0-9 ._-]+`, 2-32 chars) in the schema. The rest is human moderation in the family instance.

### 12. PWA + offline via Convex built-in queue

**Claim** (`01_ARCHITECTURE.md` §"PWA + offline"): Convex's built-in offline queue handles mutations when offline; reactive queries degrade gracefully.

**Why shaky:** Convex's offline behavior is real but not thoroughly documented for SvelteKit + adapter-cloudflare. Reactive-query degradation on poor networks (not offline, just bad) is untested here.

**What to check first:** Test on actual 4G conditions (throttled DevTools is not sufficient — use an actual phone on actual mobile network). If reactive queries hang or loop on flaky networks, the PWA story needs active fallback paths, not reliance on the default.

**Also:** `vite-plugin-pwa` peer range doesn't yet declare Vite 8 support. Installed with a warning per handoff. Re-enable when the plugin catches up; Wave 0 Day 10 polish anyway.

### 13. Inline-script authoring UX

**Claim** (`03_INLINE_SCRIPT.md` + `07_WAVE_0_SPIKE.md`): Inline scripts are a first-class authoring surface with a browser designer.

**Gap** (from `CONTEXT-HANDOFF.md`): "A text editor with Weaver grammar is not a 7-year-old UX." The spec waves at "AI-suggest" but doesn't describe how a kid authors a script that runs.

**For Wave 1:** Inline-script authoring is adult-only. Say so in the spec (or in the code). Kids edit via prompt; they don't see the script source. If the AI-suggest path is supposed to make scripts kid-friendly, that's a research problem — not a 3-4-week-ship problem.

## Small-but-real gaps

### 14. Bible edit retro-apply cost estimate

`11_PROMPT_EDITING.md` §"World bible edit" mentions a retro-apply action to regenerate art for existing locations. The cost confirmation ("this will cost ~$X to regenerate Y locations, proceed?") is asserted but the estimator isn't specified. Probably trivial (`count(locations) * $0.03`), but should be concrete.

### 15. Cost ledger during onboarding

`CONTEXT-HANDOFF.md` flagged this: a family could accidentally burn $5 in the bible builder if candidate regenerations stack. The cost ledger needs to track cost *before the world exists* (attributed to the inviting user's pending world draft, or to the inviter directly).

### 16. Single-device vs multi-device family UX

`05_WORLD_BIBLE_BUILDER.md` says "one device passed around"; `01_ARCHITECTURE.md` §"Multi-player presence" says separate devices. The handoff between modes isn't designed. Wave 1 lands both in separate features that don't know about each other — probably fine for MVP, but call out for Wave 2.

### 17. Migration path for component payload shapes

`09_TECH_STACK.md` §schema shows `payload: v.any()` — migrations for component payload changes are all in application code. The handoff flagged this: "fine *if* the test/replay corpus is good enough." The trinity's replay corpus has to carry enough coverage that a schema-shape change's migration is verified before ship. No explicit policy for how much coverage is "enough."

**Suggested rule:** Every component type ships with at least 3 fixture payloads in the test corpus. A PR that changes the Zod schema for a component_type must update all three. Enforce via a test that parses every fixture against the current schema.

## Implementation checklist for the agent

Before declaring any feature "done," confirm:

- [ ] The cost claim in the relevant spec was measured, not extrapolated.
- [ ] The latency claim was measured on realistic hardware (phone over 4G), not desktop localhost.
- [ ] The cache hit rate assumption was logged and is within the claimed range.
- [ ] No §"Capability sandbox" / §"Durable runtime" claim was taken on faith — each was prototyped before the dependent feature was written.
- [ ] Bundle size is measured on every merge; CI fails the merge if it crosses the declared ceiling.
- [ ] Every agent's cost is tagged in `cost_ledger`; total Wave 1 burn is visible in a single query.

Flag anything that fails to Lilith immediately; do not paper over it.
