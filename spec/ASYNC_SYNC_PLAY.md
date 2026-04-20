# Weaver — Async + Sync Play (the campaign model)

**Status:** designed
**Flag:** `flag.campaign_events`
**Registry:** `FEATURE_REGISTRY.md` #15
**Last updated:** 2026-04-20

*Direction-shaping decision, 2026-04-20.* One design rule that resolves
several open questions. Wave 2–3 target.

## The principle

**Weaver is asynchronous by default, with synchronous co-play when you
happen to overlap.** Every family member can drop in for stolen idle
moments (15 min in the morning, 5 min between meetings, whatever) and
the world holds. When two or three of you actually sit down together,
the shared play should *increase* richness — not be the only mode that
works.

This means:

- No player is blocked on another being online.
- The world advances when *any* member acts in it.
- When you log in, you catch up on what happened while you were gone —
  but critically, you get **retroactive agency**: *"Lilith went down
  the sewer yesterday. Were you with her?"*

The mode is neither single-player (solo sandbox, no social layer) nor
MMO-style real-time shared (everyone online at once). It's
**campaign-like**: a shared story, per-character threads, periodic
reconvergence.

## The catch-up dialog

When a character logs in after time has passed in the world, they see
a slide-up summary: *"While you were gone…"*

- "Lilith entered **The Sewer Flow** around 3pm Tuesday. Were you
  with her?"
- "Jason opened the **east stairwell door** at exactly 3:44 on
  Tuesday. **Did you see it?**"
- "Gen talked to **Theo** in the break room this morning."

For each group event (threshold TBD — not every option-pick is a
group event, only major beats), the player picks one of:

1. **"I was with them."** — the character retroactively joins that
   thread. Narrative portal: their current location → the event's
   location at event time. Any shared rewards / predicates added.
   `current_location_id` updates to wherever the group ended up.
2. **"I skipped it."** — the character stays on their own path;
   time-based world changes still apply (day advanced, weather
   changed), but the event doesn't touch their state.
3. **"Tell me about it."** — read a short AI summary (Sonnet), no
   state change. Decision deferred; next login re-prompts.

Default selection is `"I was with them"` when it makes narrative sense
(party already together, overlapping schedule) and `"I skipped it"`
otherwise. The player always overrides.

## Events that trigger the prompt

Not every action is a catch-up-worthy event. These are ("major" =
"you'd want to tell your friend about it"):

- Entering a new biome.
- Combat start.
- NPC dialogue with a major_npc or travelling_npc.
- Any effect tagged `{ kind: "emit", event_type: "group_event", ... }`.
- Collecting an item of `kind: orb | quest`.
- Saving a dream to the map (the world grew while you were away).

Authors can tag arbitrary options with `group_event: true` to
explicitly surface them.

## Schema additions

```ts
// New table — append-only log of campaign-level events
campaign_events: defineTable({
  world_id: v.id("worlds"),
  branch_id: v.id("branches"),
  character_id: v.id("characters"),     // who acted
  event_type: v.string(),                // "entered_biome" | "combat_start" | ...
  summary: v.string(),                   // 1-sentence AI-or-authored summary
  world_time_iso: v.string(),            // when, in world-time
  real_time: v.number(),                 // when, in wall-time (for sorting)
  location_entity_id: v.optional(v.id("entities")),
  biome: v.optional(v.string()),
  payload: v.optional(v.any()),          // event-specific extras
})
  .index("by_world_real_time", ["world_id", "real_time"])
  .index("by_world_character", ["world_id", "character_id"]),

// Character gains a cursor
characters.last_caught_up_at: v.optional(v.number()),  // real_time of last acknowledged event
```

## Runtime

1. **Every mutation that matters** appends a `campaign_events` row.
2. On login (or on entering `/play/[world]`): query
   `campaign_events.by_world_real_time` where `real_time >
   character.last_caught_up_at` AND `character_id != me`. Those are
   the "while you were gone" items.
3. Present the catch-up panel inline in the location page (before
   normal choices render).
4. On resolution: apply the "I was with them" effects (portal char,
   merge predicates) or mark skipped; update
   `character.last_caught_up_at` to the last event's `real_time`.

## Resolves / touches

- **UX-02 (shared-branch clock race):** resolved. Clock advances
  whenever any character acts. No races — the writer wins, and later
  readers catch up via campaign events. The clock is monotonic; it
  doesn't "unwind" when a slower player catches up.
- **UX-04 (world clock vs real time on journal):** partially
  resolved. Journal shows world_time_iso prominently (narrative
  timeline); real_time as a small secondary cue for *"when did I
  actually play this?"*.
- **POSTER_CHILD ask 7 (party composition):** cleanly subsumed.
  Party is emergent from catch-up choices, not a separate concept.
  `world.party[]` can still exist as a derived view of "characters
  whose last event was in the same location."

## What this does not do (yet)

- No real-time presence indicator (*"Lilith is online now"*). Can add
  later without breaking the model — it's just a socket + indicator
  on top.
- No in-session chat during overlapping play. Deferred per user
  decision ("we're in the same room").
- No conflict resolution on simultaneous edits to the same location.
  The author model is author-edits-then-commits; simultaneous edits
  last-write-wins. Fine for Wave 2.
- No "invite your friend to come play tonight" push notification.
  Out of scope for Wave 2 — cross-family sharing.

## Interaction with Ask 4 (NPC memory)

NPCs with memory should track group events they witnessed. *"Theo
saw you enter the office Tuesday morning — with Lilith"* is a
meaningful memory fragment. When Ask 4 ships (`spec/24`), its
`record_memory` helper accepts a campaign event as a natural input;
all characters present at the event get the memory.

## UX guardrails

- **Catch-up panel must feel playful, not a chore.** If you missed 12
  events while away, the panel shouldn't be a 12-checkbox form. Group
  events by "adventure" (similar to the journal's clustering) and let
  the player respond per-cluster. Reuse the journal's close-panel
  pattern.
- **"Stolen idle moment" mode:** if the player is signing in for <5
  min, they should be able to skip the whole catch-up with one tap
  and defer all decisions. Their `last_caught_up_at` doesn't advance;
  next real session they pick up.
- **Real-time overlap:** when two characters are online at the same
  time and acting in the same biome, their events still flow through
  the same log, but the catch-up panel doesn't appear — they're
  seeing each other's events inline. (Implementation: if another
  character acted within the last ~30 seconds real-time and is in the
  same biome, suppress the prompt; merge events into the current
  narrative flow.)

## Status

- **Wave 2 target.** Unblocks cleanly after Ask 1 (biome rules)
  ships, because biome-entry is the most natural event trigger.
- Before this spec lands in code, update `spec/01_ARCHITECTURE.md
  §"Multi-player sync"` to reference this doc.
- Design shift captured in `UX_PROPOSALS.md` as **resolving UX-02**.

The model is: *campaign shared, threads individual, reconvergence
retroactive.* That's the thing that makes it fun in 5-minute slices
and on family-LAN night both.
