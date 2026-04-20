# Weaver — Playtest Log

*Dated observations from family playtest sessions, per feature. The authority for flag transitions in `FEATURE_REGISTRY.md`: a feature moves `playtesting → shipped` after positive observations accumulate here; moves `playtesting → pulled` if friction recurs.*

## How to use this file

- Each session gets a dated heading.
- Group observations by feature being tested.
- Record who played, how long, what happened, verdict.
- Link related `UX_PROPOSALS.md` items when observations surface deferred decisions.
- If a session surfaces a hard-to-reproduce bug, cross-reference `LIMITATIONS_AND_GOTCHAS.md` or file a known-bugs entry.

## Template

```markdown
## YYYY-MM-DD — <feature_name> playtest session <N>

**Participants:** (user emails or pseudonyms)
**Duration:** (real-world minutes)
**World:** (world slug)
**Feature flag state:** (which flags were on for the session)

### Observations
- Bullet points of what happened, what worked, what surprised.

### Frictions
- Bullet points of what didn't work.

### Verdict
- Keep flag on / flip flag off / redesign / ship / pull.
- Next action (with owner).
```

---

*Sessions are appended below as playtesting occurs.*

---

## 2026-04-20 — Wave-2 game-systems ship + CLI-driven smoke test

**Participants:** claude-cli (solo, CLI-only; no browser)
**World:** claude-sandbox-d1w3kl (author-mode sandbox)
**Duration:** single-session build + validate
**Feature flag state:** text_prefetch, item_taxonomy, biome_rules, npc_memory, flows all **on** for sandbox, quiet-vale-f96pf4, the-office.

### Observations — the LitRPG-lite spine, tested via CLI

- **Inventory (item_taxonomy):** `give_item` → structured map
  `{yellow-orb: {qty:1, kind:"orb", color:"yellow", size:1}}`. Metadata
  snapshotted from the authored item entity at give time; condition
  evaluators can read `character.inventory.yellow-orb.size` without DB
  roundtrip. `crack_orb` chained on_crack + on_absorb through the router
  cleanly (narration said fired, `+3 energy`, `+1 skill_yellow` landed,
  orb removed from inventory).
- **Biome rules:** flow-plane with `time_dilation: 40` advanced clock
  from wed 09:05 → 09:45 in one turn (exact 40m). `on_enter_biome`
  fired the narrative say; `on_turn_in_biome` incremented
  `this.exposure` each turn; `ambient_effects` with `every_n_turns: 2`
  applied `-1 acid damage` on the nth turn (hp 12→11→10 across
  successive wade picks).
- **NPC memory + prompt injection:** seeded mara with
  `memory_initial.summary: "Came back to the Vale after a decade
  away..."`. A dialogue exchange via the flow runtime wrote memory
  rows for each turn, and Mara's reply to "Just watching. What are
  you building?" was *"A cradle." She doesn't look up from the joint
  she's fitting. "Someone in the village is expecting."* — the
  in-voice "cradle" echo came straight through the seeded memory +
  assembleNarrativePrompt pipeline.
- **Prefetch:** option `"Peek into the library"` with unresolved
  target `mysterious-library` → `ensurePrefetched` scheduled Opus;
  ~15s later the draft existed (art:ready); `pick` on that option
  was instant (no expansion chain, no visible latency).
- **Flows:** counter module ran 3 steps to terminal in isolation.
  Dialogue module invoked Sonnet via ctx.narrate() at each step,
  persisted state across invocations, flushed says to
  character.state.pending_says for render on next applyOption.
- **Content sync (two-way):** `weaver export` → 2-entity sandbox
  round-tripped to disk; `weaver export` → 43-entity The Office
  exported cleanly (bible + 7 biomes + 5 characters + 7 npcs + 23
  locations). `weaver validate` pass clean on Office; caught the
  `condition: "!this.coffee_made"` YAML edge case during a
  first-pass dump, fix landed in the YAML writer. `weaver sync
  <dir>` batch-pushed file edits; tested by editing starter prose
  via Python, syncing, `look`ing → v3→v4 update with the new prose.

### Frictions

