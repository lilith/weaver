// Atlases — creative-layer maps per spec/ATLASES_AND_MAPS.md.
//
// Coexists with the auto-graph; never replaces it. Each atlas is one
// artist's canvas (a family member's interpretation). Multiple atlases
// per world is normal; layers within an atlas can be vertical-stack
// (caves → surface → peaks) or semantic toggles (political, spiritual,
// dream).
//
// Permission model:
//   - World owner gates atlas creation + deletion.
//   - Atlas owner gates rename / style / placement writes within their atlas.
//   - All world members may *view* published atlases. Drafts are visible
//     only to the atlas owner.
//
// Isolation: every index begins with world_id. Mutations resolve
// world_slug → world and check membership; atlas-scoped writes also
// verify atlas.owner_user_id (or fall through to world-owner override).

import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import { resolveMember } from "./sessions.js";
import type { Doc, Id } from "./_generated/dataModel.js";

const LAYER_MODES = ["stack", "toggle", "solo"] as const;
const PLACEMENT_MODES = ["freeform", "grid"] as const;
const PLACEMENT_VISIBILITIES = ["icon", "line", "hidden"] as const;
// Layer kinds are open-set ("other" is fine), but these get nice
// defaults in the UI.
const KNOWN_LAYER_KINDS = [
  "physical",
  "spiritual",
  "political",
  "seasonal",
  "dream",
  "caves",
  "peaks",
  "coast",
  "other",
];

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return base.length > 0 ? base : "atlas";
}

async function loadWorldByOwner(
  ctx: any,
  session_token: string,
  world_slug: string,
): Promise<{ world: Doc<"worlds">; user_id: Id<"users"> }> {
  const world = (await ctx.db
    .query("worlds")
    .withIndex("by_slug", (q: any) => q.eq("slug", world_slug))
    .first()) as Doc<"worlds"> | null;
  if (!world) throw new Error(`world not found: ${world_slug}`);
  const { user_id } = await resolveMember(ctx, session_token, world._id);
  if (world.owner_user_id !== user_id)
    throw new Error("forbidden: world-owner-only operation");
  return { world, user_id };
}

async function loadWorldAsMember(
  ctx: any,
  session_token: string,
  world_slug: string,
): Promise<{ world: Doc<"worlds">; user_id: Id<"users"> }> {
  const world = (await ctx.db
    .query("worlds")
    .withIndex("by_slug", (q: any) => q.eq("slug", world_slug))
    .first()) as Doc<"worlds"> | null;
  if (!world) throw new Error(`world not found: ${world_slug}`);
  const { user_id } = await resolveMember(ctx, session_token, world._id);
  return { world, user_id };
}

/** Resolve an atlas + verify the caller may write to it. World owners
 *  always may; atlas owners may write to their own. Others throw. */
async function loadAtlasAsWriter(
  ctx: any,
  session_token: string,
  world_slug: string,
  atlas_slug: string,
): Promise<{
  world: Doc<"worlds">;
  atlas: Doc<"atlases">;
  user_id: Id<"users">;
}> {
  const { world, user_id } = await loadWorldAsMember(
    ctx,
    session_token,
    world_slug,
  );
  const atlas = (await ctx.db
    .query("atlases")
    .withIndex("by_world_slug", (q: any) =>
      q.eq("world_id", world._id).eq("slug", atlas_slug),
    )
    .first()) as Doc<"atlases"> | null;
  if (!atlas) throw new Error(`atlas not found: ${atlas_slug}`);
  if (
    atlas.owner_user_id !== user_id &&
    world.owner_user_id !== user_id
  ) {
    throw new Error(
      "forbidden: only the atlas owner or the world owner may edit this atlas",
    );
  }
  return { world, atlas, user_id };
}

// --------------------------------------------------------------------
// Queries

/** List atlases for a world. Members see their own drafts + every
 *  published atlas; non-members get a forbidden error from
 *  resolveMember. */
