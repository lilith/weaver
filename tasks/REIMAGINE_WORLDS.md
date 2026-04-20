# Creative Task — Reimagine Quiet Vale + The Office as Wave-2 LitRPG-lite

**Assignee:** a creative-direction agent (not the technical agent).
**Target audience:** a family of five playing in 15-minute sessions; mobile-first.
**Status:** open, unassigned.
**Last edited:** 2026-04-20 (post-commit `9836bca`).

## Why this task exists

Two worlds exist in Convex today, both authored before Wave-2 mechanics shipped:

- **The Quiet Vale** (`quiet-vale-f96pf4`) — cozy family starter. Wave-0 shape: village + Mara's cottage + some expansion-added drafts. Pretty, but *meh* — no real play loop.
- **The Office** (`the-office`) — 43 entities imported from the `backstory/argus-daily-grind/` extraction. Rich tone, but the family's feedback is that it plays as **an endgame walking simulator**: you traverse atmospheric locations but nothing mechanical happens.

Wave-2 shipped everything POSTER_CHILD.md advocated for: item taxonomy (orbs, gear, consumables, keys), NPC memory, biome rules (dilation, hooks, spawn_tables, ambient), step-keyed flows (dialogue module, combat module), effect router (`give_item`, `crack_orb`, `damage`, `narrate`, `flow_start`), eras + chronicles, expansion streaming + prefetch, art curation + reference-image pipe.

**None of those are wired into content yet** in either world. Tones were auto-enriched by an earlier content-upgrade agent (biome `rules:` blocks + NPC `memory:` seeds) but no combat encounters, no item pickups, no dialogue flows, no era arc beats, no spawn-table enemies.

Your job: pick up the palette and *play the game into existence.*

## Read first (in order)

1. **`backstory/POSTER_CHILD.md`** — the vision. This is in the gitignored `backstory/` sibling repo (`~/fun/weaver-backstory` or `/home/lilith/fun/weaver/backstory/` depending on layout). Ask Lilith if you can't find it. NEVER copy prose from this document into Weaver content — it's the private source material; your job is to inspire the mechanical shape, not transcribe.
2. **`spec/20_POSTER_CHILD_CAPABILITIES.md`** — the 7 asks; status of each.
3. **`spec/21_BIOME_RULES.md`**, **`22_ITEM_TAXONOMY.md`**, **`24_NPC_AND_NARRATIVE_PROMPTS.md`**, **`25_ERAS_AND_PROGRESSION.md`** — exact schemas.
4. **`CLAUDE.md`** — conventions. Especially the "NEVER throw shade on other projects" and "NEVER destroy uncommitted work" rules.
5. **`PLAYTEST_LOG.md`** — what's been observed in play.

## The goal, concretely

Both worlds should feel like they have **systems** the family can discover and interact with, not just **descriptions**.

For a 15-minute session:
- 2-3 options on every page that do *something* mechanical (not just `say`).
- At least one ambient atmospheric moment per biome (tick, spawn hint, weather shift) that the player didn't request.
- NPC dialogue that remembers what the family did last time.
- Items that accumulate, unlock options, or resolve tensions.
- Combat that's rare and legible, not constant and grindy.

Keep it *light*. LitRPG-**lite**, not RPG. The family plays with a 7-year-old; the 15-year-old; the mom; the dad; and an uncle who drops in once a week.

## Available mechanics — the palette

All of these are shipped + flag-enabled for both worlds.

### Item taxonomy (`22_ITEM_TAXONOMY.md`, `flag.item_taxonomy` on)
```yaml
# items/yellow-orb.md
---
name: Yellow skill orb
kind: orb
orb:
  color: yellow
  size: 1              # 1-4
  on_crack:
    - { kind: say, text: "..." }
  on_absorb:
    - { kind: inc, path: "character.energy", by: 2 }
---
```
Kinds: `orb | gear | consumable | key | quest | material | misc`. Each kind has its own block. Authoring tools: `weaver push item <slug> <file>`.

Effects that use items (already in effect router):
- `give_item { slug, qty?: 1, payload?: {...} }`
- `take_item { slug, qty?: 1 }`
- `use_item { slug }` — consumes a charge; fires item's `on_use`.
- `crack_orb { slug }` — fires item's `on_crack` then `on_absorb`; orb is consumed.

