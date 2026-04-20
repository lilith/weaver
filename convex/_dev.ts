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
 * Cascade-delete a world. Removes every row that belongs to this world
 * across every table; leaves blobs alone (content-addressed, shared,
 * mark-swept later). Refuses without the explicit confirm literal so
 * you can't tab-complete yourself into disaster.
 */
export const deleteWorld = internalMutation({
  args: {
    world_slug: v.string(),
    confirm: v.literal("yes-delete-please"),
  },
  handler: async (ctx, { world_slug }) => {
    const world = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q) => q.eq("slug", world_slug))
      .first();
    if (!world) throw new Error(`world "${world_slug}" not found`);
    const world_id = world._id;

    const counts: Record<string, number> = {};
    const del = async (name: string, rows: { _id: any }[]) => {
      for (const r of rows) await ctx.db.delete(r._id);
      counts[name] = rows.length;
    };

    // Branches owned by this world (and the dependent rows indexed by branch_id).
    const branches = await ctx.db
      .query("branches")
      .withIndex("by_world", (q) => q.eq("world_id", world_id))
      .collect();

    for (const b of branches) {
      const entities = await ctx.db
        .query("entities")
        .withIndex("by_branch_type", (q) => q.eq("branch_id", b._id))
        .collect();
      // Components, artifact_versions, relations depend on entities.
      for (const e of entities) {
        const components = await ctx.db
          .query("components")
          .withIndex("by_branch_entity_type", (q) =>
            q.eq("branch_id", b._id).eq("entity_id", e._id),
          )
          .collect();
        for (const c of components) await ctx.db.delete(c._id);
        counts.components = (counts.components ?? 0) + components.length;

        const versions = await ctx.db
          .query("artifact_versions")
          .withIndex("by_artifact_version", (q) =>
            q.eq("artifact_entity_id", e._id),
          )
          .collect();
        for (const v of versions) await ctx.db.delete(v._id);
        counts.artifact_versions =
          (counts.artifact_versions ?? 0) + versions.length;

        const relsAsSubject = await ctx.db
          .query("relations")
          .withIndex("by_branch_subject_pred", (q) =>
            q.eq("branch_id", b._id).eq("subject_id", e._id),
          )
          .collect();
        for (const r of relsAsSubject) await ctx.db.delete(r._id);
        const relsAsObject = await ctx.db
          .query("relations")
          .withIndex("by_branch_object_pred", (q) =>
            q.eq("branch_id", b._id).eq("object_id", e._id),
          )
          .collect();
        for (const r of relsAsObject) await ctx.db.delete(r._id);
        counts.relations =
          (counts.relations ?? 0) + relsAsSubject.length + relsAsObject.length;
      }
      for (const e of entities) await ctx.db.delete(e._id);
      counts.entities = (counts.entities ?? 0) + entities.length;

      // Chat threads + messages by scope entity were deleted with entities;
      // any surviving thread/message by branch is orphan — sweep:
      const threads = await ctx.db.query("chat_threads").collect();
      const threadsHere = threads.filter((t) => t.branch_id === b._id);
      for (const t of threadsHere) {
        const msgs = await ctx.db
          .query("chat_messages")
          .withIndex("by_thread_time", (q) => q.eq("thread_id", t._id))
          .collect();
        for (const m of msgs) await ctx.db.delete(m._id);
        counts.chat_messages = (counts.chat_messages ?? 0) + msgs.length;
        await ctx.db.delete(t._id);
      }
      counts.chat_threads = (counts.chat_threads ?? 0) + threadsHere.length;

      // Flows + events scoped by branch/character.
      const flows = await ctx.db.query("flows").collect();
      const flowsHere = flows.filter((f) => f.branch_id === b._id);
      for (const f of flowsHere) {
        const events = await ctx.db
          .query("events")
          .withIndex("by_flow_index", (q) => q.eq("flow_id", f._id))
          .collect();
        for (const e of events) await ctx.db.delete(e._id);
        counts.events = (counts.events ?? 0) + events.length;
        await ctx.db.delete(f._id);
      }
      counts.flows = (counts.flows ?? 0) + flowsHere.length;

      // Art queue scoped by branch.
      const artRows = await ctx.db.query("art_queue").collect();
      const artHere = artRows.filter((a) => a.branch_id === b._id);
      for (const a of artHere) await ctx.db.delete(a._id);
      counts.art_queue = (counts.art_queue ?? 0) + artHere.length;
    }
    for (const b of branches) await ctx.db.delete(b._id);
    counts.branches = branches.length;

    // World-scoped tables: characters, memberships, themes, cost_ledger, mentorship_log
    const characters = await ctx.db
      .query("characters")
      .withIndex("by_world_user", (q) => q.eq("world_id", world_id))
      .collect();
    await del("characters", characters);

    const memberships = await ctx.db
      .query("world_memberships")
      .withIndex("by_world_user", (q) => q.eq("world_id", world_id))
      .collect();
    await del("world_memberships", memberships);

    const themes = await ctx.db
      .query("themes")
      .withIndex("by_world_active", (q) => q.eq("world_id", world_id))
      .collect();
    await del("themes", themes);

    const cost = await ctx.db
      .query("cost_ledger")
      .withIndex("by_world_day", (q) => q.eq("world_id", world_id))
      .collect();
    await del("cost_ledger", cost);

    const mentorship = await ctx.db.query("mentorship_log").collect();
    const mentorshipHere = mentorship.filter((m) => m.world_id === world_id);
    for (const m of mentorshipHere) await ctx.db.delete(m._id);
    counts.mentorship_log = mentorshipHere.length;

    await ctx.db.delete(world_id);
    counts.worlds = 1;

    return { deleted: world_slug, name: world.name, counts };
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