export const listAtlasesForWorld = query({
  args: { session_token: v.string(), world_slug: v.string() },
  handler: async (ctx, { session_token, world_slug }) => {
    const { world, user_id } = await loadWorldAsMember(
      ctx,
      session_token,
      world_slug,
    );
    const rows = (await ctx.db
      .query("atlases")
      .withIndex("by_world", (q: any) => q.eq("world_id", world._id))
      .collect()) as Doc<"atlases">[];
    rows.sort((a, b) => b.created_at - a.created_at);
    return rows
      .filter(
        (a) =>
          a.published ||
          a.owner_user_id === user_id ||
          world.owner_user_id === user_id,
      )
      .map((a) => ({
        _id: a._id,
        slug: a.slug,
        name: a.name,
        description: a.description ?? null,
        layer_mode: a.layer_mode,
        style_anchor: a.style_anchor ?? null,
        placement_mode: a.placement_mode,
        owner_user_id: a.owner_user_id,
        is_mine: a.owner_user_id === user_id,
        published: a.published,
        created_at: a.created_at,
        updated_at: a.updated_at,
      }));
  },
});

/** Full atlas detail — atlas row + ordered layers + placements per
 *  layer. The viewer renders directly from this; one round-trip. */
export const getAtlas = query({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    atlas_slug: v.string(),
  },
  handler: async (ctx, { session_token, world_slug, atlas_slug }) => {
    const { world, user_id } = await loadWorldAsMember(
      ctx,
      session_token,
      world_slug,
    );
    const atlas = (await ctx.db
      .query("atlases")
      .withIndex("by_world_slug", (q: any) =>
        q.eq("world_id", world._id).eq("slug", atlas_slug),
      )
      .first()) as Doc<"atlases"> | null;
    if (!atlas) return null;
    // Drafts are author-only — except world owners, who can see every
    // draft in their world (matches the edit gate in loadAtlasAsWriter).
    if (
      !atlas.published &&
      atlas.owner_user_id !== user_id &&
      world.owner_user_id !== user_id
    )
      return null;
    const layers = (await ctx.db
      .query("map_layers")
      .withIndex("by_atlas_order", (q: any) => q.eq("atlas_id", atlas._id))
      .collect()) as Doc<"map_layers">[];
    layers.sort((a, b) => a.order_index - b.order_index);
    const placementsByLayer: Record<string, Doc<"map_placements">[]> = {};
    for (const layer of layers) {
      const ps = (await ctx.db
        .query("map_placements")
        .withIndex("by_layer", (q: any) => q.eq("layer_id", layer._id))
        .collect()) as Doc<"map_placements">[];
      placementsByLayer[String(layer._id)] = ps;
    }
    return {
      atlas: {
        _id: atlas._id,
        slug: atlas.slug,
        name: atlas.name,
        description: atlas.description ?? null,
        layer_mode: atlas.layer_mode,
        style_anchor: atlas.style_anchor ?? null,
        placement_mode: atlas.placement_mode,
        grid_cols: atlas.grid_cols ?? null,
        grid_rows: atlas.grid_rows ?? null,
        owner_user_id: atlas.owner_user_id,
        is_mine: atlas.owner_user_id === user_id,
        published: atlas.published,
      },
      layers: layers.map((l) => ({
        _id: l._id,
        slug: l.slug,
        name: l.name,
        kind: l.kind,
        order_index: l.order_index,
        basemap_blob_hash: l.basemap_blob_hash ?? null,
        basemap_prompt: l.basemap_prompt ?? null,
        notes: l.notes ?? null,
      })),
      placements: Object.fromEntries(
        Object.entries(placementsByLayer).map(([k, ps]) => [
          k,
          ps.map((p) => ({
            _id: p._id,
            entity_id: p.entity_id ?? null,
            custom_label: p.custom_label ?? null,
            x: p.x ?? null,
            y: p.y ?? null,
            grid_col: p.grid_col ?? null,
            grid_row: p.grid_row ?? null,
            visibility: p.visibility,
            icon_blob_hash: p.icon_blob_hash ?? null,
            icon_prompt: p.icon_prompt ?? null,
            icon_style: p.icon_style ?? null,
            connection_to_entity_slug: p.connection_to_entity_slug ?? null,
            connection_to_layer_slug: p.connection_to_layer_slug ?? null,
          })),
        ]),
      ),
    };
  },
});

// --------------------------------------------------------------------
// Mutations — atlas

