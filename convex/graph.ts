// Graph-map data plane (spec 26 Layer 2).
//
// Exposes three shapes to the client:
//   - loadGraphMap: one-round-trip bundle with nodes + edges + pins.
//   - pinNodePosition / unpinNode: owner-or-member soft-pin mutations.
//   - incrementEdgeTraffic (internal): invoked by locations.applyOption
//     on every cross-location transition.
//
// All indexes are branch-scoped (URGENT rule 1). resolveMember gates
// every call.

import { query, mutation, internalMutation } from "./_generated/server.js";
import { v } from "convex/values";
import { resolveMember } from "./sessions.js";
import { readJSONBlob } from "./blobs.js";
import { getBiomePalette } from "@weaver/engine/biomes";
import type { Doc, Id } from "./_generated/dataModel.js";

function publicTileUrl(blob_hash: string): string | null {
  const base = process.env.R2_IMAGES_PUBLIC_URL;
  if (!base) return null;
  return `${base}/blob/${blob_hash.slice(0, 2)}/${blob_hash.slice(2, 4)}/${blob_hash}`;
}

/** Normalise a direction key on the authored payload so we don't
 *  produce phantom "North" + "north" edges. */
function normDir(d: string): string {
  return (d ?? "").toString().toLowerCase();
}

/**
 * One-round-trip graph bundle for <GraphMap>. Shape matches the
 * MapBundle contract in spec/26.
 *
 * Only canonical entities are included when `include_drafts` is false;
 * by default drafts authored by the caller are included so the author
 * can see their own pre-saveToMap nodes.
 */
export const loadGraphMap = query({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    include_drafts: v.optional(v.boolean()),
  },
  handler: async (ctx, { session_token, world_slug, include_drafts }) => {
    const world = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q) => q.eq("slug", world_slug))
      .first();
    if (!world?.current_branch_id) return null;
    const { user_id } = await resolveMember(ctx, session_token, world._id);
    const branch_id = world.current_branch_id;

    const allLocs = (await ctx.db
      .query("entities")
      .withIndex("by_branch_type", (q: any) =>
        q.eq("branch_id", branch_id).eq("type", "location"),
      )
      .collect()) as Doc<"entities">[];

    const wantDrafts = include_drafts !== false;
    const locs = allLocs.filter((e) => {
      if (!e.draft) return true;
      if (!wantDrafts) return false;
      // Authors see their own drafts regardless of include_drafts;
      // peers only see canonical.
      return e.author_user_id === user_id;
    });

    // Style binding for tile-lookup via entity_overrides.
    const binding = await ctx.db
      .query("world_style_bindings")
      .withIndex("by_world", (q: any) => q.eq("world_id", world._id))
      .first();

    // Pins — load once, index by slug.
    const pins = (await ctx.db
      .query("map_pins")
      .withIndex("by_world_branch", (q: any) =>
        q.eq("world_id", world._id).eq("branch_id", branch_id),
      )
      .collect()) as Doc<"map_pins">[];
    const pinBySlug = new Map<string, { x: number; y: number }>();
    for (const p of pins) pinBySlug.set(p.slug, { x: p.x, y: p.y });

    // Edge traffic.
    const trafficRows = (await ctx.db
      .query("edge_traffic")
      .withIndex("by_branch_edge", (q: any) => q.eq("branch_id", branch_id))
      .collect()) as Doc<"edge_traffic">[];
    const trafficMap = new Map<string, number>();
    for (const t of trafficRows) {
      trafficMap.set(`${t.from_slug}->${t.to_slug}`, t.crossings);
    }

    type NodeOut = {
      id: string;
      slug: string;
      name: string;
      biome: string | null;
      subgraph: string;
      map_shape: "spatial" | "action" | "floating" | null;
      draft: boolean;
      parent_slug: string | null;
      tile_url: string | null;
      palette_fill: string | null;
      neighbors: Record<string, string>;
      pin: { x: number; y: number } | null;
      map_hint: unknown | null;
      tags: string[];
    };
    const nodes: NodeOut[] = [];
    const subgraphNames = new Map<string, string>();
    const edgesOut: Array<{ from: string; to: string; direction: string; traffic: number }> = [];

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
      } catch {
        /* unreadable payload — fall back to defaults */
      }
      const biomeSlug = typeof payload?.biome === "string" ? payload.biome : null;
      const subgraphKey = e.subgraph ?? biomeSlug ?? "unassigned";
      if (!subgraphNames.has(subgraphKey)) {
        subgraphNames.set(subgraphKey, subgraphKey.replace(/-/g, " "));
      }
      const palette = biomeSlug ? getBiomePalette(biomeSlug) : null;
      const paletteFill =
        palette?.overrides?.["--color-scene-bg"] ??
        palette?.overrides?.["--color-bg"] ??
        null;

      // Tile URL: entity override first, then top-voted map_tile rendering.
      let tile_url: string | null = null;
      const entityOverride = binding?.entity_overrides?.[e.slug] as Id<"tile_library"> | undefined;
      if (entityOverride) {
        const tile = await ctx.db.get(entityOverride);
        if (tile) tile_url = publicTileUrl((tile as any).blob_hash);
      }
      if (!tile_url && r2Public) {
        const rendering = await ctx.db
          .query("entity_art_renderings")
          .withIndex("by_entity_mode", (q: any) =>
            q.eq("entity_id", e._id).eq("mode", "map_tile"),
          )
          .order("desc")
          .first();
        if (rendering?.blob_hash) tile_url = publicTileUrl(rendering.blob_hash);
      }

      const neighborsRaw = (payload?.neighbors ?? {}) as Record<string, string>;
      const neighbors: Record<string, string> = {};
      for (const [k, v0] of Object.entries(neighborsRaw)) {
        if (typeof v0 === "string") neighbors[normDir(k)] = v0;
      }

      // For action nodes expanded via an option, parent slug lets the UI
      // render them orbiting that parent.
      let parent_slug: string | null = null;
      if (e.expanded_from_entity_id) {
        const p = await ctx.db.get(e.expanded_from_entity_id);
        parent_slug = (p as any)?.slug ?? null;
      }

      nodes.push({
        id: e._id,
        slug: e.slug,
        name: payload?.name ?? e.slug,
        biome: biomeSlug,
        subgraph: subgraphKey,
        map_shape: (e.map_shape as any) ?? null,
        draft: e.draft === true,
        parent_slug,
        tile_url,
        palette_fill: paletteFill,
        neighbors,
        pin: pinBySlug.get(e.slug) ?? null,
        map_hint: e.map_hint ?? null,
        tags: Array.isArray(payload?.tags) ? payload.tags : [],
      });

      // Edges: one per authored neighbor direction. Edge targets that
      // aren't present in this branch get filtered out after the node
      // loop below (to keep traffic lookup cheap).
      for (const [dir, target] of Object.entries(neighbors)) {
        edgesOut.push({
          from: e.slug,
          to: target,
          direction: dir,
          traffic: trafficMap.get(`${e.slug}->${target}`) ?? 0,
        });
      }
    }

    const slugSet = new Set(nodes.map((n) => n.slug));
    const edges = edgesOut.filter((e) => slugSet.has(e.to));

    const subgraphs = Array.from(subgraphNames.entries()).map(([slug, name]) => ({
      slug,
      display_name: name,
      tint: null as string | null,
    }));

    return {
      world: {
        id: world._id,
        slug: world.slug,
        name: world.name,
        style_tag: binding?.style_tag ?? null,
      },
      subgraphs,
      nodes,
      edges,
      branch_id,
    };
  },
});