- `pending_says` accumulated across three flow invocations dumped all
  at once on the next `pick`, creating a ~15-line wall of older
  dialogue output. Not wrong — authored-order intact — but noisy in
  solo CLI smoke. Acceptable in the UI where says are presented
  per-render; candidate for an opt-in "flush per-flow" refinement.
- `weaver art regen` expects location_slug (not entity_id); first
  attempt errored cleanly. CLI signature fixed same turn.
- Top-level `await dispatch()` in scripts/weaver.mjs created a TDZ
  bug for helper consts defined after the await (caught on first
  `weaver export`). Moved consts above the dispatch; working.

### Verdict

All five Wave-2 flags (`flag.biome_rules`, `flag.item_taxonomy`,
`flag.npc_memory`, `flag.flows`, `flag.text_prefetch`) moved
`designed → playtesting` and flipped **on** for the two human worlds.
Existing authored content (Quiet Vale, The Office) plays identically
with the flags on because effects silently no-op when the content
doesn't carry the new shape — no migration required to flip.

Next: content upgrade pass on Quiet Vale + The Office so the new
capabilities actually fire in human play (add `rules:` blocks to
biomes, `kind:` to items, `memory:` blocks to NPCs). Agents can do
this via the export/edit/sync loop ratified this session.

25/25 isolation-adversarial tests green against the new surfaces.

---

## 2026-04-20 — streaming / art-curation UI / admin surfaces / eras v2

Single agent session, pushed in five commits (`4e81239`, `2ed577f`,
`b67baf3`, `9836bca`, `02a6774` + their follow-ups). No family
playtest yet — technical shakedown only.

**Shipped:**
- Expansion streaming (flag.expansion_streaming) — Anthropic
  messages.stream → Convex row → convex-svelte subscription → UI
  shows prose accumulating, navigates on done.
- Tap-to-cycle art — "↻ roll again" button in variant byline of
  SceneArt; 44px touch target; reuses regenVariant; variants
  accumulate so flip-back via mode dots still works.
- Art admin (/admin/art/[world]) — owner-only reference-board
  manager with kind grouping, thumbnail display, remove-from-board,
  plus a flat picker to pin any ready rendering.
- Bible admin (/admin/bible/[world]) — owner-only AI-feedback
  editor. Text field → Opus suggests bible diff → per-field
  before/after UI → apply with optimistic concurrency check →
  new artifact_version tagged edit_kind=bible_feedback.
- Biome polish — spawn_tables fire atmospherically with noise-bucket
  + chance gate + seeded per-turn RNG. CLI `weaver biome list` shows
  per-biome (dilation, rules?, palette?, spawn_buckets, name).
- Admin index (/admin/[world]) — owner-only landing linking to
  bible/art/eras. Worlds list gets hover "admin" chip on owner rows.
- Eras v1 — active_era counter + chronicles table + advanceEra
  Opus action writing chronicle JSON with bible-voice pin.
  /admin/eras/[world] to advance + browse.
- Eras v2 catch-up — characters.personal_era; in-game
  "while you were gone…" panel on play page when the world has
  advanced past the character's personal_era; ack button.
  Era badge next to the world clock when pending.
- Reference-image pipe — runGenVariant walks priority
  (entity:<slug> → biome:<biome> → mode:<mode> → style), picks
  top-1 ready rendering, if found switches to
  fal-ai/flux-pro/kontext with image_url = R2 public URL of the
  ref blob. Schnell fallback when no refs. Prompt_used records the
  model + kind matched.

**Frictions / spec gaps surfaced:**
- Temperature parameter deprecated on some Opus 4.7 endpoints;
  dropped from advanceEra + suggestBibleEdit. Other expansion/
  dialogue calls unaffected.
- Convex internal.expansion.runPrefetch was declared `action` not
  `internalAction` — `internal.*` reference was type-invalid.
  Promoted to internal. Lesson: fire-and-forget scheduled functions
  should always be `internal*`.
- SvelteKit was picking up `apps/play/.env.local` that pointed
  PUBLIC_CONVEX_URL to a dead local deployment — created by stray
  `npx convex dev` in the app dir. Deleted. 35/35 Playwright
  recovered.

**Verdict:** all 8 Wave-2 flags on for sandbox + quiet-vale +
the-office. Next session expected to be creative-agent content
upgrade per `tasks/REIMAGINE_WORLDS.md`.

