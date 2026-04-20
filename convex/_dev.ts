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

/**
 * One-shot: ensure a user row for each given email, and grant each of them
 * membership to every world owned by the primary_email user (with the
 * specified role). Safe to re-run — skips existing users and existing
 * memberships. Runs forward only (won't retro-demote or remove).
 */
export const preauthorizeHousehold = internalMutation({
  args: {
    primary_email: v.string(),
    member_emails: v.array(v.string()),
    role: v.union(
      v.literal("player"),
      v.literal("family_mod"),
      v.literal("owner"),
    ),
    is_minor: v.optional(v.boolean()),
  },
  handler: async (ctx, { primary_email, member_emails, role, is_minor }) => {
    const primary = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", primary_email.trim().toLowerCase()))
      .first();
    if (!primary) throw new Error(`primary user ${primary_email} not found`);

    const worlds = await ctx.db
      .query("worlds")
      .withIndex("by_owner", (q) => q.eq("owner_user_id", primary._id))
      .collect();

    const now = Date.now();
    const summary: Record<string, { user_created: boolean; worlds_added: number; worlds_skipped: number }> = {};

    for (const raw of member_emails) {
      const email = raw.trim().toLowerCase();
      let user = await ctx.db
        .query("users")
        .withIndex("by_email", (q) => q.eq("email", email))
        .first();
      let user_created = false;
      if (!user) {
        const userId = await ctx.db.insert("users", {
          email,
          display_name: email.split("@")[0],
          is_minor: is_minor === true,
          guardian_user_ids: is_minor === true ? [primary._id] : [],
          created_at: now,
        });
        user = (await ctx.db.get(userId))!;
        user_created = true;
      }

      let added = 0;
      let skipped = 0;
      for (const w of worlds) {
        const existing = await ctx.db
          .query("world_memberships")
          .withIndex("by_world_user", (q) =>
            q.eq("world_id", w._id).eq("user_id", user!._id),
          )
          .first();
        if (existing) {
          skipped++;
          continue;
        }
        await ctx.db.insert("world_memberships", {
          world_id: w._id,
          user_id: user._id,
          role,
          created_at: now,
        });
        added++;
      }
      summary[email] = { user_created, worlds_added: added, worlds_skipped: skipped };
    }
    return {
      primary_worlds: worlds.length,
      members: summary,
    };
  },
});

/**
 * Transfer ownership of every world currently owned by `old_primary_email`
 * to `new_primary_email`. The old primary is demoted to `role: "player"`
 * on each of those worlds (still has access). New primary gets/keeps
 * `role: "owner"`. Idempotent: worlds already owned by new primary are
 * skipped; membership rows patched in-place.
 */
export const reseatPrimaryOwner = internalMutation({
  args: {
    old_primary_email: v.string(),
    new_primary_email: v.string(),
  },
  handler: async (ctx, { old_primary_email, new_primary_email }) => {
    const oldUser = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", old_primary_email.trim().toLowerCase()))
      .first();
    if (!oldUser) throw new Error(`old primary ${old_primary_email} not found`);
    const newUser = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", new_primary_email.trim().toLowerCase()))
      .first();
    if (!newUser) throw new Error(`new primary ${new_primary_email} not found`);

    const worlds = await ctx.db
      .query("worlds")
      .withIndex("by_owner", (q) => q.eq("owner_user_id", oldUser._id))
      .collect();

    const summary = [];
    for (const w of worlds) {
      await ctx.db.patch(w._id, { owner_user_id: newUser._id });

      // Demote old primary's membership on this world to player.
      const oldMember = await ctx.db
        .query("world_memberships")
        .withIndex("by_world_user", (q) =>
          q.eq("world_id", w._id).eq("user_id", oldUser._id),
        )
        .first();
      if (oldMember) {
        await ctx.db.patch(oldMember._id, { role: "player" });
      }

      // Add or upgrade new primary's membership to owner.
      const newMember = await ctx.db
        .query("world_memberships")
        .withIndex("by_world_user", (q) =>
          q.eq("world_id", w._id).eq("user_id", newUser._id),
        )
        .first();
      if (newMember) {
        if (newMember.role !== "owner") {
          await ctx.db.patch(newMember._id, { role: "owner" });
        }
      } else {
        await ctx.db.insert("world_memberships", {
          world_id: w._id,
          user_id: newUser._id,
          role: "owner",
          created_at: Date.now(),
        });
      }
      summary.push({ world_slug: w.slug, world_name: w.name });
    }
    return {
      worlds_transferred: worlds.length,
      details: summary,
    };
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