export const createAtlas = mutation({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    layer_mode: v.optional(v.string()),
    placement_mode: v.optional(v.string()),
    style_anchor: v.optional(v.string()),
    grid_cols: v.optional(v.number()),
    grid_rows: v.optional(v.number()),
    // Atlas creation is open to any world member, not just owner —
    // each family member gets their own canvas. Owner-only delete keeps
    // a guardrail.
  },
  handler: async (
    ctx,
    {
      session_token,
      world_slug,
      name,
      description,
      layer_mode,
      placement_mode,
      style_anchor,
      grid_cols,
      grid_rows,
    },
  ) => {
    const trimmedName = name.trim();
    if (trimmedName.length < 1 || trimmedName.length > 80)
      throw new Error("name must be 1..80 chars");
    const lm = layer_mode ?? "solo";
    if (!LAYER_MODES.includes(lm as any))
      throw new Error(`layer_mode must be one of ${LAYER_MODES.join("|")}`);
    const pm = placement_mode ?? "freeform";
    if (!PLACEMENT_MODES.includes(pm as any))
      throw new Error(
        `placement_mode must be one of ${PLACEMENT_MODES.join("|")}`,
      );
    if (pm === "grid") {
      if (!grid_cols || grid_cols < 2 || grid_cols > 64)
        throw new Error("grid_cols must be 2..64 when placement_mode=grid");
      if (!grid_rows || grid_rows < 2 || grid_rows > 64)
        throw new Error("grid_rows must be 2..64 when placement_mode=grid");
    }
    const { world, user_id } = await loadWorldAsMember(
      ctx,
      session_token,
      world_slug,
    );

    // Pick a unique slug within the world.
    const base = slugify(trimmedName);
    let slug = base;
    let n = 1;
    while (true) {
      const collision = await ctx.db
        .query("atlases")
        .withIndex("by_world_slug", (q: any) =>
          q.eq("world_id", world._id).eq("slug", slug),
        )
        .first();
      if (!collision) break;
      n += 1;
      slug = `${base}-${n}`;
      if (n > 50) throw new Error("could not find a free atlas slug");
    }

    const now = Date.now();
    const atlas_id = await ctx.db.insert("atlases", {
      world_id: world._id,
      slug,
      name: trimmedName,
      description: description?.slice(0, 1000),
      layer_mode: lm as any,
      placement_mode: pm as any,
      style_anchor: style_anchor?.slice(0, 500),
      grid_cols: pm === "grid" ? grid_cols : undefined,
      grid_rows: pm === "grid" ? grid_rows : undefined,
      owner_user_id: user_id,
      published: false,
      created_at: now,
      updated_at: now,
    });

    // Seed a default "physical" layer so the atlas is non-empty.
    await ctx.db.insert("map_layers", {
      world_id: world._id,
      atlas_id,
      slug: "physical",
      name: "Physical",
      kind: "physical",
      order_index: 0,
      created_at: now,
      updated_at: now,
    });

    return { atlas_id, slug, world_id: world._id };
  },
});

export const renameAtlas = mutation({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    atlas_slug: v.string(),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    style_anchor: v.optional(v.string()),
    layer_mode: v.optional(v.string()),
    placement_mode: v.optional(v.string()),
    grid_cols: v.optional(v.number()),
    grid_rows: v.optional(v.number()),
    published: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { atlas } = await loadAtlasAsWriter(
      ctx,
      args.session_token,
      args.world_slug,
      args.atlas_slug,
    );
    const patch: Record<string, unknown> = { updated_at: Date.now() };
    if (args.name !== undefined) {
      const t = args.name.trim();
      if (t.length < 1 || t.length > 80)
        throw new Error("name must be 1..80 chars");
      patch.name = t;
    }
    if (args.description !== undefined)
      patch.description = args.description.slice(0, 1000);
    if (args.style_anchor !== undefined)
      patch.style_anchor = args.style_anchor.slice(0, 500);
    if (args.layer_mode !== undefined) {
      if (!LAYER_MODES.includes(args.layer_mode as any))
        throw new Error(
          `layer_mode must be one of ${LAYER_MODES.join("|")}`,
        );
      patch.layer_mode = args.layer_mode;
    }
    if (args.placement_mode !== undefined) {
      if (!PLACEMENT_MODES.includes(args.placement_mode as any))
        throw new Error(
          `placement_mode must be one of ${PLACEMENT_MODES.join("|")}`,
        );
      patch.placement_mode = args.placement_mode;
    }
    if (args.grid_cols !== undefined) patch.grid_cols = args.grid_cols;
    if (args.grid_rows !== undefined) patch.grid_rows = args.grid_rows;
    if (args.published !== undefined) patch.published = args.published;
    await ctx.db.patch(atlas._id, patch);
    return { ok: true };
  },
});

