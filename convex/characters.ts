import { query } from "./_generated/server.js";
import { v } from "convex/values";
import { resolveMember } from "./sessions.js";

export const getMineInWorld = query({
  args: { session_token: v.string(), world_id: v.id("worlds") },
  handler: async (ctx, { session_token, world_id }) => {
    const { user_id } = await resolveMember(ctx, session_token, world_id);
    const c = await ctx.db
      .query("characters")
      .withIndex("by_world_user", (q) =>
        q.eq("world_id", world_id).eq("user_id", user_id),
      )
      .first();
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
