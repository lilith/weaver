// Dev-only helpers. Remove (or gate behind an admin role) before any real user data lands.

import { internalMutation } from "./_generated/server.js";
import { v } from "convex/values";

// One-shot wipe of all in-scope tables. Used once during the
// isolation-first schema migration. Leaves auth_tokens/sessions intact
// so the current user's magic-link session survives the wipe.
export const wipeWorldData = internalMutation({
  args: { confirm: v.literal("yes-wipe-please") },
  handler: async (ctx) => {
    const tables = [
      "artifact_versions",
      "components",
      "relations",
      "entities",
      "blobs",
      "art_queue",
      "flows",
      "chat_threads",
      "chat_messages",
      "mentorship_log",
      "cost_ledger",
      "themes",
      "characters",
      "branches",
      "worlds",
      "world_memberships",
    ] as const;
    const counts: Record<string, number> = {};
    for (const t of tables) {
      const rows = await ctx.db.query(t as any).collect();
      for (const r of rows) await ctx.db.delete(r._id);
      counts[t] = rows.length;
    }
    return counts;
  },
});