/** Delete an atlas + cascade its layers + placements. World-owner-only,
 *  per the spec ("guardrail" rule); atlas-owner can dismiss draft
 *  status by toggling `published=false`. */
export const deleteAtlas = mutation({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    atlas_slug: v.string(),
  },
  handler: async (ctx, { session_token, world_slug, atlas_slug }) => {
    const { world } = await loadWorldByOwner(ctx, session_token, world_slug);
    const atlas = (await ctx.db
      .query("atlases")
      .withIndex("by_world_slug", (q: any) =>
        q.eq("world_id", world._id).eq("slug", atlas_slug),
      )
      .first()) as Doc<"atlases"> | null;
    if (!atlas) return { ok: true, deleted: 0 };
    const layers = await ctx.db
      .query("map_layers")
      .withIndex("by_atlas_order", (q: any) => q.eq("atlas_id", atlas._id))
      .collect();
    for (const l of layers) {
      const placements = await ctx.db
        .query("map_placements")
        .withIndex("by_layer", (q: any) => q.eq("layer_id", l._id))
        .collect();
      for (const p of placements) await ctx.db.delete(p._id);
      await ctx.db.delete(l._id);
    }
    await ctx.db.delete(atlas._id);
    return {
      ok: true,
      deleted: 1 + layers.length /* placements counted but not summed */,
    };
  },
});

// --------------------------------------------------------------------
// Mutations — layers

export const addLayer = mutation({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    atlas_slug: v.string(),
    name: v.string(),
    kind: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const trimmed = args.name.trim();
    if (trimmed.length < 1 || trimmed.length > 80)
      throw new Error("layer name must be 1..80 chars");
    const kind = (args.kind ?? "other").toLowerCase();
    const { world, atlas } = await loadAtlasAsWriter(
      ctx,
      args.session_token,
      args.world_slug,
      args.atlas_slug,
    );
    // Slug unique within atlas.
    const base = slugify(trimmed);
    let slug = base;
    let n = 1;
    while (true) {
      const collision = await ctx.db
        .query("map_layers")
        .withIndex("by_atlas_slug", (q: any) =>
          q.eq("atlas_id", atlas._id).eq("slug", slug),
        )
        .first();
      if (!collision) break;
      n += 1;
      slug = `${base}-${n}`;
      if (n > 50) throw new Error("could not find a free layer slug");
    }
    const existing = await ctx.db
      .query("map_layers")
      .withIndex("by_atlas_order", (q: any) => q.eq("atlas_id", atlas._id))
      .collect();
    const order_index =
      existing.reduce((m, l: any) => Math.max(m, l.order_index), -1) + 1;
    const now = Date.now();
    const layer_id = await ctx.db.insert("map_layers", {
      world_id: world._id,
      atlas_id: atlas._id,
      slug,
      name: trimmed,
      kind,
      order_index,
      notes: args.notes?.slice(0, 1000),
      created_at: now,
      updated_at: now,
    });
    return { layer_id, slug };
  },
});

