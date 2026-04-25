# Atlases & maps

**Status:** designed 2026-04-24. Foundation slice (schema + CRUD + flag) ships with this spec; paced-authoring UX is the next slice. Gated behind `flag.atlases` (default off).

## Why

The auto-graph map (radial-tree + biome-cluster layout) is a *navigation aid*, not a creative artifact. It does its job — you can see where places connect — but it doesn't feel like a map. Real fantasy maps are curated: a few big landmarks, suggestive blank space, a coastline that hints at adventure. They're made by hand, slowly, with care.

Atlases are the creative layer. They sit alongside the auto-graph, never replacing it. A world without an atlas is fine. A world with twelve atlases — three by Mom, two by the kid, seven half-finished experiments — is also fine.

## Data shape

```
world
  └─ atlases (N per world; each is an artist's canvas)
       ├─ name, slug, layer_mode, style_anchor, owner_user_id
       └─ map_layers (N per atlas)
            ├─ name, slug, kind, order_index, basemap_blob_hash
            └─ map_placements (N per layer)
                 ├─ entity_id (or null for landmarks not tied to an entity)
                 ├─ custom_label (when entity_id is null)
                 ├─ x, y (freeform) OR grid_col, grid_row
                 ├─ visibility: icon | line | hidden
                 ├─ icon_blob_hash, icon_prompt
                 └─ connection_to_layer_id  (vertical link, e.g. cave entrance)
```

### `atlases` table