/** Owner or any world member may pin. Pin is authoritative for (world,
 *  branch, slug) — one row; latest drag wins. */
export const pinNodePosition = mutation({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    slug: v.string(),
    x: v.number(),
    y: v.number(),
  },
  handler: async (ctx, { session_token, world_slug, slug, x, y }) => {
    const world = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q) => q.eq("slug", world_slug))
      .first();
    if (!world?.current_branch_id) throw new Error("no current branch");
    const { user_id } = await resolveMember(ctx, session_token, world._id);
    const branch_id = world.current_branch_id;

    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error("invalid coordinates");
    }

    const existing = (await ctx.db
      .query("map_pins")
      .withIndex("by_world_slug", (q: any) =>
        q.eq("world_id", world._id).eq("slug", slug),
      )
      .first()) as Doc<"map_pins"> | null;
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        x,
        y,
        pinned_by_user_id: user_id,
        pinned_at: now,
        branch_id,
      });
      return { pinned: true as const };
    }
    await ctx.db.insert("map_pins", {
      world_id: world._id,
      branch_id,
      slug,
      x,
      y,
      pinned_by_user_id: user_id,
      pinned_at: now,
    });
    return { pinned: true as const };
  },
});

export const unpinNode = mutation({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    slug: v.string(),
  },
  handler: async (ctx, { session_token, world_slug, slug }) => {
    const world = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q) => q.eq("slug", world_slug))
      .first();
    if (!world) throw new Error("world not found");
    await resolveMember(ctx, session_token, world._id);

    const existing = (await ctx.db
      .query("map_pins")
      .withIndex("by_world_slug", (q: any) =>
        q.eq("world_id", world._id).eq("slug", slug),
      )
      .first()) as Doc<"map_pins"> | null;
    if (existing) await ctx.db.delete(existing._id);
    return { pinned: false as const };
  },
});

/** Internal — called by locations.applyOption. Cheap upsert. Invariants:
 *   - from_slug / to_slug must be non-empty (sanitizer on applyOption).
 *   - Self-edges (same slug) are recorded (they do happen for hub nodes)
 *     but filtered out in render by <GraphMap>. */
export async function incrementEdgeTraffic(
  ctx: any,
  world_id: Id<"worlds">,
  branch_id: Id<"branches">,
  from_slug: string,
  to_slug: string,
): Promise<void> {
  if (!from_slug || !to_slug) return;
  const existing = (await ctx.db
    .query("edge_traffic")
    .withIndex("by_branch_edge", (q: any) =>
      q.eq("branch_id", branch_id).eq("from_slug", from_slug).eq("to_slug", to_slug),
    )
    .first()) as Doc<"edge_traffic"> | null;
  const now = Date.now();
  if (existing) {
    await ctx.db.patch(existing._id, {
      crossings: (existing.crossings ?? 0) + 1,
      last_crossed_at: now,
    });
    return;
  }
  await ctx.db.insert("edge_traffic", {
    world_id,
    branch_id,
    from_slug,
    to_slug,
    crossings: 1,
    last_crossed_at: now,
  });
}

/** Reachable via `internal.graph.incrementEdgeTrafficMutation` when
 *  callers need an explicit mutation wrapper. locations.applyOption
 *  already runs inside a mutation, so it imports the function above
 *  directly. */
export const incrementEdgeTrafficMutation = internalMutation({
  args: {
    world_id: v.id("worlds"),
    branch_id: v.id("branches"),
    from_slug: v.string(),
    to_slug: v.string(),
  },
  handler: async (ctx, { world_id, branch_id, from_slug, to_slug }) => {
    await incrementEdgeTraffic(ctx, world_id, branch_id, from_slug, to_slug);
  },
});