Condition syntax for inventory gates:
```
has(character.inventory, "yellow-orb")
character.inventory["yellow-orb"].qty >= 2
```

### Biome rules (`21_BIOME_RULES.md`, `flag.biome_rules` on)
```yaml
# biomes/flow-plane.md
---
name: The Flow Plane
rules:
  time_dilation: 40                   # min/turn; 1 = real-time, 40 = 8h/turn
  on_enter_biome:
    - { kind: say, text: "You step into the Flow..." }
  on_leave_biome:
    - { kind: say, text: "The Flow's grip releases." }
  on_turn_in_biome:
    - { kind: inc, path: this.exposure, by: 1 }
  ambient_effects:
    - { kind: damage, amount: 1, damage_kind: acid, every_n_turns: 6, chance: 0.5 }
  spawn_tables:
    low_noise: [none, sewer-herring]
    mid_noise: [acidwhisker-pack]
    high_noise: [acidwhisker-pack, tumblefeed]
  spawn_chance_per_turn: 0.1
---
```
Everything in `rules:` is optional; a biome with no rules behaves like real-time, no ambients. The content-upgrade agent already populated most biomes with conservative rules; you should refine them and add spawn_tables where they serve play.

### NPC memory (`24_NPC_AND_NARRATIVE_PROMPTS.md`, `flag.npc_memory` on)
```yaml
# npcs/mara.md
---
name: Mara
lives_at: mara-cottage
memory:
  default_salience: medium
  retention: 40                       # rows before compaction
  track: [dialogue_turn, the_player_visited, gift_received]
  ignore: [weather_change]
memory_initial:
  - { summary: "Came back to the Vale after a decade away.", salience: high }
  - { summary: "Mistrusts the old gods but still leaves tea for them.", salience: medium }
---
```
The content-upgrade agent seeded these. You can **add** more seeds grounded in existing NPC `voice.examples` / `knows` / `sample_lines` / `description`. **Never** invent new facts about an NPC.

### Dialogue module (`flag.flows`, `flag.module_dialogue` on)
Start a dialogue via a location option:
```yaml
options:
  - label: "Ask Mara what she's building"
    effect:
      - { kind: flow_start, module: "dialogue", initial_state: { speaker_slug: "mara" } }
```
Flow runs Sonnet per exchange, writes `dialogue_turn` memory rows, exits on "Walk away" choice or free-text from the player.

### Combat module (`flag.module_combat` on)
```yaml
options:
  - label: "Square up"
    condition: 'has(this.sewer-entry, "hostiles_nearby")'
    effect:
      - kind: flow_start
        module: "combat"
        initial_state:
          enemy_slug: "acidwhisker"
          enemy_name: "Acidwhisker"
          enemy_hp: 6
          enemy_max_hp: 6
          enemy_attack: 2
          player_weapon_attack: 3
          escape_dc: 5
```
States: `open → player_turn ([attack | flee]) → enemy_turn → done`. Damage effects flow through the router so `character.hp` ticks materially. Seeded-RNG rolls are deterministic per (flow, step, turn).

### Narrate effect (Sonnet-generated flavor, `flag.item_taxonomy` gates it, fires async)
```yaml
effect:
  - kind: narrate
    speaker: "mara"                  # optional; wires memory auto-write
    memory_event_type: "gift_received"
    prompt: "Mara receives the coin Claude offers. Reply in one sentence."
```
Appended to `character.state.pending_says`; flushes on next applyOption.

### Eras + chronicles (`25_ERAS_AND_PROGRESSION.md`, `flag.eras` on)
```
weaver era advance "a quiet winter settled over the Vale; Mara left for a week"
weaver era list   # see all chronicles
```
Each advance writes a chronicle Opus generates from the bible + your hint. Characters who played before the advance get an in-game catch-up panel the next time they open the game.

### Expansion streaming + prefetch (on)
You don't need to wire these; they're player-driven. But keeping unresolved-target options around (e.g. a door to a "mysterious library" not yet authored) triggers prefetch speculation — the family will "stumble into" new places with near-zero latency.