- `world_id`, `slug` (unique within world), `name`, `description`
- `layer_mode`: `stack` (vertical, smooth scroll between layers — caves → surface → peaks), `toggle` (semantic overlays — political vs. spiritual), `solo` (one layer only; typical for a hand-drawn single-image map)
- `style_anchor`: free-text style direction for image-gen ("medieval ink-and-watercolor with rough coastlines")
- `placement_mode`: `freeform` (xy in [0..1]^2) or `grid` (col/row in declared dims)
- `grid_cols`, `grid_rows`: only meaningful when placement_mode = grid
- `owner_user_id`: the family member who created it (each atlas is personal; ownership doesn't gate viewing)
- `published`: bool — drafts vs. visible-to-other-family-members. Default false.
- `created_at`, `updated_at`

### `map_layers` table

- `world_id`, `atlas_id`
- `slug` (unique within atlas), `name`, `kind` (`physical | spiritual | political | seasonal | dream | caves | peaks | coast | other`)
- `order_index`: number used by `stack` mode for z-order; ignored otherwise
- `basemap_blob_hash`: optional R2 blob — the painted/generated background image
- `basemap_prompt`: the prompt used to generate the basemap (so re-rolls can iterate)
- `notes`: author-only free text

### `map_placements` table

- `world_id`, `atlas_id`, `layer_id`
- `entity_id` (optional) — if set, the placement is anchored to a real entity (location/biome/character)
- `custom_label` — used when `entity_id` is null; lets the author add purely-decorative landmarks ("Here be dragons", "The Lost Coast")
- `x`, `y` — freeform fractional coords (0..1 along each axis, so basemap resizes don't move things)
- `grid_col`, `grid_row` — grid-mode coords (only when atlas.placement_mode = grid)
- `visibility`: `icon` (renders an icon at xy), `line` (rendered as an unmarked branch curve to a connection_to entity — for "this trail forks here" without cluttering the map), `hidden` (omitted from rendered map; kept in author tooling)
- `icon_blob_hash` — the rendered icon image
- `icon_prompt` — generation prompt for re-rolls
- `icon_style` — sticker | emblem | inkwash | photoreal | flat — picker rather than free text
- `connection_to_entity_slug` — for line-visibility placements; the destination
- `connection_to_layer_slug` — for vertical links (cave-entrance icon on surface that links to the caves layer)
- `created_at`, `updated_at`

### Indexes (rule 1 — every per-world index begins with world_id or branch_id)

- `atlases`: `by_world` (world_id, created_at), `by_world_slug` (world_id, slug)
- `map_layers`: `by_atlas_order` (atlas_id, order_index), `by_world` (world_id)
- `map_placements`: `by_layer` (layer_id), `by_atlas_entity` (atlas_id, entity_id), `by_world` (world_id)

## Authoring (paced card flow — next slice)

Authoring is a five-card flow at `/admin/atlases/<world_slug>/<atlas_slug>`. Each card is small, skippable, and reversible. The atlas is "complete" at every stopping point — you can ship after card 1.

1. **Name + tone.** "What's this map called? What kind?" Sets `name`, `description`, `style_anchor`. Suggests three tone presets ("inked vellum", "watercolor wash", "celestial chart"). Picking one is a one-tap done.
2. **Layers.** "How is the world layered?" Pick `layer_mode` (stack / toggle / solo) and add 1-N layers. Default: one `physical` layer if you're not sure. The author can add caves later.
3. **Landmarks.** "Pick 3-5 places that matter most." Shows entities sorted by visit-count. Tap to add to the canvas; drag to position. AI suggests an icon style per landmark; accept/roll/skip.
4. **Connections.** "What links them?" Shows `option.target` edges as suggestions; author picks which to draw. Style picker: path / road / river / dotted (secret) / none.
5. **Edges.** "Anything beyond the borders?" Optional decorative landmarks (`custom_label` only — no entity). "Here be dragons" energy.

After card 1 the atlas exists and is shareable. After card 3 it's a real map. Cards 4-5 are polish. The UI never gates progress on completeness; the bottom bar says "share this atlas" from card 1 onward.

### What the AI does

- **Suggests icon prompts** per landmark from the entity bible/biome/role tags
- **Generates basemap candidates** for the active layer when the author asks for it (`fal.ai/flux-pro` with the atlas's `style_anchor`)
- **Suggests connections** by reading `option.target` edges and recommending which feel important enough to draw
- **Drafts decorative labels** for "edges" card if the author wants AI inspiration

The AI never *commits* anything — every suggestion is a card the author accepts/rolls/skips. Same posture as bible-edits and module-proposals.

## Viewer

`/atlas/<world_slug>/<atlas_slug>` is the viewer. Renders:

- One layer at a time for `solo` mode
- Vertical scroll-stack for `stack` mode (SVG transform translate-Y between layers; smooth scroll snap)
- Toggle chips for `toggle` mode (multiple overlays composable)

Players pick which atlas they're viewing (per-character preference, mirrors `art_mode_preferred`). No "canonical" — each atlas coexists. The auto-graph stays accessible via the existing map page.

## Image-gen budget

Each atlas can balloon costs if the family rolls icons aggressively. Costs to watch:

- Basemap (per layer): `fal.ai/flux-pro` ~$0.05/gen × N layers × M re-rolls
- Icons: `fal.ai/flux-schnell` cheap (~$0.003/gen) but easy to spam

Mitigation: rate-limit per-atlas to 50 image-gens / day with the existing cost ledger; surface the count on the authoring page.

## What's deferred

- **Atlas templates** (paste-into-world starter atlases). Defer until two worlds want the same shape.
- **Public sharing** between family instances (gallery of atlases across instances). Single-tenant per family for now.
- **Live multi-author editing** — one atlas edited by multiple family members simultaneously. Atlases are personal-by-default; if anyone else opens an atlas they own a fork.
- **Animated transitions** between layers.
- **Vertical link icons** (cave entrance shows on surface layer linking to caves layer) — schema includes the field, viewer renders it later.

## Isolation + security

- All atlases / layers / placements are world-scoped.
- Owner of the world (not owner of the atlas) gates create/delete. Atlas-owner gates rename + style + paced-authoring writes.
- Players who are members of the world can *view* any published atlas. Drafts (published=false) are visible only to the atlas-owner.
- Adversarial Playwright test per URGENT rule 7 covers each new mutation.

## Migration

Pure additive. No existing data touched. Worlds without atlases keep the auto-graph map exactly as-is.
