// Dev-only helpers. Gate production access later; for now the dev deployment is
// firewalled by the access token in ~/.convex/config.json.

import { internalMutation, action } from "./_generated/server.js";
import { v } from "convex/values";
import { hashString, bytesToHex } from "@weaver/engine/blobs";
import { internal } from "./_generated/api.js";

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/**
 * Dev-only shortcut: create-or-find a user by email and hand back a
 * ready-to-go session token, skipping the magic-link email step. Use
 * this from E2E tests and local curl sessions so we don't need to
 * crack an inbox.
 */
export const devSignInAs = action({
  args: { email: v.string() },
  handler: async (ctx, { email }): Promise<{ session_token: string; user_id: string }> => {
    const normalized = email.trim().toLowerCase();
    const sessionToken = randomToken();
    const result: { user_id: string } = await ctx.runMutation(
      internal._dev.ensureSessionForEmail,
      {
        email: normalized,
        session_token_hash: hashString(sessionToken),
      },
    );
    return { session_token: sessionToken, user_id: result.user_id };
  },
});

export const ensureSessionForEmail = internalMutation({
  args: { email: v.string(), session_token_hash: v.string() },
  handler: async (ctx, { email, session_token_hash }) => {
    let user = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();
    if (!user) {
      const userId = await ctx.db.insert("users", {
        email,
        display_name: email.split("@")[0],
        is_minor: false,
        guardian_user_ids: [],
        created_at: Date.now(),
      });
      user = (await ctx.db.get(userId))!;
    }
    const now = Date.now();
    await ctx.db.insert("sessions", {
      user_id: user._id,
      token_hash: session_token_hash,
      expires_at: now + 30 * 24 * 60 * 60 * 1000,
      created_at: now,
      last_used_at: now,
    });
    return { user_id: user._id };
  },
});

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