### Art curation + reference board (on)
- The wardrobe UI lets the family conjure variants per mode (banner, portrait_badge, tarot_card, illumination, ambient_palette).
- The **reference board** (`/admin/art/<slug>`) pins upvoted renderings per kind. When a new gen is requested and a matching reference exists, it uses `fal-ai/flux-pro/kontext` with the reference as image input — family's visual canon converges.
- You can pin reference art for characters, biomes, and modes. Do this after the family plays a few sessions and you see which variants they upvote.

## Constraints

1. **Preserve tone.** Quiet Vale is cozy/gentle/slightly-whimsical. The Office is grim-comedic corporate. Re-read each world's `bible.md` before touching anything; keep its `tone.avoid` taboos.
2. **No prose reproduction from `backstory/`.** That source is copyrighted. Mechanical shape inspiration only.
3. **Never invent NPCs.** Work from the existing roster.
4. **Don't rename slugs.** They're stable identifiers; the importer resolves refs by slug.
5. **Prefer additive edits.** A new `options:` entry is better than a rewrite of prose.
6. **Family-first pacing.** A 7-year-old shouldn't hit a wall of dense mechanics on page 1. Introduce systems gradually across the first few turns.
7. **Quiet Vale combat = silly-humor only** (Legend of the Green Dragon / Hogwarts Life style). Wet-baguette duels with offended geese. Never dramatic. Still rare — one encounter per biome visit at most; cozy tone dominates.
8. **The Office *should* have combat** but it should feel like office-absurdist physical comedy (tumblefeeds under desks, coffee-cup landmines), not fantasy D&D.

## Workflow — step by step

### 1. Set up your session

```bash
# Login as claude-seedy-something; export handoff uses --as river.lilith for owner ops
node scripts/weaver.mjs login creative-agent-$(date +%s)@theweaver.quest
```

### 2. Export the world you're working on

```bash
mkdir -p /tmp/reimagine
node scripts/weaver.mjs --as river.lilith@gmail.com export quiet-vale-f96pf4 /tmp/reimagine/quiet-vale
node scripts/weaver.mjs --as river.lilith@gmail.com export the-office /tmp/reimagine/the-office
```

Each export produces `bible.md` + `biomes/ characters/ npcs/ locations/ items/` subdirs per `spec/AUTHORING_AND_SYNC.md`.

### 3. Read before writing

For each world:
- Read `bible.md` top to bottom. Internalize `tone.descriptors`, `tone.avoid`, `established_facts`, `taboos`.
- Walk `biomes/*.md`. Note which have `rules:` and which don't.
- Walk `locations/*.md`. Note `options[]` per page — what's say-only, what has targets, what's bare.
- Walk `npcs/*.md`. Note which have `memory_initial`. Look at `voice` / `knows` / `sample_lines`.
- Sketch a per-world plan before editing any file.

### 4. Edit in place

Add fields — don't rewrite existing content. The exporter preserved field order; keep it stable so diffs stay reviewable.

Examples of edits you'll make:
- To `items/` (net-new files): author item entities with `kind:`, per-kind blocks.
- To `biomes/<slug>.md`: add or refine `rules.spawn_tables` + `rules.spawn_chance_per_turn` for biomes where spawns serve play.
- To `locations/<slug>.md options`: add new options with effects like `give_item`, `flow_start` (combat/dialogue), `crack_orb`. Gate with `condition:` strings that reference `this.*` or `character.inventory.*`.
- To `npcs/<slug>.md`: extend `memory_initial` with grounded seeds. Add a canonical "Talk to X" option on the NPC's `lives_at` location.

### 5. Validate + sync

```bash
# Validator catches missing fields, unresolved biome refs, broken neighbor targets.
node scripts/weaver.mjs validate /tmp/reimagine/quiet-vale

# Sync pushes every file to Convex as a new artifact_version. Authored
# prose stays (via the exporter's split); frontmatter changes produce
# the diff.
node scripts/weaver.mjs --as river.lilith@gmail.com --world quiet-vale-f96pf4 \
  sync /tmp/reimagine/quiet-vale \
  --reason "creative reimagine: combat + items + dialogue wiring"
```

### 6. Playtest via CLI

