# UX_PROPOSALS.md — open design questions

Running log of UX tensions I hit while building, where the right call
isn't obvious. Each item is a deferred decision for you, not for me.
Format: **problem** · *how it showed up* · *what I'd do if forced* ·
*proposed decision surface*.

Last updated: *start of Ask 3 work, 2026-04-20*.

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

### UX-02 · Who ticks the clock in a shared world

**Problem.** Clock advances per `applyOption` call. Lilith and Jason
share one branch.state.time. If both are online tonight, whose turn
advances the world? Race on write means the last writer wins; meaning
wall-time passes at 2× (or Nx for N players) inside the world.

*How it showed up.* Realized during clock design — tests are
single-user so this hasn't bitten.

*If forced.* Advance only when the **first** action in a real-wall-time
window happens; cooldown subsequent ticks by N seconds. Or only
advance on location-transition, not every option.

*Decision surface.* (a) naive per-option tick (current) — fine for
solo, weird for shared; (b) debounce: tick once per N wall-seconds
regardless of callers; (c) tick only on location transition; (d) tick
on a global cron independent of actions.

Solo play is fine today. Flag for Wave 3 when shared play is actual.

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