### Still-open spec gaps
- `noise_decay` on biome rules: authored but runtime doesn't
  decrement `this.<biome>.noise_level`. Minor.
- `spawn_tables` fires atmospheric says only; combat-spawn
  integration (spawn → combat flow start) is deferred.
- Eras v3 (per-era entity versions, era-gated visibility) deferred.
- flow_transitions diagnostic table spec'd but not written; not
  blocking.
- Single-ref flux-pro/kontext only; multi-ref (kontext-max/multi)
  deferred — pin more refs first.

---

## 2026-04-20 — Wave-2 content-upgrade pass (two parallel agents)

**Participants:** two content-upgrade agents (one per world), impersonating `river.lilith@gmail.com` via `--as` for owner-gated sync. No human players.
**Duration:** ~10 min wall, end-to-end.
**Worlds:**
  - `quiet-vale-f96pf4` (cozy family world)
  - `the-office` (43-entity Argus-extraction dungeon)
**Feature flag state:** all Wave-2 flags on for both.

### What landed

**Quiet Vale:** 1/1 authored biome (`village`) gained a conservative `rules:` block — `time_dilation: 1` + one ambient-say every 17 turns, tonal only. No NPCs or items exist; no other upgrades.

**The Office:**
- 7/7 biomes gained per-biome `rules:` tuned to tone: safe zones (`apartment-interior`, `coffee-shop`, `diner`) get flavor-only; outer office-dungeon gets `time_dilation: 160`, fatigue ambient every 10 turns + exposure counter; deep office-dungeon gets 240x dilation + denser ambient cadence; sky-spire gets 120x + slip damage every 8. Every ambient `every_n_turns >= 6` to avoid chip-damage nags.
- 7/7 NPCs gained `memory:` config (medium default, retention 40, track [dialogue_turn, the_player_visited]) + 3 seeds each, every seed grounded in the NPC's existing `description`/`knows`/`sample_lines` — no invented facts.
- 0 items upgraded — The Office doesn't yet have first-class item entities; items are implicit in location `canonical_features`. Extracting them into standalone items is out of scope for this pass.
- 0 characters touched — spec 24 `memory:` primarily models NPC-remembers-player; adding to a PC would pollute dialogue assembly.

### Spec/runtime gaps surfaced by the agents

1. **`ambient_effects[].chance` is documented in `spec/21_BIOME_RULES.md` but not honored by the runtime.** `convex/locations.ts` only uses the `every_n_turns` modulo match. Authors who write `chance: 0.3` get 1.0 in practice. Options: implement the chance gate, or remove from spec. UX_PROPOSALS candidate.
2. **`memory_initial[]` has no `event_type` field.** Seeds are summary-only, so `memory.track` / `memory.ignore` filters can't apply to seeds — they're always injected. Fine for Wave 2; add when playtest shows seeds are being over-prioritized.
3. **No "safe-zone" primitive.** Apartments, coffee-shops, diners are thematically sanctuaries; currently indistinguishable from any mundane biome with no rules. Candidate for `rules.sanctuary: true`.

### CLI UX gap (fixable)

Both agents hit the same sequencing bug: `--as river.lilith@gmail.com world use <slug>` doesn't persist `world_slug` for a subsequent `--as ... sync ...` call, because `--as` is ephemeral (new session per invocation). Agents both worked around by passing `--world <slug>` inline to `sync`. Fix: `sync` and `push` should always accept `--world` and prefer it over config when `--as` is present.

### Verdict

Content now materially uses the Wave-2 capabilities. Next session plays in these worlds will demonstrably diverge from pre-upgrade play:
- Entering the office-dungeon will tick clock ~3 hours per turn, hit fatigue damage every ~10 turns, accumulate `this.exposure` — the spec's headline "fluorescent corporate hellscape" now has teeth.
- Talking to Frank/Ganesh/Lily will seed prompts with 3 grounded memory seeds each — Mara-cradle echo test should repeat at NPC scale.

No commits to git — all changes are Convex artifact_versions. Quiet Vale's +1 version bump on its `village` biome is the only materially-different on-chain change; The Office took 42 no-op version bumps due to the sync path re-pushing every file (payload-byte-equality check not yet implemented). Cosmetic, not a bug.
