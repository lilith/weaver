// 2D world-map surface (spec 02 `coords` field + spatial exploration).
// A separate query so the `/map/[world]` route can load every
// location's layout info in one round-trip without pulling full
// description prose.
//
// Layout strategy the client uses:
//   1. Primary: hex coords `{q, r}` from authored payload, centered
//      on the origin and snapped to a regular axial grid.
//   2. Fallback: BFS from a root (owner's current-location or
//      first canonical) over the neighbor graph; unanchored
//      locations inherit parent + direction offset.
//
// Pixel-tile art is read from entity_art_renderings at mode
// `map_tile` (top-voted variant, stored in R2). Nil tile = biome
// palette swatch.

import { query } from "./_generated/server.js";
import { v } from "convex/values";
import { resolveMember } from "./sessions.js";
import { readJSONBlob } from "./blobs.js";
import { getBiomePalette } from "@weaver/engine/biomes";
import type { Doc } from "./_generated/dataModel.js";

export const loadWorldMap = query({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
  },
  handler: async (ctx, { session_token, world_slug }) => {
    const world = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q) => q.eq("slug", world_slug))
      .first();
    if (!world?.current_branch_id) return null;
    await resolveMember(ctx, session_token, world._id);
    const branch_id = world.current_branch_id;

    const locs = (await ctx.db
      .query("entities")
      .withIndex("by_branch_type", (q: any) =>
        q.eq("branch_id", branch_id).eq("type", "location"),
      )
      .collect()) as Doc<"entities">[];

    const nodes: Array<{
      id: string;
      slug: string;
      name: string;
      biome: string | null;
      coords: { q: number; r: number } | null;
      neighbors: Record<string, string>;
      draft: boolean;
      tile_url: string | null;
      palette_fill: string | null;
    }> = [];
    const r2Public = process.env.R2_IMAGES_PUBLIC_URL ?? null;

    for (const e of locs) {
      let payload: any = null;
      try {
        const vr = await ctx.db
          .query("artifact_versions")
          .withIndex("by_artifact_version", (q: any) =>
            q.eq("artifact_entity_id", e._id).eq("version", e.current_version),
          )
          .first();
        if (vr) payload = await readJSONBlob<any>(ctx as any, vr.blob_hash);
      } catch {}
      // Top-voted map_tile rendering (if art_curation has produced one).
      let tile_url: string | null = null;
      if (r2Public) {
        const tile = await ctx.db
          .query("entity_art_renderings")
          .withIndex("by_entity_mode", (q: any) =>
            q.eq("entity_id", e._id).eq("mode", "map_tile"),
          )
          .order("desc")
          .first();
        if (tile?.blob_hash) {
          tile_url = `${r2Public}/blob/${tile.blob_hash.slice(0, 2)}/${tile.blob_hash.slice(2, 4)}/${tile.blob_hash}`;
        }
      }
      const biomeSlug =
        typeof payload?.biome === "string" ? payload.biome : null;
      const palette = biomeSlug ? getBiomePalette(biomeSlug) : null;
      const paletteFill = palette?.overrides?.["--color-scene-bg"]
        ?? palette?.overrides?.["--color-bg"]
        ?? null;
      nodes.push({
        id: e._id,
        slug: e.slug,
        name: payload?.name ?? e.slug,
        biome: biomeSlug,
        coords:
          payload?.coords &&
          typeof payload.coords.q === "number" &&
          typeof payload.coords.r === "number"
            ? { q: Number(payload.coords.q), r: Number(payload.coords.r) }
            : null,
        neighbors: (payload?.neighbors ?? {}) as Record<string, string>,
        draft: e.draft === true,
        tile_url,
        palette_fill: paletteFill,
      });
    }

    // Canonical-first sort so the client's BFS picks a stable root.
    nodes.sort((a, b) => Number(a.draft) - Number(b.draft) || a.slug.localeCompare(b.slug));

    return {
      world: { slug: world.slug, name: world.name, id: world._id },
      nodes,
    };
  },
});
