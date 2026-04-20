// World + branch queries, and a bible query that returns the authored
// payload inline (client needs tone, style anchor, etc.).

import { query } from "./_generated/server.js";
import { v } from "convex/values";
import { readJSONBlob } from "./blobs.js";

export const getBySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const world = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();
    if (!world) return null;
    return {
      _id: world._id,
      name: world.name,
      slug: world.slug,
      content_rating: world.content_rating,
      current_branch_id: world.current_branch_id,
    };
  },
});

export const listForUser = query({
  args: { user_id: v.id("users") },
  handler: async (ctx, { user_id }) => {
    const worlds = await ctx.db
      .query("worlds")
      .withIndex("by_owner", (q) => q.eq("owner_user_id", user_id))
      .collect();
    return worlds.map((w) => ({
      _id: w._id,
      name: w.name,
      slug: w.slug,
      current_branch_id: w.current_branch_id,
    }));
  },
});

export const getBible = query({
  args: { branch_id: v.id("branches") },
  handler: async (ctx, { branch_id }) => {
    const entity = await ctx.db
      .query("entities")
      .withIndex("by_branch_type_slug", (q) =>
        q.eq("branch_id", branch_id).eq("type", "bible").eq("slug", "bible"),
      )
      .first();
    if (!entity) return null;
    const version = await ctx.db
      .query("artifact_versions")
      .withIndex("by_artifact_version", (q) =>
        q
          .eq("artifact_entity_id", entity._id)
          .eq("version", entity.current_version),
      )
      .first();
    if (!version) return null;
    return {
      entity_id: entity._id,
      version: entity.current_version,
      ...(await readJSONBlob<Record<string, unknown>>(ctx as any, version.blob_hash)),
    };
  },
});
