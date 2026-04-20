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