```bash
node scripts/weaver.mjs --as river.lilith@gmail.com --world quiet-vale-f96pf4 \
  go village-square

node scripts/weaver.mjs look
node scripts/weaver.mjs pick 0        # pick option 0
node scripts/weaver.mjs state         # see inventory/hp/this/turn state
node scripts/weaver.mjs flow list     # running flows?
node scripts/weaver.mjs memory show mara
node scripts/weaver.mjs bugs          # anything caught by sanitizers?
```

If anything looks wrong mid-playtest, the `weaver bugs` command surfaces sanitizer-caught invariants; runtime auto-heals corrupt state + logs to `runtime_bugs` table.

### 7. Playwright smoke (optional but recommended)

```bash
cd apps/play
pnpm test:e2e --grep "core loop" --reporter=list
```

Confirms the browser UI still plays cleanly with your content.

### 8. Log the session

Append to `PLAYTEST_LOG.md`:

```markdown
## YYYY-MM-DD — creative reimagine (<world>)

**Worked on:** <slug>
**Duration:** (real minutes spent)
**Mechanics wired:** (items / combat / dialogue / eras / biome refinements)

### Changes (terse, per entity)
- biomes/forest.md: added spawn_tables, +ambient rustle every 5 turns
- items/wishing-coin.md: new (orb, yellow, size 1)
- locations/old-well.md: added "Drop the wishing coin in" option with crack_orb

### Verdict
<What worked. What didn't. What the family probably still won't like.>

### Gaps / feedback to the technical agent
<Anything the mechanics can't express that you think they should.>
```

## Scope — per world

### Quiet Vale

**Wave-2 wire-ins that serve cozy play:**
- One small wildlife biome (`forest` / `meadow` — pick one that exists) with gentle `on_turn` atmospheric says every 4-6 turns.
- 3-5 **items**: `herbal-tea` (consumable, 1 charge, heal 3), `mara-sketchbook` (key, unlocks a specific map-drawing option with Mara), `wishing-coin` (orb, yellow, size 1, absorbs into +2 energy), optionally `smooth-stone` (material, quest-flag).
- **Mara dialogue**: expand her `memory_initial` with 2-3 grounded seeds; add "Talk to Mara" as a conditional option on her location (`condition: world.time.hhmm >= '07:00' && world.time.hhmm < '21:00'`).
- **One era transition**: after the family has spent a few hours in-game, `weaver era advance "early spring gave way to high sun, and the Vale's chickens began a quiet rebellion"`. Write only one chronicle to start; more if the family engages.

**Silly-humor fights (Legend of the Green Dragon / Hogwarts Life style, user override 2026-04-20):**
- Low-stakes absurd encounters. Example enemies: a mildly offended goose, the village's most passive-aggressive squirrel, a confused hedgehog that rolls into you, sheep who disapprove of your haircut, an umbrella that's been waiting for rain, a jam-thieving magpie.
- Silly weapons as `gear` items (low attack, comedic names): wet baguette, aggressive spatula, a particularly assertive umbrella, a lightly bruised apple.
- Victory/defeat lines are punchlines, not drama. No one dies. HP drops, player gets embarrassed, tea restores.
- Keep rare — `spawn_chance_per_turn` ≤ 0.1, at most one encounter per biome visit. The cozy tone dominates.

**Farming:**
- Author 3-4 `seed` / `sapling` / `harvest` items (`consumable` or `material` kind).
- A garden plot location with `plant` / `water` / `harvest` options. Growth gated by world clock ticks (seed → sprout → mature after N turns).
- A harvested crop can feed into `herbal-tea` or just be a quiet trophy.

**Fishing:**
- A pond or stream location with a `fish` option that rolls seeded RNG for catch.
- Catches: `trout`, `old-boot`, `mossy-rock`, `a-letter-in-a-bottle` (which unlocks a narrative thread when read).
- `fishing-rod` as `gear`; required for the fish option (`condition: has(character.inventory, "fishing-rod")`).

**Reading books:**
- Author 3-5 books as `item` kind with an `on_read` block that fires a `narrate` effect or grants a small flag.
- A library or bookshelf location with books as pickups.
- "Read X" option surfaces on character inventory pages and fires the book's `on_read`.

**Do NOT:**
- Let combat get dramatic or dangerous — silly only.
- Invent named NPCs beyond Mara + Halvard (the only two in the bible).
- Change content_rating (stays family).

