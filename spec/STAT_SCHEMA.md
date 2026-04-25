# Stat schema — display overlay for canonical stats

**Status:** designed + foundation slice 2026-04-24. Renderer rewire is the third slice. Owner-only admin surface at `/admin/stats/<world_slug>`. No flag — display defaults are safe; absence of a schema means engine defaults apply.

## Why

Worlds want different RPG vocabularies. One family says "HP / Gold / Energy"; another says "wellbeing / coin / stamina"; a third doesn't want numeric stats at all. The engine, meanwhile, needs a fixed contract for modules — combat reads `state.hp`, give_item writes `state.inventory[slug]`. Conflating display labels with engine keys means every module accepts a per-world translation, which is expensive abstraction for a presentation concern.

The split:

- **Canonical layer (`@weaver/engine/stats`).** A frozen set of keys: `HP`, `GOLD`, `ENERGY`, `INVENTORY`. Modules import the constants and read/write directly. The engine knows about these and only these. New modules introduce new canonical keys via the engine, never via worlds.
- **Display overlay (`worlds.stat_schema`).** Per-world JSON config that relabels canonical keys, sets icons/colors/formats, hides individual stats, and adds **display-only custom stats** sourced from arbitrary `state.*` paths. Pure presentation — never read by modules, never affects storage.

The rule for "does this need an override?": **value** changes use `flag.module_overrides` slots, **display** changes use `stat_schema`, **structural** changes use code proposals. Combat never asks "what's the hp key called" because that's never a value question — the key is fixed; only its skin varies.

## Data shape

`worlds.stat_schema: StatSchema | undefined`. Validated at apply time by `convex/stats.ts:sanitizeSchema`.

```ts
type StatSchema = {
  canonical?: Partial<Record<"hp" | "gold" | "energy" | "inventory", StatDisplay>>;
  custom?: CustomStat[];           // display-only; engine never writes
  item_kinds?: Record<string, ItemKindDisplay>;
  inventory_label?: string;        // heading above inventory chips
  preset?: "litrpg" | "standard-fantasy" | "cozy" | "custom";
};

type StatDisplay = {
  label?: string;
  icon?: string;                   // single glyph
  color?: string;                  // CSS color or token name
  format?: "value" | "fraction" | "bar" | "tally";
  max?: number;
  hidden?: boolean;
  order?: number;
};

type CustomStat = {
  key: string;
  source: string;                  // dotted path under character.state
  label: string;
  icon?: string;
  color?: string;
  format?: StatDisplay["format"];
  max?: number;
  hidden?: boolean;
  order?: number;
};
```

## Operations

| | | |
|---|---|---|
| `getStatSchema` | query  | any world member; renderer reads it |
| `suggestStatSchema` | action | owner-only; Opus drafts a schema diff |
| `applyStatSchema` | mutation | owner-only; replaces the schema blob |
| `resetStatSchema` | mutation | owner-only; clears the field, defaults apply |

`suggestStatSchema` reads the world bible + current schema + owner feedback; Opus returns a full proposed schema (not a diff — apply is wholesale). The action sanitizes the response and rejects unknown canonical keys. Cost is logged under `anthropic:opus:stat_schema`.

## Renderer responsibilities

The play page (`/play/<world>/<loc>`) loads `world.stat_schema` and passes it to the inventory-panel snippet. The snippet uses `buildStatTiles(state, schema)` from `@weaver/engine/stats` — one ordered list of tiles to render — instead of hardcoding HP/gold/energy. Same helper powers the admin preview.

`flag.litrpg_stats` stays as the master kill-switch: when off for a world, even non-hidden canonical stats get suppressed. The schema's per-key `hidden: true` is the finer-grained tool for cozy worlds that want some stats but not others.

## What the engine guarantees

- Canonical keys are stable. Renaming `hp` → anything else is an engine-wide breaking change, not a world option.
- Adding a new canonical key (e.g. `mana` for a future spellcasting module) ships with a migration that backfills `0` on existing characters.
- The schema is frozen-vocabulary: `sanitizeSchema` drops any unknown canonical key entries silently. Worlds can't smuggle in an `xp` stat without engine support.

## What the schema is for

- **Localization / theming**: "HP" → "wellbeing", "Gold" → "coin", "Energy" → "stamina"
- **Style direction**: format=`bar` with max=10, color="rose-400" for HP
- **Hiding stats**: cozy world hides hp + gold; only inventory + custom stats remain
- **Custom display tiles**: `{key:"cat_bond", source:"relationships.cat", label:"cat", format:"tally", max:5}` reads `character.state.relationships.cat` and renders it; the engine doesn't manage this value (the world itself does, via game effects authored by the family).

## What the schema is NOT for

- Adding new game mechanics. (Code proposal.)
- Changing combat damage rules. (`flag.module_overrides` slot.)
- Per-character variation. (Per-character state still lives on the character row; schema is per-world.)
- Hiding the inventory entirely. (Set `flag.litrpg_stats=false` and accept that items still render — that's the contract; if a world truly has no carry-anything, suppress in-world via never giving items.)

## Migration / compatibility

Pure additive. Worlds without a schema use the engine defaults — identical to today's behavior. Worlds that adopt a schema and later reset get the defaults back. Switching presets via the admin UI never touches stored values; only labels/colors change.

## Adversarial isolation

Per URGENT rule 7: every mutation has a Playwright test for a non-owner user attempting it. `applyStatSchema` and `resetStatSchema` are world-owner-only. Members can read via `getStatSchema` (the renderer needs it) but not write.
