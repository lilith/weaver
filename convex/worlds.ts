// World + membership reads — every call resolves the session to a user
// and restricts results to worlds the user is a member of.

import { query } from "./_generated/server.js";
import { v } from "convex/values";
import { resolveSession, resolveMember } from "./sessions.js";
import { readJSONBlob } from "./blobs.js";

export const listMine = query({
  args: { session_token: v.string() },
  handler: async (ctx, { session_token }) => {
    const { user_id } = await resolveSession(ctx, session_token);
    const memberships = await ctx.db
      .query("world_memberships")
      .withIndex("by_user", (q) => q.eq("user_id", user_id))
      .collect();
    const worlds = [];
    for (const m of memberships) {
      const w = await ctx.db.get(m.world_id);
      if (!w) continue;
      worlds.push({
        _id: w._id,
        name: w.name,
        slug: w.slug,
        current_branch_id: w.current_branch_id,
        role: m.role,
      });
    }
    worlds.sort((a, b) => a.name.localeCompare(b.name));
    return worlds;
  },
});

export const getBySlugForMe = query({
  args: { session_token: v.string(), slug: v.string() },
  handler: async (ctx, { session_token, slug }) => {
    const { user_id } = await resolveSession(ctx, session_token);
    const world = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();
    if (!world) return null;
    const member = await ctx.db
      .query("world_memberships")
      .withIndex("by_world_user", (q) =>
        q.eq("world_id", world._id).eq("user_id", user_id),
      )
      .first();
    if (!member) return null; // treat as not-found for non-members
    return {
      _id: world._id,
      name: world.name,
      slug: world.slug,
      content_rating: world.content_rating,
      current_branch_id: world.current_branch_id,
      role: member.role,
    };
  },
});

export const getBible = query({
  args: { session_token: v.string(), world_id: v.id("worlds") },
  handler: async (ctx, { session_token, world_id }) => {
    await resolveMember(ctx, session_token, world_id);
    const world = await ctx.db.get(world_id);
    if (!world?.current_branch_id) return null;
    const entity = await ctx.db
      .query("entities")
      .withIndex("by_branch_type_slug", (q) =>
        q
          .eq("branch_id", world.current_branch_id!)
          .eq("type", "bible")
          .eq("slug", "bible"),
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