export const updateLayer = mutation({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    atlas_slug: v.string(),
    layer_slug: v.string(),
    name: v.optional(v.string()),
    kind: v.optional(v.string()),
    notes: v.optional(v.string()),
    basemap_blob_hash: v.optional(v.string()),
    basemap_prompt: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { atlas } = await loadAtlasAsWriter(
      ctx,
      args.session_token,
      args.world_slug,
      args.atlas_slug,
    );
    const layer = await ctx.db
      .query("map_layers")
      .withIndex("by_atlas_slug", (q: any) =>
        q.eq("atlas_id", atlas._id).eq("slug", args.layer_slug),
      )
      .first();
    if (!layer) throw new Error(`layer not found: ${args.layer_slug}`);
    const patch: Record<string, unknown> = { updated_at: Date.now() };
    if (args.name !== undefined) {
      const t = args.name.trim();
      if (t.length < 1 || t.length > 80)
        throw new Error("layer name must be 1..80 chars");
      patch.name = t;
    }
    if (args.kind !== undefined) patch.kind = args.kind.toLowerCase();
    if (args.notes !== undefined) patch.notes = args.notes.slice(0, 1000);
    if (args.basemap_blob_hash !== undefined)
      patch.basemap_blob_hash = args.basemap_blob_hash;
    if (args.basemap_prompt !== undefined)
      patch.basemap_prompt = args.basemap_prompt.slice(0, 1500);
    await ctx.db.patch(layer._id, patch);
    return { ok: true };
  },
});

export const reorderLayers = mutation({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    atlas_slug: v.string(),
    layer_slugs: v.array(v.string()), // new order, top-to-bottom
  },
  handler: async (ctx, args) => {
    const { atlas } = await loadAtlasAsWriter(
      ctx,
      args.session_token,
      args.world_slug,
      args.atlas_slug,
    );
    const existing = await ctx.db
      .query("map_layers")
      .withIndex("by_atlas_order", (q: any) => q.eq("atlas_id", atlas._id))
      .collect();
    const bySlug = new Map(existing.map((l: any) => [l.slug, l]));
    if (args.layer_slugs.length !== existing.length) {
      throw new Error(
        `reorder requires every layer slug; got ${args.layer_slugs.length}, expected ${existing.length}`,
      );
    }
    const now = Date.now();
    for (let i = 0; i < args.layer_slugs.length; i++) {
      const layer = bySlug.get(args.layer_slugs[i]);
      if (!layer)
        throw new Error(
          `unknown layer slug in reorder: ${args.layer_slugs[i]}`,
        );
      await ctx.db.patch(layer._id, { order_index: i, updated_at: now });
    }
    return { ok: true };
  },
});

export const deleteLayer = mutation({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    atlas_slug: v.string(),
    layer_slug: v.string(),
  },
  handler: async (ctx, args) => {
    const { atlas } = await loadAtlasAsWriter(
      ctx,
      args.session_token,
      args.world_slug,
      args.atlas_slug,
    );
    const layer = await ctx.db
      .query("map_layers")
      .withIndex("by_atlas_slug", (q: any) =>
        q.eq("atlas_id", atlas._id).eq("slug", args.layer_slug),
      )
      .first();
    if (!layer) return { ok: true, deleted: 0 };
    const placements = await ctx.db
      .query("map_placements")
      .withIndex("by_layer", (q: any) => q.eq("layer_id", layer._id))
      .collect();
    for (const p of placements) await ctx.db.delete(p._id);
    await ctx.db.delete(layer._id);
    return { ok: true, deleted: 1, placements_removed: placements.length };
  },
});

// --------------------------------------------------------------------
// Mutations — placements