### The Office

**Design direction (user override, 2026-04-20):** The Office currently plays as a walking sim across 40+ imported locations. Shift the shape:

- **Consolidate locations.** Fewer, denser, more mechanics per page. Each location should have 3+ options that *do* something (pick up, fight, talk, use, travel, read). Mark thin ambience-only rooms as deprecated; merge adjacent thin rooms into one richer anchor.
- **Eras drive progression.** Plan a sequence of 3-5 era advances. Each era opens new mechanical affordances (new orb colors, new enemy types, new flow states, new items/keys), transforms the feel of existing office spaces, and gets an Opus-generated chronicle tied to a story beat. Execute 2-3 initially via `weaver era advance --hint "..."`; more as the family engages.
- **Lean into emergent exploration.** Leave unresolved-target options on location pages (e.g. `target: mysterious-sub-basement` with no authored destination) so expansion-streaming prefetch generates new places on tap. Authored anchors stay minimal.
- **Fight encounters + items support emergent creativity.** Ambient spawns fire hostile flags; combat options gate on them. Items encourage experimentation — crack an orb, combine keycards, use office supplies as weapons. Dialogue branches based on NPC memory of prior family actions.

**Wave-2 wire-ins that transform the walking sim into actual play:**
- **Skill orbs as first-class items.** The backstory has 4-6 orb colors. Author each as an `item` entity with `kind: orb`, per-color `on_absorb` effects (yellow→skill roll, blue→flow state bonus, green→heal, red→damage-adjacent stat). The break-room location `canonical_features` already mentions "a large plastic potted plant in the corner, set over a glowing yellow skill orb" — turn that into an actual pickup option.
- **Enemies + combat.** Author `tumblefeed`, `staple-bandit`, `acidwhisker` (or whatever the source material specifies) as `npc` entities with minimal description + a `combat_profile:` block (hp, attack, loot drops). Add `spawn_tables` to `office-dungeon-outer`, `office-dungeon-deep`, `sewer-entry`-equivalent. When an ambient-spawn fires, gate a combat option via `condition: 'has(this, "hostiles_nearby")'` with `flow_start combat`.
- **Dialogue for Frank, Ganesh, Lily, Anesh, others.** Each NPC that has `voice` / `knows` fields should get a "Talk to X" option on their `lives_at` location. Seeds for memory from existing fields.
- **At least one authored quest thread** using `key`-kind items. E.g., a keycard `kind: key, key: { unlocks: [secure-floor] }` that gates a currently-inaccessible area.
- **Chronicle per major beat** in the source arc. Use `weaver era advance --hint "..."` with a hint that echoes (but doesn't reproduce) a beat from `backstory/POSTER_CHILD.md`. Write 2-3 initially.

**Do NOT:**
- Copy paragraphs from `backstory/` source material.
- Invent NPCs outside the existing roster.
- Change the sardonic office-corporate tone.

## Post-reimagine

Once both worlds are synced + playtested:
- Pin 3-5 reference-board entries per world (`/admin/art/<slug>`) so future art gens converge.
- Run a final `weaver bugs --severity error` and clear any surfaced invariant issues.
- Write the `PLAYTEST_LOG.md` entry.
- Commit nothing to git — content lives in Convex; the technical agent handles any code changes your work surfaces.

## Out of scope

- Touching `convex/*.ts`, `apps/play/src/*`, `packages/engine/src/*`, `scripts/*.mjs`. If your work surfaces a mechanic gap (e.g., "we need a `track_fleeing` effect that isn't just `set this.fled true`"), file it as a feedback item in the playtest log and the technical agent picks it up.
- Bumping any flag on or off for a world. Flags are set.
- Authoring new biomes or locations unless they fill an obvious gap. Prefer editing existing.
- Touching Quiet Vale's core bible (Mara's identity, the Vale's geographic premise) — only additive changes there.

## Contacts

- For technical questions (why is this effect not firing, schema question, CLI bug): file a line in `PLAYTEST_LOG.md` under `### Gaps / feedback to the technical agent`. The technical agent reads the log on every session start.
- For creative questions (tone, what to add, pacing): Lilith is the final reviewer. Don't over-consult — the job is to *ship a reimagine*, not perfect one.
