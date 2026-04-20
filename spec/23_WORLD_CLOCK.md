# Weaver — World Clock

## What this spec does

Formalizes `world.time` — today a scope reference in `02_LOCATION_SCHEMA.md` with no defined structure or ticking model — into a first-class runtime clock with day-of-week, calendar, and per-biome time-dilation. Ask 3 in `backstory/POSTER_CHILD.md`.

Without this, the Daily Grind's inciting mechanic (the east-stairwell-door that only opens Tuesdays between 3:44 and 3:46) cannot be modeled. Every narrative-time-gated option (home-basketball-game sewer access, dawn-only creatures, weekday-only characters) depends on it.

**Status:** **Ask 3 shipped 2026-04-20** in commit `a6985aa`. Shipped shape lives on `branches.state.time` as `{ iso, hhmm, day_of_week, day_counter, week_counter, tick_minutes }` + a sibling `turn: number`. The design below covers the full intent (absolute `epoch_ms` + derived calendar fields like `month` / `season`); the shipped subset covers the Tuesday-3:44 mechanic and is the working foundation. Extend additively as stories demand more of the derived fields.

## The `world.time` shape

```ts
interface WorldTime {
  // Absolute
  epoch_ms: number              // milliseconds since world start
  iso: string                   // ISO-8601 timestamp, UTC; derived from epoch_ms

  // Derived, cached after each tick
  hhmm: string                  // "03:44", "14:07"
  day_counter: number           // 0 = world start, increments on local-midnight crossing
  week_counter: number          // 0 = world start, increments on week-start-day crossing
  day_of_week: "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat"
  month: 1-12
  day_of_month: 1-31
  year: number
  season: "spring" | "summer" | "autumn" | "winter"  // derived from month + hemisphere
}
```

The authoritative field is `epoch_ms`. Everything else is derived and cached for template-condition efficiency (so a condition like `world.time.day_of_week == 'tue'` is a string-eq compare, not a date-math call).

## Bible-frontmatter config

World-level clock parameters live in `bible.md`:

```yaml
world_time:
  start_iso: "2026-04-20T03:40:00Z"    # world day zero
  base_tick_per_turn: "3min"           # advance per player turn, before biome dilation
  week_start: "mon"                    # which day counts as start-of-week
  timezone_display: "America/Denver"   # used when rendering world.time.hhmm to the player
  calendar: "gregorian"                # default; future-proof for fantasy calendars
```

All fields optional. Defaults:
- `start_iso`: time of world creation.
- `base_tick_per_turn`: `"3min"`.
- `week_start`: `"mon"`.
- `timezone_display`: player's browser locale.
- `calendar`: `"gregorian"`.

Fantasy calendars (Discworld-style "Octember 32nd") are a future extension; they'd plug in by swapping the calendar module that computes derived fields from `epoch_ms`.

## Ticking

Time advances on **turn-end** — after the player's action resolves, before the next render. One location transition = one turn. Free-text input that produces no movement (e.g., a failed-classify) does not tick.

### Base tick

`base_tick_ms = parseDuration(bible.world_time.base_tick_per_turn)` — e.g. "3min" → 180000.

### Biome dilation (composes)

```
active_biome = location.biome
dilation = active_biome.rules.time_dilation ?? 1
tick_this_turn_ms = base_tick_ms * dilation
world.time.epoch_ms += tick_this_turn_ms
```

Where `time_dilation` comes from `21_BIOME_RULES.md`.

Examples:
- Quiet Vale (no biome rules): 3 min per turn.
- Office dungeon deep (`time_dilation: 160`): 8 hours per turn.
- Pocket dimension (`time_dilation: 0`): clock frozen.

### Explicit `advance_time` effect

For authored leaps (resting 8 hours, waking next morning):

```yaml
- { kind: advance_time, amount: "8h" }
- { kind: advance_time, until: "next_morning" }
- { kind: advance_time, until: "next_tue_03:44" }
```

Supported forms:
- Absolute duration: `"8h"`, `"45min"`, `"3d"`.
- Named targets: `"next_morning"` (06:00), `"next_evening"` (18:00), `"next_midnight"` (00:00).
- Day-of-week targets: `"next_tue_03:44"`, `"next_mon"` (defaults to 00:00).

`advance_time` bypasses biome dilation — it's the author saying explicitly "we jump forward by X." Biome `on_turn_in_biome` hooks fire once per intervening-turn-boundary, or optionally in a compressed "and here's what happened in that time" summary pass (implementation detail).

## Template conditions

`02_LOCATION_SCHEMA.md` §"Template grammar" gains clock predicates:

```yaml
# String comparisons on derived fields
condition: "world.time.day_of_week == 'tue'"
condition: "world.time.hhmm >= '0344' && world.time.hhmm <= '0346'"

# Numeric comparisons
condition: "world.time.day_counter >= 7"
condition: "world.time.week_counter == 3"

# Compound
condition: "world.time.day_of_week == 'tue' && world.time.hhmm >= '0344' && world.time.hhmm <= '0346'"
```

Time-range comparisons on `hhmm` are lexicographic-string comparisons (hence zero-padded); this is how the 3:44 window gets expressed. A future `world.time.in_range("03:44", "03:46")` helper would be a minor convenience.

## Persistence

`world.time.epoch_ms` persists per `(world_id, branch_id)` — different branches can be at different timestamps. Implementation: a `world_clock` component on the world entity, or an inline field on the `worlds` / `branches` row. Either works; pick one and document.

Recommended: inline on `branches` since branches fork cleanly. Add `branches.time_epoch_ms: v.optional(v.number())`. Fork copies the parent's current `epoch_ms`; thereafter branches tick independently.

## Calendar derivations

The engine ships a clock module that takes `epoch_ms + timezone_display` and produces the derived fields. Standard JS `Date` + a `date-fns`-like helper suffices; no new dependency unless authoring moves to fantasy calendars.

Cost: negligible. Derived fields are computed once per tick (~1ms), cached on the branch row, read from cache for template-condition evaluation.

## Turn counter vs clock

`world.turn_counter` (cumulative turns since world start) is a separate integer that advances every turn regardless of dilation. Useful for seeded RNG and test determinism. Already implicit in the state machine; add explicit field if not already present.

## The Tuesday-3:44 example (complete)

```yaml
# locations/east-stairwell.md
---
name: The East Stairwell
biome: office
neighbors:
  s: the-office-entry
  u: east-stairwell-door
tags: [has_chat]
---

Concrete stairs rising into dimness. A steel door at the top, windowless.
{{#if world.time.day_of_week == 'tue' && world.time.hhmm >= '0344' && world.time.hhmm <= '0346'}}
The door is unlatched.
{{/if}}

## Options

- **Try the door** [if world.time.day_of_week == 'tue' && world.time.hhmm >= '0344' && world.time.hhmm <= '0346'] → east-stairwell-door
- **Try the door** → "It's locked. Solid. You check your phone: not the time."
- **Return to the office** → the-office-entry
```

During play:
1. Player enters the stairwell. The condition evaluates against current `world.time`. If not in the window, the first option is hidden.
2. Player waits (via `advance_time` from options, or by returning next turn and compounding base ticks).
3. When `hhmm` falls in the window on a Tuesday, the option unhides. The player takes it.
4. The door opens; the player transitions to `east-stairwell-door`, a location that only exists narratively behind the Tuesday window.

## Importer validation

- `bible.md` frontmatter `world_time` keys against the shape above.
- `advance_time` effect: `amount` parses as a duration OR `until` parses as a target specifier.
- Template `world.time.*` references are validated against the defined derived fields (typos fail fast).

## Composition with journeys

A journey (see `19_JOURNEYS_AND_JOURNAL.md`) opens and closes based on canonical/draft transitions, not time. But the time at journey-open and journey-close is recorded on the journey row for "you wandered for 8 hours internal" summaries.

Addition to the `journeys` table (future, if the "internal time spent" summary is useful):

```ts
opened_at_epoch_ms: v.number()      // world.time at open
closed_at_epoch_ms: v.optional(v.number())
```

These are distinct from the real-time `opened_at` / `closed_at` that already exist. Not urgent; add when the summary UX demands it.

## Open questions

- **Offline time passage.** If a player closes the game at 03:00 world-time and returns at 19:00 world-time, does time pass in the world while they're gone? **Recommendation: no.** The world ticks on turns, not wall-clock. Players control pacing. If a story needs real-time-has-passed, the author adds an `advance_time` effect on the first location the player re-enters after re-login.
- **Multi-character time drift.** If Mara plays for 5 turns and Jason plays for 10 turns in the same world-branch, whose `world.time.epoch_ms` wins? **Recommendation: the single `world.time.epoch_ms` is shared.** Both characters' actions advance it. Their ordering is explicit: mutations are serialized in Convex. A character entering a location at 04:00 may find another character's state-change from 08:00 already applied — which is fine and intentional (the world moves forward together).
- **Pausing for combat.** When combat is active, should biome dilation apply? **Recommendation: no.** Combat rounds happen in short-real-time; authorial "combat took 30 internal seconds" is an `advance_time` from the combat resolution, not a per-round tick.
- **Timezone display for families across timezones.** `bible.md.timezone_display` defaults to the world-creator's locale; other family members see the same world time rendered in the bible's timezone. This is correct for shared narrative; each player doesn't need "their" local time.
