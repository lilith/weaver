# Weaver — Journeys and Journal

## What this spec replaces

Spec `11_PROMPT_EDITING.md` covers edit-a-thing versioning. The draft
save-to-map UX that originally lived inline on every expanded location
(per notes in the now-amended `04_EXPANSION_LOOP.md`) is superseded by
this doc. **There is no per-location "Save to the map" card anymore.**

## The feeling we're protecting

When a player types *"I climb the chapel tower"* and the world grows to
answer them, that should not immediately demand a decision. The dream
should stay a dream until the player is back on their feet — back at a
canonical place — and then the world gently asks *"keep any of that?"*.

Not every stop in a wander deserves a yes/no prompt. Many dreams are
half-thoughts. Some are glorious. The journal exists so none of them
vanish, even the undecided ones.

## Concepts

**Journey** — a contiguous run of *draft* locations visited by one
character, opened when a canonical location is left for a draft and
closed when the character returns to any canonical location. A character
has at most one open journey at a time.

**Draft location** — an expanded / generated location with
`entities.draft: true`. Visible only to its author. Never appears on
another player's map or in any other player's adjacency graph.

**Journal** — per-character per-world view of all past journeys. Always
accessible from the top nav (`/journal`). Each row represents one
journey with the dreams it contains and their current status.

## Schema

Addition to `convex/schema.ts`:

```ts
journeys: defineTable({
  world_id: v.id("worlds"),
  branch_id: v.id("branches"),
  character_id: v.id("characters"),
  user_id: v.id("users"),
  opened_at: v.number(),
  closed_at: v.optional(v.number()),
  entity_ids: v.array(v.id("entities")),
  entity_slugs: v.array(v.string()),
  status: v.union(
    v.literal("open"),      // in-flight; character on a draft
    v.literal("closed"),    // returned to canonical; awaiting decision
    v.literal("saved"),     // user saved at least one draft from this journey
    v.literal("discarded"), // user explicitly declined to save any
    v.literal("dismissed"), // hidden from journal; drafts still URL-navigable
  ),
  summary: v.optional(v.string()), // AI-generated cluster one-liner
})
  .index("by_world_user", ["world_id", "user_id"])
  .index("by_world_character_status", ["world_id", "character_id", "status"])
```

`entities.draft` and `entities.expanded_from_entity_id` already exist
from the prior save-to-map iteration; they continue to apply.

## State transitions

The function `recordJourneyTransition(ctx, args)` is called from every
mutation that moves a character to a new location (`locations.applyOption`
and `expansion.insertExpandedLocation`).

```
state = (is_dest_draft, has_open_journey)

(true,  false) → open a new journey with dest as entity[0]
(true,  true)  → append dest to journey's entity list (if not the tail)
(false, true)  → close the journey; set status=closed, closed_at=now
(false, false) → no-op
```

Returned value: `{ closed_journey_id: Id<"journeys"> | null }`. Surfaces
to SvelteKit as part of the mutation's result so the next rendered page
can pick up the close-panel data via a short-lived cookie (`weaver_
closed_journey`). One-shot: the cookie is deleted after read.

## Surfaces

### Location page

Whether canonical or draft, looks the same: header + prose + weave
input + choices. The only indicator that a location is a dream is a
candle-glow `✦` glyph in front of the title. No save card. No badge
row. No popover.

### Close panel (on canonical arrival after a journey)

Appears inline between the description and the choices. Contents:

- Heading: *"the way back"* (hand-written font, candle gold).
- Line: *"You wandered through N places. Keep any for the shared map?"*
- Optional AI summary below (one sentence, italic mist-400).
- Checklist of the journey's dreams, each row = `[checkbox] name · biome`.
  Drafts pre-checked; already-saved rows disabled and labeled.
- Two actions:
  - *"✧ keep the checked ones"* — runs `journeys.resolveJourney` with
    the selected slugs.
  - *"ask me later (tuck into journal)"* — runs `journeys.dismissJourney`.

Panel does not appear on every visit after the journey — it's one-shot
via the cookie handoff. Subsequent visits to the same canonical
location will not re-surface it; the player can resolve via `/journal`.

### Journal page (`/journal`)

- World tabs at the top (if the player is a member of multiple).
- Chronological list of journeys (newest first).
- Each journey: count, opened_at, status label, slugs as navigable
  pills, optional summary.
- Per-row: *"save all"* (runs `resolveJourney` with all slugs) and
  *"dismiss"* buttons, shown only while the journey is `open` or
  `closed`.

### Top nav

One extra link: `journal`. Sits next to `worlds`. No icon — the text
is enough.

## Mutations

- `journeys.resolveJourney({ session_token, journey_id, keep_slugs })` —
  for each slug in `keep_slugs`: flip `draft=false`, append an option
  on the parent location (exactly the old `saveToMap` behaviour but
  batched). Set `journey.status` to `saved` (≥1 saved) or `discarded`
  (0 saved). Unknown slugs raise.
- `journeys.dismissJourney({ session_token, journey_id })` — set
  `status=dismissed`. Drafts stay as drafts, just hidden from the
  journal. Still navigable by URL or direct rediscovery.

## Queries

- `journeys.listMineInWorld({ session_token, world_id })` — the
  journal data. Hides dismissed rows.
- `journeys.getJourney({ session_token, journey_id })` — used by the
  close panel and journal detail. Returns journey + dereferenced
  entities (slug, name, biome, draft state).

## Back-fill

`_dev.backfillJourneysFromDrafts` — one-shot: scans every character,
skips any that already have a journey row, otherwise groups all
still-draft entities authored by that user in that branch into one
`closed` journey tagged *"N dreams from before the journal existed."*
Run once after deploying the journeys table; idempotent on re-run.

## AI summary (not yet wired, designed for)

The `summary` field is populated by a Sonnet call over the journey's
dream descriptions. Prompt sketch:

> *Read these N location descriptions in order. Return one sentence
> (≤80 chars) that captures their cluster identity. If they don't
> feel like one coherent path, say so explicitly.*

Cost: ~$0.005 per journey. Kick off asynchronously when a journey
closes or on demand from the journal. Stored in-place on the
`journeys` row; UI renders it when present, gracefully skips when
absent.

## What this does NOT do

- No auto-save based on "visits ≥ N."
- No cross-player exposure of drafts before explicit canonization.
- No time-based GC of drafts. They live until the user dismisses them
  or explicitly deletes them (future).
- No rebuild of the old per-location save card.

## Testing

Existing E2E suite (`apps/play/tests/e2e.spec.ts`) passes with the new
flow unchanged — the journey layer is additive. An explicit journey
test belongs in Wave 1; it would:

1. Seed a fresh character at a canonical safe anchor.
2. Free-text expand → enter draft A.
3. Free-text expand → enter draft B.
4. Pick the "back" option to a canonical slug.
5. Assert the close panel renders with both A and B checked.
6. Submit `save_cluster` with only A.
7. Assert A is canonical (parent has new option), B remains draft.
8. Navigate to `/journal`, assert one row with status `saved`.

## Deployment notes

- Journeys table must exist before the `recordJourneyTransition` calls
  land — done in one commit.
- Back-fill runs once per deployment that introduces this. Safe to
  re-run.
- The `weaver_closed_journey` cookie is set at action time and
  consumed on the next page load. If the user closes the tab between
  action and render, the panel is lost but the journey row remains in
  `closed` state and is visible from `/journal`. Acceptable.
