# Weaver — Item Taxonomy

## What this spec does

Promotes **items** from untyped entities-with-components to a typed taxonomy with a `kind:` discriminator and per-kind schemas. Ask 2 in `backstory/POSTER_CHILD.md`.

Today: an item is an entity with arbitrary components. `give_item` / `take_item` / `character.inventory` moves them around. No consumables, no gear slots, no orb economy.

Proposed: items gain a `kind:` field and per-kind-schema behavior so things like "crack an orb to gain a skill" or "use a consumable for +1 HP" are **data**, not **module code**.

**Status:** Wave 2 target. Not shipped. Additive — items without `kind:` default to `misc` and behave as today.

## The `kind:` discriminator

```
kind: consumable | gear | key | orb | quest | material | misc
```

- **consumable** — single-use or charge-based. Drinks, snacks, candy, a roll of scotch tape.
- **gear** — wearable/wieldable with slot + combat stats. Crowbar, jacket, skulljack.
- **key** — gates a location or option. Door key, keycard, password.
- **orb** — LitRPG skill-orb. Crack for instant stat, absorb for bigger transformation.
- **quest** — narrative-significant, cannot be dropped. Photograph, letter, audiotape.
- **material** — raw input to some future crafting system. Copper wire, magnesium.
- **misc** — everything else. Default if `kind:` omitted.

Unknown `kind:` values are treated as `misc` with a warning logged.

## Per-kind schemas

Each kind adds a nested block with that name. Non-kind fields (name, description, tags, etc.) are shared across all kinds.

### `kind: misc` (default)

```yaml
---
name: A button
kind: misc              # or omitted
stackable: true
description: "A small brass button, slightly tarnished. It came off something."
---

Body becomes the long description (optional).
```

Equivalent to today's item shape. No behavior other than being takeable / droppable / depictable.

### `kind: consumable`

```yaml
---
name: Baby Things candy
kind: consumable
stackable: true
consumable:
  charges: 1
  on_use:
    - { kind: inc, path: character.hp, by: 1 }
    - { kind: say, text: "It tastes like nostalgia in a frightening way." }
  consumes_self: true         # default; drop from inventory after last charge
description: >
  A small pack of generic brand candy. The wrapper claims it tastes like "baby
  things." It mostly tastes like sugar and fear.
---
```

Using the item (via an `on_use` effect or a UI "use" action) applies the listed effects. `charges > 1` decrements per use; `consumes_self` drops the item when charges hit 0.

### `kind: gear`

```yaml
---
name: Crowbar
kind: gear
stackable: false
gear:
  slot: primary_weapon        # primary_weapon | secondary_weapon | head | body | hands | feet | accessory1 | accessory2
  combat:
    damage: "1d6 + 2"
    damage_kind: physical
  on_equip:
    - { kind: say, text: "Heavier than it looks. The rubber grip is scored from some previous owner." }
  on_unequip: []
description: >
  A 3-foot steel crowbar, scarred from use. Opens doors, closes arguments.
---
```

Slots enforce one-equip-per-slot. `combat.*` hooks into the combat system (see `25_COMBAT.md`). `damage` follows the dice-notation grammar from `02_LOCATION_SCHEMA.md` §"Template grammar."

### `kind: key`

```yaml
---
name: Fort Door keycard
kind: key
stackable: false
key:
  unlocks: [fort-door, fort-door-inner, break-room-closet]  # location slugs
description: >
  A worn magnetic-stripe card with a hand-drawn "FD" in sharpie. Whoever
  had it before you was in the habit of whistling.
---
```

When a location option has `condition: "character.inventory.has_key('fort-door')"`, the runtime checks against any key in the player's inventory whose `key.unlocks` array contains that slug. Multiple keys can unlock the same location (spare keys, master keys, etc.).

### `kind: orb`

```yaml
---
name: Yellow skill orb
slug: skill-orb-yellow-small
kind: orb
stackable: true
orb:
  color: yellow
  size: 1                           # 1 (fingernail) to 4 (bowling-ball)
  on_crack:
    - { kind: narrate, prompt: "James cracks a yellow orb. Narrate the sensation of a small, specific skill arriving. Pick a skill that fits the moment." }
    - { kind: inc, path: "character.skills.random_yellow", by: "orb.size" }
  on_absorb:
    - { kind: emit, event_type: orb_absorbed, payload: { color: yellow, size: "orb.size" } }
    - { kind: add_predicate, predicate: has_absorbed_yellow, object_id: self }
    - { kind: narrate, prompt: "A yellow orb dissolves into James. The skill it grants is small but permanent. Describe the internal shift." }
description: >
  A soft, slightly-warm sphere of pale gold light. You can feel it pulse if
  you hold it long enough.
---
```

Orbs support two player actions: **crack** (immediate flat effect + narration) and **absorb** (slower, slower stacking, bigger narrative). The two paths have different `on_*` effect lists. `orb.size` is referenced via template-expression in effects as `"orb.size"` (evaluated at use-time from the specific item instance).

