# UX_PROPOSALS.md — open design questions

Running log of UX tensions I hit while building, where the right call
isn't obvious. Each item is a deferred decision for you, not for me.
Format: **problem** · *how it showed up* · *what I'd do if forced* ·
*proposed decision surface*.

Last updated: *2026-04-20, after async-sync direction call*.

---

### Direction (not a question — captured so the next session knows)

**Campaign model: async by default, sync when it happens.** Full
design in `spec/ASYNC_SYNC_PLAY.md`. TL;DR: clock advances with any
actor; when someone logs in late, they see *"while you were gone…"*
events and pick per-event "I was with them / I skipped it / tell me
about it." Retroactive agency. Fun in 5-min slices *and* on
family-LAN night.

This replaces several potential designs (real-time MMO-ish,
strict-turn-based, single-player-sandbox) and resolves UX-02 below.

---

### UX-01 · Time-gated options vanish silently

**Problem.** With Ask 3 live, an option whose `condition:` references
`world.time` (e.g. *"Push the east stairwell door open"* on Tuesdays
03:44-03:46) is simply absent from the options list outside that
window. A player who missed the window has no clue it ever existed.

*How it showed up.* Wiring the east-stairwell-door location in The
Office. The whole *inciting mechanic* of the series disappears into
thin air if the player isn't looking at 03:44 on Tuesday.

*If forced.* Show the option as grayed-out with a hint like *"only at a
very specific time"* — hint without spoiling. Or an `on_enter`
narration flavor line that drops a breadcrumb.

*Decision surface.* (a) hide entirely — purest, most mysterious;
(b) show grayed-out with vague hint — playful, preserves intrigue;
(c) show grayed-out with full condition rendered — cheats the mystery;
(d) context-sensitive: authored `hidden_until` / `teaser_when` fields
the author sets per option.

Leaning **d** for long-term, **b** for Wave-2 default.

---

### UX-02 · Who ticks the clock in a shared world — **RESOLVED**

**Resolution (2026-04-20):** async-first campaign model — see
`spec/ASYNC_SYNC_PLAY.md`. The world clock is monotonic and advances
whenever any character acts; late-arriving players *catch up* via a
catch-up panel ("Lilith went to the sewer — were you with her?").
No race, no debouncing. Clock is a single shared monotonic counter;
narrative threads are per-character with retroactive convergence.
Kept here for provenance.

---

### UX-03 · No way to wait / rest / skip time

**Problem.** If a player is standing on the east-stairwell-door at
3:40 on Tuesday, they need to burn 4 minutes of game time before the
door unlocks. Currently the only way to do that is pick an option,
any option, until time advances far enough. That feels wrong — the
player *wants* to wait, they shouldn't have to fake a dozen actions.

*If forced.* Add a canonical `wait` option to every location's
implicit option list, or a bible-level "idle / wait a beat" action
that's always available. Advances clock by configurable delta.

*Decision surface.* (a) every location implicitly gains "wait a
moment" (advances 1 tick); (b) a global "wait" affordance in the UI
(next to the weave input) that advances 1 tick; (c) nothing — rely
on authors to put a "rest" option where it matters.

Leaning **b** — UI-global action avoids boilerplate per-location.

---

### UX-05 · New biomes land with no palette

**Problem.** The expansion prompt now asks Opus to prefer the world's
authored biome slugs but allows inventing new ones when needed. Any
invented biome slug has no entry in `packages/engine/biomes/
palettes.json` — the location page falls through to the base
midnight-loom palette. The world's own authored biomes in
`the-office` (office-dungeon-outer, apartment, coffee-shop,
parlour-street-diner, …) also lack palette entries because
`gen-biome-themes.mjs` was a one-shot 9-biome generation, not aware of
later imports.

*How it showed up.* Imported The Office with 7 custom biomes; none
have a palette. Every location inside looks the same color-wise.

*If forced.* Auto-generate palettes during import — for each biome
slug in the bundle, if no palette exists, call Opus once with the
biome's name + `establishing_shot_prompt` + world style anchor, add
to the registry, persist. Costs ~$0.05 per 10 biomes (amortized).

*Decision surface.* (a) auto-gen per-import — cost + one extra LLM
call in the import path; (b) batch-gen on demand — a "regenerate
palettes" button somewhere; (c) stay hand-curated forever — every
world gets the same palette unless someone runs the script.

Leaning **a**, embedded in the importer. Cost is negligible.

---

### UX-04 · World clock not visible on the journal page

**Problem.** Journal shows journeys with their `opened_at` as a
real-world timestamp. But the world clock time at journey-open might
be more narrative-meaningful ("Tuesday 03:44 am" vs "yesterday at
10:12 pm your local time"). Conversely: the player might want real
wall-clock too so they remember when they played.

*If forced.* Show both: world time on the top line, real time on the
sub-line in smaller mist-600.

*Decision surface.* Future polish — not blocking anything.

---

### UX-06 · `ambient_effects[].chance` spec/runtime drift

**Problem.** `spec/21_BIOME_RULES.md` documents a `chance: 0.3` field on
ambient effect entries for probabilistic firing. The runtime in
`convex/locations.ts` only uses `every_n_turns` modulo-match; `chance`
is silently ignored. Surfaced by the 2026-04-20 content-upgrade agent.

*If forced.* Implement: `if (every > 0 && nextTurn % every === 0 &&
(amb.chance === undefined || ctx.rng() < amb.chance))`. Uses the
existing seeded RNG (flow_id|step_id|turn) for determinism.

*Decision surface.* (a) ship the runtime hook to match the spec;
(b) remove `chance` from the spec. Leaning **a**.

---

### UX-07 · `memory_initial[]` lacks `event_type`

**Problem.** NPC memory seeds are `{summary, salience}` only. At prompt
assembly, seeds are always included; they can't be filtered by the
`memory.track` / `memory.ignore` fields that filter live-written rows.
Not blocking today, but visible when a playtest session accumulates
dozens of live rows and the seeds drown in recency-ranked noise.

*Decision surface.* (a) add optional `event_type` to seeds; (b) leave
seeds always-included on the theory they're small-count by construction.

---

### UX-08 · Biome "safe-zone" primitive

**Problem.** Quiet Vale's village, The Office's apartment / coffee-shop
/ diner are thematically sanctuaries. Runtime doesn't know that — they
are indistinguishable from any mundane biome. A player fleeing the
office-dungeon into the apartment should feel the shift.

*If forced.* Add `rules.sanctuary: true` as a biome hint; interpreted by
future modules (combat, wellness ticks) as "no damage, hp regen, anxiety
decay." For v1 the interpretation can be documentary.

---

### UX-09 · `--as <email>` + world-scoping in the CLI

**Problem.** Both content-upgrade agents (2026-04-20) hit the same
sequencing bug: `--as river.lilith@gmail.com world use the-office`
followed by `--as ... sync ...` failed because `--as` creates a fresh
ephemeral session; `world_slug` doesn't persist across invocations.
Workaround: `--world <slug>` inline with `sync`.

*If forced.* Either (a) `--as` implicitly re-establishes the previously-
active world per impersonated-email, or (b) `sync`/`push` always accept
`--world` and the docs make that the canonical path when `--as` is in
play. Leaning **b**. Trivial to land.