export const putPlacement = mutation({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    atlas_slug: v.string(),
    layer_slug: v.string(),
    // Either an entity_slug (looked up to entity_id) or a custom_label.
    entity_slug: v.optional(v.string()),
    custom_label: v.optional(v.string()),
    x: v.optional(v.number()),
    y: v.optional(v.number()),
    grid_col: v.optional(v.number()),
    grid_row: v.optional(v.number()),
    visibility: v.optional(v.string()),
    icon_style: v.optional(v.string()),
    icon_prompt: v.optional(v.string()),
    connection_to_entity_slug: v.optional(v.string()),
    connection_to_layer_slug: v.optional(v.string()),
    // If provided, replace the existing placement with this id; otherwise insert.
    placement_id: v.optional(v.id("map_placements")),
  },
  handler: async (ctx, args) => {
    const { world, atlas } = await loadAtlasAsWriter(
      ctx,
      args.session_token,
      args.world_slug,
      args.atlas_slug,
    );
    const layer = await ctx.db
      .query("map_layers")
      .withIndex("by_atlas_slug", (q: any) =>
        q.eq("atlas_id", atlas._id).eq("slug", args.layer_slug),
      )
      .first();
    if (!layer) throw new Error(`layer not found: ${args.layer_slug}`);
    if (!args.entity_slug && !args.custom_label) {
      throw new Error("either entity_slug or custom_label is required");
    }
    let entity_id: Id<"entities"> | undefined;
    if (args.entity_slug) {
      // Resolve entity_slug → entity_id within this world's current branch.
      if (!world.current_branch_id)
        throw new Error("world has no current branch");
      // Search across common types — any entity with this slug in the
      // world's branch is fair game (locations, biomes, characters,
      // npcs, items). Tied to current_branch_id by index.
      const types = ["location", "biome", "character", "npc", "item"];
      for (const t of types) {
        const e = await ctx.db
          .query("entities")
          .withIndex("by_branch_type_slug", (q: any) =>
            q
              .eq("branch_id", world.current_branch_id)
              .eq("type", t)
              .eq("slug", args.entity_slug),
          )
          .first();
        if (e) {
          entity_id = e._id;
          break;
        }
      }
      if (!entity_id)
        throw new Error(`entity not found in world: ${args.entity_slug}`);
    }
    const visibility = (args.visibility ?? "icon") as any;
    if (!PLACEMENT_VISIBILITIES.includes(visibility)) {
      throw new Error(
        `visibility must be one of ${PLACEMENT_VISIBILITIES.join("|")}`,
      );
    }
    // Coord validation.
    if (atlas.placement_mode === "freeform") {
      const x = args.x;
      const y = args.y;
      if (visibility !== "hidden") {
        if (x === undefined || y === undefined)
          throw new Error("freeform placements need x + y");
        if (x < 0 || x > 1 || y < 0 || y > 1)
          throw new Error("x and y must be in [0..1]");
      }
    } else if (atlas.placement_mode === "grid") {
      if (visibility !== "hidden") {
        if (args.grid_col === undefined || args.grid_row === undefined)
          throw new Error("grid placements need grid_col + grid_row");
        if (
          args.grid_col < 0 ||
          args.grid_col >= (atlas.grid_cols ?? 0) ||
          args.grid_row < 0 ||
          args.grid_row >= (atlas.grid_rows ?? 0)
        )
          throw new Error("grid_col / grid_row out of bounds");
      }
    }

    const now = Date.now();
    const payload = {
      world_id: world._id,
      atlas_id: atlas._id,
      layer_id: layer._id,
      entity_id,
      custom_label: args.custom_label?.slice(0, 200),
      x: args.x,
      y: args.y,
      grid_col: args.grid_col,
      grid_row: args.grid_row,
      visibility,
      icon_style: args.icon_style?.slice(0, 40),
      icon_prompt: args.icon_prompt?.slice(0, 1500),
      connection_to_entity_slug: args.connection_to_entity_slug?.slice(0, 80),
      connection_to_layer_slug: args.connection_to_layer_slug?.slice(0, 80),
      updated_at: now,
    };

    if (args.placement_id) {
      const existing = await ctx.db.get(args.placement_id);
      if (!existing) throw new Error("placement not found");
      if (existing.atlas_id !== atlas._id)
        throw new Error("forbidden: placement belongs to another atlas");
      await ctx.db.patch(args.placement_id, payload);
      return { placement_id: args.placement_id };
    }
    const placement_id = await ctx.db.insert("map_placements", {
      ...payload,
      created_at: now,
    });
    return { placement_id };
  },
});

export const removePlacement = mutation({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    atlas_slug: v.string(),
    placement_id: v.id("map_placements"),
  },
  handler: async (ctx, args) => {
    const { atlas } = await loadAtlasAsWriter(
      ctx,
      args.session_token,
      args.world_slug,
      args.atlas_slug,
    );
    const placement = await ctx.db.get(args.placement_id);
    if (!placement) return { ok: true };
    if (placement.atlas_id !== atlas._id)
      throw new Error("forbidden: placement belongs to another atlas");
    await ctx.db.delete(args.placement_id);
    return { ok: true };
  },
});