The `color` + `size` shape lets a single authored "template" orb file represent many instance-sizes by authoring 6 colors × 4 sizes = 24 concrete orb files, OR by treating the orb as a template and having an `on_spawn` effect populate `size` randomly. Author's choice.

### `kind: quest`

```yaml
---
name: Sarah's audiotape
kind: quest
stackable: false
quest:
  droppable: false
  associated_thread: "sarah-mystery"   # free-form tag for mentorship-log / journal filtering
  on_examine:
    - { kind: emit, event_type: quest_tape_examined }
    - { kind: narrate, prompt: "Describe the tape's physical state and the label's writing. Do not reveal content until played." }
description: >
  A cassette tape labeled in a hand James doesn't recognize. The reels click
  softly when you shake it.
---
```

Quest items are narrative-significant. `droppable: false` prevents accidental loss. `on_examine` fires when the player examines the item in inventory (separate from any "use" or "equip" action).

### `kind: material`

Deferred. Included in the enum for forward-compat; concrete schema lands when crafting lands. For now, items tagged `kind: material` behave as `misc` with a `material: { tag: "copper-wire" }` hint in their frontmatter for future use.

## Effect additions

Two new effect kinds land with this spec:

### `narrate` effect

```yaml
{ kind: narrate, prompt: "James cracks a yellow orb. Narrate the sensation of a small, specific skill arriving." }
```

Queues a Sonnet call with the named prompt + shared narrative context (see `24_NPC_AND_NARRATIVE_PROMPTS.md` for the assembler). Result is appended to the scene narration. Cached by prompt + seed derived from `(world, branch, flow, effect_label)` so re-runs are stable.

Cost per narrate: ~$0.002-0.005 depending on context size. Cheap.

### `add_predicate` effect

Already in `02_LOCATION_SCHEMA.md`; extended: `object_id: self` means "the current item's entity_id." Resolves at dispatch time.

## Inventory model

Character state's `inventory` is a map: `{ slug: count }` for stackable items, `{ slug: instance_id }` for non-stackable. Example:

```json
"character.inventory": {
  "skill-orb-yellow-small": 3,
  "baby-things-candy": 5,
  "crowbar": { "instance_id": "eQ1abc", "equipped": true }
}
```

Equipped gear tracks the instance for per-item damage/condition state later. Stackables don't need instance tracking — they're fungible.

## UI surfaces (Wave 2)

- **Inventory panel** — bottom-slide drawer on mobile, sidebar on desktop. Groups by `kind:`. Shows count for stackables, equip-state for gear.
- **Use action** — tap an item → context menu. Options depend on kind: use (consumable), equip (gear), examine (quest), crack/absorb (orb), drop (any non-quest).
- **Orb drawer** — special view grouping orbs by color + size. "You have 3 yellow-small, 2 yellow-med, 1 red-big. Crack yellow-small? Absorb red-big?"

## Importer validation

The world importer (today's `scripts/import-world.mjs`, future `weaver validate` CLI) validates items per kind:

- `kind:` must be in the enum or omitted (→ `misc`).
- Per-kind required fields present (e.g. `gear.slot` for `kind: gear`, `consumable.on_use` for `kind: consumable`).
- Effect arrays parse against the effect schema.
- `key.unlocks[]` slugs resolve to existing locations.
- `orb.color` is a string; `orb.size` is an integer 1-4.

Errors block import in `--mode=new`; warnings in `--mode=edit`.

## Migration

Existing Quiet Vale has no items authored yet. When items are added, they can be `kind: misc` or any of the new kinds. No backfill concerns.

For the incoming Daily Grind / The Office import (see `backstory/index.md` §P1), items land all at once: ~18 orbs (6 colors × 3 sizes), ~5 gear pieces, ~5 consumables, ~3 quest items.

## What this enables

- **LitRPG progression** without per-orb module code. 30 orbs = 30 YAML files, not 30 code paths.
- **Consumable economy** — baby-things-candy for 1 HP, coffee for +1 action — as author-tweakable data.
- **Gear slots** that gate options: "needs primary weapon equipped" conditions work naturally.
- **Quest items** that can't be accidentally dropped / sold.
- **Unlock rules** simplified: `character.inventory.has_key('fort-door')` instead of per-location flag-tracking.

## Dependencies

- `25_COMBAT.md` — gear combat stats and damage kinds plug in here.
- `24_NPC_AND_NARRATIVE_PROMPTS.md` — `narrate` effect consumes the shared prompt assembler.

## Open questions

- **Gear durability.** Today: none. A future `gear.durability: { max, current, on_break }` can land additively when (if) combat surfaces item wear.
- **Orb skill trees.** POSTER_CHILD explicitly opts out ("The surface is flat + broad"). If it ever returns: `orb.skill_tree: ...` with branch/leaf slugs.
- **Crafting.** `kind: material` is a hook for future crafting; concrete schema deferred until a crafting use-case demands it. Probably never for family scale.
- **Item blobs.** Item description images are small; probably inline blobs, no R2. Verify before batch-importing Daily Grind's 25-ish items.
