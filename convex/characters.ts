// Queries + small mutations for the player's character.

import { query } from "./_generated/server.js";
import { v } from "convex/values";

export const getCurrentForUser = query({
  args: { user_id: v.id("users"), world_id: v.id("worlds") },
  handler: async (ctx, { user_id, world_id }) => {
    const character = await ctx.db
      .query("characters")
      .withIndex("by_user_world", (q) =>
        q.eq("user_id", user_id).eq("world_id", world_id),
      )
      .first();
    if (!character) return null;
    return {
      _id: character._id,
      name: character.name,
      pseudonym: character.pseudonym,
      state: character.state,
      current_location_id: character.current_location_id,
      branch_id: character.branch_id,
    };
  },
});

export const getById = query({
  args: { character_id: v.id("characters") },
  handler: async (ctx, { character_id }) => {
    const c = await ctx.db.get(character_id);
    if (!c) return null;
    return {
      _id: c._id,
      name: c.name,
      pseudonym: c.pseudonym,
      state: c.state,
      current_location_id: c.current_location_id,
      branch_id: c.branch_id,
      world_id: c.world_id,
    };
  },
});
