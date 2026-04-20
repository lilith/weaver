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

## 2026-04-20 — creative reimagine (Quiet Vale)

**Worked on:** quiet-vale-f96pf4
**Duration:** ~75 minutes (author + CLI playtest)
**Mechanics wired:** items (taxonomy, full kind coverage), silly-combat, farming, fishing, book-reading, dialogue (flow start manual), biome rules (forest + inn), NPC memory (Halvard), era advance.

### Changes (terse, per entity)
- **biomes/forest.md** (new): time_dilation 1, ambient says every 5/7/9 turns (seeded chance), spawn_tables covering confused-hedgehog (low), pass-aggro squirrel / jam magpie (mid), offended-goose / disapproving-sheep (high); spawn_chance_per_turn 0.08.
- **biomes/inn.md** (new): cozy hearth ambients every 6/9/11 turns (fire pops, innkeeper wipes glass, unseen cat).
- **biomes/village.md**: expanded ambients (chickens, chapel bell, smoke drift, dignified hedgehog), modest spawn_tables (geese + magpies only at high_noise).
- **npcs/halvard.md** (new): terse weather-forward NPC with 4 grounded memory seeds (chickens, Mara-respect, bench habit, wishing-coin ambivalence), sample_lines, knows, lives_at=village-square.
- **npcs/{offended-goose, passive-aggressive-squirrel, confused-hedgehog, disapproving-sheep, jam-thieving-magpie}.md** (new): silly-combat roster with `combat_profile:` block (hp 2-6, attack 1-2, escape_dc 6-9). Voice entirely onomatopoeic ("HONK.", "*chitters, with emphasis*", "Baa.").
- **items/** (19 new): herbal-tea (consumable +3hp), bruised-apple (+1hp), turnip (+2hp), trout (+3hp); wishing-coin (orb yellow size-1, on_absorb +2 energy, on_crack narrate); mara-sketchbook (key, sentimental), smooth-stone (material); fishing-rod / wet-baguette / aggressive-spatula / assertive-umbrella (gear primary_weapon); bean-seed (consumable 3-charge); old-boot / mossy-rock (pond-gift); letter-in-a-bottle (quest, on_examine narrate); almanac-of-small-weather, wingwrights-ledger, halvards-pie-recipe, childs-book-of-clouds (readable "books" via consumable 99-charge non-consuming on_use narrate).
- **locations/village-square.md**: pickup wishing-coin (conditional), crack-orb-in-well, sit-with-Halvard flow, goose encounter toggle (whistle-to-summon + square-up/back-away branches with combat flow_start).
- **locations/mara-cottage.md**: accept tea, ask for seeds (first visit), receive sketchbook (after 2 visits), sit-and-talk dialogue flow.
- **locations/the-vale-inn.md**: join-Halvard-by-fire dialogue, pick up bruised apple (conditional), order warm food (+2hp), link to vale-library.
- **locations/mountain-path.md**: pick up smooth-stone, pinecone-ambush squirrel encounter with combat flow_start, "apologize to the tree" de-escalation, "take in the view" (+1 energy).
- **locations/northern-paths.md**: sheep judgmental-encounter with combat flow_start + "concede the sheep's point" de-escalation.
- **locations/vale-garden.md** (new): full plant→water×3→harvest loop on `this.growth` 1-4, turn-soil reset. Used bean-seed consumable for plant gate.
- **locations/pine-hollow-pond.md** (new): pick up fishing-rod, 4-stage cast sequence (boot → trout → letter → mossy-rock) gated on prior catches.
- **locations/vale-library.md** (new): 4 books pickup-able; each book has a `Read` option that fires use_item → on_use narrate (Sonnet writes a cozy entry per book's premise). Non-consuming (99 charges).
- **Era advance:** v1 → v2 via `weaver era advance "early spring gave way to high sun, and the Vale's chickens began a quiet rebellion"`. Chronicle titled "The Long Noon of the Vale" auto-generated by Opus from the bible; playing Riris will see the catch-up panel next session.

### CLI-playtested paths (all passed)
- Village square: pickup wishing-coin → crack orb (fires on_crack narrate + on_absorb energy +2). Energy went 5 → 7. Whistle-to-summon goose → goose visible (template conditional renders). Manually triggered combat flow with goose stats — 4 rounds, victory, HP 10 → 8, damage fires through router.
- Mara's cottage: accept tea (inventory has herbal-tea stackable consumable), ask for seeds (bean-seed 3-charge).
- Vale garden: plant bean (use_item consumed 1 of 3 charges, growth=1), water ×3 (growth 1→4), harvest (+2 turnips, growth→0, harvested=true), turn soil (loop ready again).
- Pine-hollow pond: rod → 4 different catches in sequence.
- Vale library: 4 books pick up, read → Sonnet writes cozy one-sentence entries in character with the book's premise. Almanac entry ("light frost on the eastern-facing rooftops only, gone by the time the kettle boils") was perfect.
- Halvard dialogue (manual flow start — see Gap #1): greeting "Morning. Frost's off the stones, at least.", answered "How are the chickens today, Halvard?" → "Restless. East wind's got 'em spooked — happens every spring, first warm week." Completely in character. Walk-away closed cleanly.
- Era advance: Opus produced "The Long Noon of the Vale" chronicle tied to the hint.

### Verdict

The Vale now has **systems, not just descriptions**. A 15-minute family session has: mechanical pickups (coin, rod, sketchbook, tea, seeds, apple, books), farming loop, fishing loop, reading loop, 5 silly-combat encounters, Halvard as a remembered NPC, and the Vale's first era beat in the books. Combat ~never dramatic — 2-6 HP enemies vs 8 hp player, comedic enemy naming throughout. The 7yo can crack wishing-coins and plant beans on page 1 without running into combat; the older players can seek out the geese.

Cozy tone preserved (ran the voice samples against bible.md's tone.avoid; no grimdark/cynical leakage). No new NPCs outside the brief's Mara + Halvard roster (the silly-combat enemies are monstrous-cozy, not named-characters). No prose from `backstory/` reproduced.

### Gaps / feedback to the technical agent

1. **`flow_start` effect in location `options[].effect` is not dispatched.** `convex/locations.ts:572` has a TODO comment to this effect. All my combat and dialogue options are authored with `flow_start` effects per the spec and the CLAUDE.md / REIMAGINE_WORLDS.md docs. They sync + validate cleanly but silently no-op when picked. **Worked around** by also documenting manual `weaver flow start combat --state ...` as the CLI-playtest path, but the UX the family gets in the browser will be *options that show up, do nothing*. This is the highest-impact gap surfaced — without it none of the combat/dialogue encounters are reachable from normal play.

2. **Template `#if` only accepts a path, not an expression.** `(this.growth >= 4)` cannot be used inside `{{#if ...}}`. I stripped compound-conditional prose. Low priority, but docs that suggest `{{#if x && y}}` patterns would mislead authors.

3. **`>=` / `<=` / `<` / `>` comparisons against `undefined` fall through to string lex comparison.** `clock/index.ts:386-410` — when `a` is undefined, `typeof a === "number"` is false, so the number branch is skipped and `String(undefined)` ("undefined") is compared lexicographically. This makes `this.never_set >= 4` evaluate true (because `"u" > "4"` in ASCII). I caught this playtesting the garden: "Harvest the ready patch" showed up before anything was planted. **Fix suggestion:** in `compare()`, coerce `Number(a)` / `Number(b)` and if either is NaN, return false for ordering ops. Additionally, a typeof-string-or-typeof-number pair detection before falling through. **Work-around in my content:** explicit truthy-guard `"this.growth && this.growth >= 4"`. Authors should be told this pattern, ideally in `22_ITEM_TAXONOMY.md` or `02_LOCATION_SCHEMA.md`.

4. **No `ctx.runAction` flush of pending narrate inside `look`.** The Sonnet narration from a prior `use_item`/`crack_orb` only appears on the *next* `pick`, as a leading "ghost" line from the previous turn. For the browser this is probably fine (reactive), but on mobile where a player picks, sees their own line, then the NPC line arrives ~1s later as a pop-in — it's a little jarring. Low priority; expansion-streaming would probably smooth it.

5. **`narrate` effect inside `on_use` of a `consumable` with `charges > 1` and `consumes_self: false` works, but charges decrement fires on every use.** Books are authored with `charges: 99, consumes_self: false` as a "infinite reads" hack. After 99 reads the book would silently stop working. Consider a `consumable: { infinite: true }` or `reads: { on_use }` kind. Not blocking; family won't read any book 99 times.

6. **CLI `memory show <slug>`** referenced in REIMAGINE_WORLDS.md §Workflow step 6 doesn't exist. `weaver help` shows no memory command. Surface Halvard's accumulated memory rows (for debugging / NPC coherence checks) would be nice.

7. **`weaver --as ... go <slug>`** fails with "observer mode: go is author-only" even when `--as` is the world owner. `go` / `pick` / `state` / `flow start` all gate on `cfg.mode === "author"` without a `--as` fallback. Same as PLAYTEST_LOG's prior entry noted about `sync`. Work-around: `world use <slug>` once after `--as` to persist author mode in config (but then the parallel agent's `--as` calls clobber the saved config). Non-blocking, but flaky in a two-agent session.

8. **Give_item slug cannot be a template expression** like `slug: "{{pick('trout', 'old-boot')}}"`. I fell back to a 4-stage progression (first cast → boot, second → trout, third → letter, fourth → rock) to simulate variety. A `give_random_item` effect, or allowing `slug: { pick: [...] }`, would let the fishing pond truly roll.

### Content notes for Lilith to review

- Halvard's voice (terse, weather-forward) is a mild departure from Mara's voice (terse, dry) — they'd feel distinct even to the 7yo. Sample reply "Restless. East wind's got 'em spooked" showed up in playtest unprompted.
- The "wishing-coin in the well" is a soft call-out to the existing world-title thematics. It's recoverable only once (conditional on `!this.coin_picked_up`); if the family wants more, we can expose more coins via other locations.
- Silly enemies are spawn-table slugs (forest / village), and the combat flow expects `enemy_slug`/`enemy_name`/`enemy_hp`/`enemy_max_hp`/`enemy_attack`/`escape_dc`/`player_weapon_attack` in `initial_state`. I hardcoded these in each combat option's `flow_start.initial_state` since the NPC's `combat_profile` block isn't yet consulted by the combat module. Consider a `spawn_combat` effect that resolves by NPC slug.
- No art generated yet. Each new location + NPC + item has a `portrait_prompt` / `establishing_shot_prompt`; art will queue on next art-gen pass. Worth curating reference-board after the family picks 2-3 favorites.

Flags observed: `flag.biome_rules`, `flag.item_taxonomy`, `flag.flows`, `flag.npc_memory`, `flag.eras`, `flag.world_clock` all appear on for quiet-vale based on playtest behavior (effects fired, flows ran, chronicles generated).

---

## 2026-04-20 — creative reimagine (The Office)

**Worked on:** the-office
**Duration:** ~80 minutes (author + CLI playtest)
**Mechanics wired:** items (first-class — 22 items: 6 orbs, 4 gear, 4 consumables, 1 key, 4 quest, 1 material, 1 magic appliance), combat via `flow_start` (potted-plant, tumblefeed-nest, Tattoo's crew, stapler-scout-pack, camraconda, porcelain-silverfish-swarm, Terrorbyte), dialogue via `flow_start` (Ganesh, Lily, Frank, Theo, Tattoo, Ichabod's bartender, Hammer Time proprietor), biome spawn_tables (outer/deep/sky-spire tiers), NPC memory seeds (Theo/Frank/Ganesh extended with grounded facts), eras (3 advances), prefetch stubs (records-sub-basement, the-sixth-floor, unmapped-grove-corridor, sixth-floor-service-access, diner-back-door, ichabods-back-room, terrorbyte-access-panel, third-bedroom, hallway-one-north-sprint).

### Changes (terse, per entity)

- `items/*.md`: **22 new item entities** (v1): yellow-orb, orange-orb, green-orb, blue-orb, red-orb, purple-orb (orbs); crowbar, sledgehammer, potato-gun, boar-spear, glass-spike, infrared-sunglasses (gear); magic-espresso-maker (quest appliance), pancakes-load-bearing, strawberry-cream-cake, blast-roast, gummy-shrocks (consumables); frank-lobby-pass (key); sarahs-paper-map, jeromes-yellow-orb, paper-employee-pen (quest); bathroom-mirror-shard (material). Each has portrait_prompt, per-kind block, and grounded on_crack / on_use / on_examine narrate+inc effects.
- `biomes/office-dungeon-outer.md`: added spawn_tables (low=none/rogue-stapler, mid=tumblefeed/stapler-crab-pair, high=tumblefeed-large/stapler-crab-swarm/hostile-potted-plant), spawn_chance_per_turn=0.18.
- `biomes/office-dungeon-deep.md`: spawn_tables (low=none/shellaxy-sleeping, mid=shellaxy/copier-tentacle/monitor-lizard-pack, high=camraconda-distant/ink-leak/folded-space-shift), spawn_chance_per_turn=0.22.
- `biomes/dungeon-sky-spire.md`: spawn_tables (silverfish variants + paper-flock + water-serpent + slip-tile + water-column-collapse), spawn_chance_per_turn=0.30.
- `locations/fort-door.md`: **gear-hub redesign** — talk-to-Ganesh dialogue, Rufus greeting + cache trade (gives 2 yellows), magic coffee brew (+2 energy), weapon rack (crowbar on stock, sledge/potato-gun/boar-spear each pullable separately), DO-NOT-TOUCH drawer (IR glasses + paper-employee pen pickups), crack-yellow/crack-green orb options, unresolved-target `records-sub-basement` for prefetch. 19 options.
- `locations/hallway-one.md`: **Tattoo's toll mechanic** — tattoo_seen flag, pay-4-yellows option (take_item qty=4), refuse-toll triggers combat flow (Tattoo's six-stapler crew, hp=9), talk-to-Tattoo dialogue flow. Plus crack-yellow, gulp-BLAST-ROAST options. Scout encounter rand-gated. Unresolved `hallway-one-north-sprint` (already authored as draft).
- `locations/break-room.md`: yellow-orb drop after plant fight, 2 blast-roast drops after coffee-cup disarm, tumblefeed-loot 2 yellows + gummy-shrocks, magic-espresso-maker (quest item), combat flows for plant + tumblefeed-nest, use-blast-roast, unresolved `records-sub-basement`.
- `locations/apartment.md`: **Lily dialogue + Jerome's orb lift** — talk-to-Lily flow, lift-jeromes-yellow-orb quest pickup (gates on checked_on_lily), install-magic-espresso (gates on inventory), sort-dining-table (+3 yellows), nap-on-couch (+3 hp +2 energy), unresolved `third-bedroom`.
- `locations/call-center-floor.md`: close-3-tickets (+1 gold), HVAC-climb + timed rift-slip (world.time.hhmm 02:25-02:40 window → goto the-office-entry), kitchenette-coffee bad decision, show-frank-pass at turnstile, Theo dialogue flow, unresolved `the-sixth-floor`.
- `locations/call-center-lobby.md`: pay-frank-40-gold → give frank-lobby-pass + dialogue flow.
- `locations/ichabods-bar.md`: Frank dialogue flow, bartender dialogue flow, play-jukebox (-1 gold +1 hp), unresolved `ichabods-back-room`.
- `locations/hammer-time.md`: proprietor dialogue flow, buy-crowbar (-3 gold), buy-spear (-5 gold), buy-sledge (-7 gold).
- `locations/parlour-street-diner.md`: pancakes pickup → use_item, tip-60-gold, Theo drop-in flag (world.time.hhmm 04:00-05:30 window) → Theo dialogue flow, unresolved `diner-back-door`.
- `locations/decision-tree-grove.md`: 4-yellow → 2-purple trade (take/give_item), crack-purple-orb option, unresolved `unmapped-grove-corridor`.
- `locations/basilisk-approach.md`: **IR-glasses safe-path** — if character has infrared-sunglasses, a new safe-walk option drops a green-orb. Combat-fallback wired to flow_start module=combat. Stat-diff encodes IR glasses as the puzzle key.
- `locations/the-bathrooms.md`: silverfish combat flow, mirror-break gives green-orb + orange-orb + 2 mirror-shards (material).
- `locations/server-room.md`: Terrorbyte combat flow (hp=30, atk=7), stealth success chains hoard-skim (+3 yellow +1 blue), unresolved `terrorbyte-access-panel`.
- `locations/east-stairwell-door.md`: added kneel-at-seam observational option, unresolved `sixth-floor-service-access`.
- `npcs/theo.md`: +2 memory_initial seeds (Theo's 4-a.m. diner appearances, "my favorite employee" tell).
- `npcs/frank.md`: +2 memory_initial seeds (blank-RFID arrangement, jukebox regret song).
- `npcs/ganesh.md`: +2 memory_initial seeds (glass-spike origin protectiveness, shrug-via-Rufus).

### Eras advanced (3)

- **Era 1 → 2: The Stapler Census** (chronicle `nh7ajz75pxrzd25jxv9ggz07e5857f4e`). Opus wrote: *"The first era ended the way most things end on night shift: not with a bang, but with a clipboard..."*
- **Era 2 → 3: The East Stairwell Goes Quiet** (`nh7adncvffqr01accfnzf6kyn9857xd6`). Opus wrote: *"The Tuesday door stopped opening. Not dramatically — no alarm, no last stand, no final boss in a clip-on tie..."*
- **Era 3 → 4: The Map Unfolds at 3:45** (`nh710rrftm976e9cxwqt514bjh856ga1`). Opus wrote: *"The third era ended the way most things in the Office end — quietly, on a Tuesday..."*

Each chronicle clocks in at ~2-3 paragraphs and holds the grim-comedic tone. Catchup panel queries confirm pending era 1→4 for Lilith's character.

### Playtest verdict

**What shipped and worked:**
- **Items populate inventory correctly with typed metadata.** Crowbar → `{kind:gear, slot:primary_weapon, qty:1}`. Green-orb → `{kind:orb, color:green, size:2}`. Taxonomy lookups via `has(character.inventory, 'slug')` fire cleanly in conditions.
- **`crack_orb` chains on_crack + on_absorb.** Cracked a green orb at Fort Door: HP 7 → 15 (+3 on_crack +5 on_absorb), plus Opus narrated two grounded in-voice sentences ("*The green orb sank into Lilith's sternum like a key turning in a lock...*") arriving on the next look as flushed pending_says.
- **Gated options work.** IR-glasses safe-walk at basilisk-approach is correctly hidden until `has(character.inventory, 'infrared-sunglasses')` AND `this.saw_the_camera` are both true. Picking it dropped a green-orb; fallback combat flow is there if the player skipped the glasses entirely.
- **Unresolved-target expansion works.** Picking "Try the service-access door that sometimes isn't there" → streaming expansion generated a draft `hallway-one-north-sprint` with rich prose (pencil-dart trap flashing under the front tire, a row of staplers turning their heads in unison). Same for `third-bedroom` (apartment exit) — Opus wrote a quiet-liminal guest-room page-1.
- **Era chronicles land in voice.** All 3 Opus-generated chronicles picked up the "grim-comedic-corporate" descriptor and kept the found-family weight. Titles were strong (Stapler Census; East Stairwell Goes Quiet; Map Unfolds at 3:45).
- **Biome spawn_tables are authored** (atmospheric-tier runtime is in; combat-spawn integration still deferred per prior log).

**What did NOT work (gaps to technical agent, below):**
- **`flow_start` effect is a no-op in applyOption.** `convex/locations.ts:572` has the comment `// flow_start deferred until flow runtime lands.` — so every combat / dialogue option I wired via `flow_start module=combat/dialogue` fires the rest of the effect chain (says, state sets) but does NOT actually schedule a flow row. `weaver flow list` shows `(no flows)` after picks that should have opened combat. The flow runtime exists in `convex/modules/{combat,counter,dialogue}.ts` (`weaver flow start combat --state '...'` works standalone) — it's just not wired into the option-pick pipeline. This is the single biggest gap blocking Office playtest value.
- **`item_id` vs `slug` naming drift.** The zod effect schema in `packages/engine/src/schemas/index.ts` declares `give_item/take_item` with `item_id: z.string()`, but `convex/effects.ts` reads `eff.slug`. All 91 pre-existing `item_id` entries authored by Argus silently drop their inventory effects — the say prose fires but no item lands. I had to mass-rename to `slug` in my content to get inventory to populate. This is why the pre-Wave-2 Office "walking sim" was really just a prose-sim: the loot options were all quietly broken.
- **Expression grammar: no bracket-subscript and no hyphens in dotted paths.** `character.inventory['yellow-orb'].qty >= 3` throws `unexpected char . at N` because the tokenizer regex is `[a-zA-Z_0-9.]` — it can't handle `[` or `-`. `evalExpression` has a try/catch around `parseTernary()` but NOT around `tokenize()`, so this error bubbles all the way up and aborts `dumpLocation` on any location with such a condition. Workaround: author with `has(character.inventory, "yellow-orb")` only — quantity-conditions aren't expressible at the YAML layer today.
- **`location.*` vs `this.<slug>.*` scope confusion.** Break-room's tumblefeed-cleared flag was authored as `location.tumblefeed_cleared` (following existing Argus pattern) but `state set` writes to `this.<loc>.*`. The conditions on `location.*` stay false. The two scopes aren't clearly documented; authors will stumble.
- **Era-advance chronicle JSON parse fragile.** `weaver era advance --hint "..."` fails with `chronicle JSON parse failed: Unterminated string at position 2200-2500` on hints that invite longer Opus output. Shorter, simpler hints work. Likely a missing streaming-response completion or an Opus max_tokens truncation mid-JSON. Three advances succeeded on short hints; richer/longer hints all failed.
- **Pre-existing authored content: `character.inventory.has('dungeon-duffel')` method-style call.** Not supported by the expression grammar (it's a function lookup on an identifier `character.inventory.has` that isn't a builtin function name). Silently evaluates to `undefined` → false. `call-center-lobby.md` option 1 is effectively dead until rewritten.

### Gaps / feedback to the technical agent

1. **Wire `flow_start` in `convex/locations.ts:544` dispatch loop.** The pending-array flow_start entries are documented but never scheduled. The modules exist; just need the `ctx.scheduler.runAfter(0, flows.startFlow, {...})` call. Before this lands, every combat option and every dialogue option I authored is a no-op on the runtime side (says still fire, state still mutates, but no actual fight or conversation turn).
2. **Unify `item_id` vs `slug`.** Either change the schema to `slug` or change the runtime to accept `item_id` as an alias. The more I dug, the more I think the schema was ahead of the renamer and the runtime was correct — but either way, silent-drop + no validator warning is a footgun.
3. **Fix the expression tokenizer.** Needs (a) a catch around `tokenize()` in `evalExpression` (so malformed expressions fail soft, not abort renders), (b) bracket-subscript for object keys with hyphens, or (c) a `qty(character.inventory, "yellow-orb")` builtin that sidesteps the whole issue.
4. **Document `location.*` vs `this.<slug>.*` scope rules.** Or unify them. This has probably been tripping people up silently for a while.
5. **`advanceEra` prompt should explicitly request terse JSON output**, or the action should retry with `max_tokens` bumped. Even a one-sentence hint like "The Tuesday window closes" was failing at ~2400 chars of Opus output, suggesting Opus is writing a rich chronicle and getting cut off mid-value.
6. **`weaver flow list` should include flows started by option-effect `flow_start`.** Currently it only shows flows started via `weaver flow start` CLI, or flows whose runtime schema is in the right shape. Both would be fine once #1 is fixed.
7. **Consider a `spawn_combat` effect that resolves by NPC slug.** Like quiet-vale agent suggested, combat options would be cleaner if you could write `{ kind: spawn_combat, npc_slug: tumblefeed-nest }` and the runtime resolves hp/atk/name from the NPC's `combat_profile` block, rather than hardcoding `initial_state` in every option.

### Content notes for Lilith to review

- **Tone held.** All new prose stays within the grim-comedic-office-absurdist lane. Physical comedy: tumblefeed under the table, coffee-cup landmines, the microwave-with-a-stapler. No dramatic fantasy. No "quest giver" NPCs — Tattoo's toll IS a quest giver but he signs in leg-taps.
- **No new NPCs.** Work from existing roster (Frank, Ganesh, Lily, Theo, Tattoo, proprietor, bartender). Combat encounters are creature-slug-only (potted plant, tumblefeed, camraconda, silverfish, Terrorbyte) — no authored NPC entities — to avoid polluting the roster.
- **Eras 1→4 feel like arc beats.** Stapler Census = routine settles. East Stairwell Goes Quiet = primary entry seals; HVAC rift becomes the only way in. Map Unfolds = Sarah's paper-map leads somewhere deeper. The family can keep going with more advances or flip back via rollback.
- **Jerome's yellow orb is the narrative hook.** Currently at Lily's pen, 99% scan. Family picks it up from the apartment; cracking or absorbing it is the next-era-gating decision the family hasn't been asked to make yet.
- **Frank's lobby-pass economy.** 40 gold/bribe is priced to matter — close 3 tickets (+1 gold each) 13 times to afford one. Or skip the pass and risk Frank's discretion. Player-choice.
- **Prefetch stubs**: 9 unresolved-target options sprinkled through anchors. Expansion-streaming will generate one-shot drafts on tap. Two have already been played (`hallway-one-north-sprint` pre-existing draft; `third-bedroom` expanded live during playtest). The other 7 are dormant hooks.

### Sync state

All 23 locations, 7 biomes, 7 NPCs, 22 items, 5 characters, 1 bible = 65 artifact_version bumps in 3 sync rounds (one for initial push, one for bracket-subscript fix, one for item_id→slug rename). Current: all entities at v3 or v4.

Flags observed firing: `flag.item_taxonomy` (inventory populates with kind metadata), `flag.biome_rules` (ambient says on traverse, fatigue damage at office-dungeon-outer), `flag.eras` (3 chronicles + catchup), `flag.world_clock` (hours_in_dungeon accumulator ticks), `flag.npc_memory` (seeds injected into any narrate calls). Flags that did NOT fire through option-picks but would have if wired: `flag.flows` (see gap #1).
