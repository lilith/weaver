// Runtime diagnostics — Convex surface. Pure sanitizers live in
// packages/engine/src/diagnostics; this file wraps them with:
//   - logBugs: rate-limited insert into runtime_bugs
//   - listBugs: query for the weaver bugs CLI
//   - clearBugs: resolve (owner-only)
//
// Rate-limiting: same (world_id, code) increments seen_count instead
// of inserting a new row. Keeps the table bounded even if a pathology
// fires on every applyOption.

import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server.js";
import { resolveSession, resolveMember } from "./sessions.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { RuntimeBug } from "@weaver/engine/diagnostics";

/** Persist a list of bugs, rate-limited per (world_id, code). Safe to
 *  call with an empty array. Intended to be called from mutations. */
export async function logBugs(
  ctx: any,
  bugs: RuntimeBug[],
  scope: {
    world_id?: Id<"worlds">;
    branch_id?: Id<"branches">;
    character_id?: Id<"characters">;
  },
): Promise<void> {
  if (!bugs || bugs.length === 0) return;
  const now = Date.now();
  for (const bug of bugs) {
    // Look up prior row for this (world, code). If found, increment.
    const prior = await ctx.db
      .query("runtime_bugs")
      .withIndex("by_world_code", (q: any) =>
        q.eq("world_id", scope.world_id).eq("code", bug.code),
      )
      .first();
    if (prior) {
      await ctx.db.patch(prior._id, {
        seen_count: (prior.seen_count as number) + 1,
        last_seen_at: now,
        // Keep the most recent context so we can debug the latest case.
        context: bug.context ?? prior.context,
        // Latest message wins (may carry fresh detail).
        message: bug.message,
      });
      continue;
    }
    await ctx.db.insert("runtime_bugs", {
      world_id: scope.world_id,
      branch_id: scope.branch_id,
      character_id: scope.character_id,
      severity: bug.severity,
      code: bug.code,
      message: bug.message,
      context: bug.context,
      seen_count: 1,
      first_seen_at: now,
      last_seen_at: now,
    });
  }
}

export const logBugsPublic = internalMutation({
  args: {
    world_id: v.optional(v.id("worlds")),
    branch_id: v.optional(v.id("branches")),
    character_id: v.optional(v.id("characters")),
    bugs: v.array(v.any()),
  },
  handler: async (ctx, { world_id, branch_id, character_id, bugs }) => {
    await logBugs(ctx, bugs as RuntimeBug[], { world_id, branch_id, character_id });
    return { logged: bugs.length };
  },
});

// --------------------------------------------------------------------
// Read surface

export const listBugs = query({
  args: {
    session_token: v.string(),
    world_slug: v.optional(v.string()),
    since_ms: v.optional(v.number()),
    severity: v.optional(
      v.union(v.literal("info"), v.literal("warn"), v.literal("error")),
    ),
    limit: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { session_token, world_slug, since_ms, severity, limit },
  ) => {
    const { user_id } = await resolveSession(ctx, session_token);
    const cutoff = since_ms ?? Date.now() - 24 * 60 * 60 * 1000;
    let world_id: Id<"worlds"> | undefined;
    if (world_slug) {
      const w = await ctx.db
        .query("worlds")
        .withIndex("by_slug", (q) => q.eq("slug", world_slug))
        .first();
      if (!w) return [];
      // Only members see a world's bugs.
      await resolveMember(ctx, session_token, w._id);
      world_id = w._id;
    }
    const rows = world_id
      ? await ctx.db
          .query("runtime_bugs")
          .withIndex("by_world_severity_time", (q: any) =>
            q.eq("world_id", world_id!),
          )
          .collect()
      : // Global bugs: any authenticated user sees (single-instance trust).
        await ctx.db.query("runtime_bugs").collect();
    let out = rows
      .filter((r: any) => r.last_seen_at >= cutoff)
      .filter((r: any) => !severity || r.severity === severity);
    // For safety in unscoped (world_id omitted) list, hide rows whose
    // world the caller isn't a member of — walk only the ones with a
    // world_id set; include unscoped-bugs freely.
    if (!world_id) {
      const mine = new Set<string>();
      const memberships = await ctx.db
        .query("world_memberships")
        .withIndex("by_user", (q: any) => q.eq("user_id", user_id))
        .collect();
      for (const m of memberships) mine.add(m.world_id);
      out = out.filter((r: any) => !r.world_id || mine.has(r.world_id));
    }
    out.sort((a: any, b: any) => b.last_seen_at - a.last_seen_at);
    return out.slice(0, limit ?? 100).map((r: any) => ({
      id: r._id,
      world_id: r.world_id ?? null,
      severity: r.severity,
      code: r.code,
      message: r.message,
      seen_count: r.seen_count,
      first_seen_at: r.first_seen_at,
      last_seen_at: r.last_seen_at,
      context: r.context ?? null,
    }));
  },
});

/** Weekly cron — GC resolved/stale bugs.
 *   - `info` severity older than 7 days last_seen_at: delete.
 *   - `warn`/`error` older than 30 days last_seen_at: delete.
 *  Bugs still firing (last_seen_at recent) are kept regardless of
 *  seen_count so the surface stays useful for current issues. */
export const gcRuntimeBugs = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    const infoCutoff = now - sevenDays;
    const warnCutoff = now - thirtyDays;

    const rows = await ctx.db.query("runtime_bugs").collect();
    let infoDeleted = 0,
      warnDeleted = 0,
      errorDeleted = 0,
      kept = 0;
    for (const r of rows) {
      const age = r.last_seen_at;
      if (r.severity === "info" && age < infoCutoff) {
        await ctx.db.delete(r._id);
        infoDeleted++;
      } else if (
        (r.severity === "warn" || r.severity === "error") &&
        age < warnCutoff
      ) {
        await ctx.db.delete(r._id);
        if (r.severity === "warn") warnDeleted++;
        else errorDeleted++;
      } else {
        kept++;
      }
    }
    return {
      info_deleted: infoDeleted,
      warn_deleted: warnDeleted,
      error_deleted: errorDeleted,
      kept,
      ran_at: now,
    };
  },
});

/** Owner-only: delete all bugs for a world (after fixing them). */
export const clearBugs = mutation({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    code: v.optional(v.string()),
  },
  handler: async (ctx, { session_token, world_slug, code }) => {
    const w = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q) => q.eq("slug", world_slug))
      .first();
    if (!w) throw new Error(`world not found: ${world_slug}`);
    const { user_id } = await resolveMember(ctx, session_token, w._id);
    if (w.owner_user_id !== user_id)
      throw new Error("clearBugs is owner-only");
    const rows = code
      ? await ctx.db
          .query("runtime_bugs")
          .withIndex("by_world_code", (q: any) =>
            q.eq("world_id", w._id).eq("code", code),
          )
          .collect()
      : await ctx.db
          .query("runtime_bugs")
          .withIndex("by_world_severity_time", (q: any) =>
            q.eq("world_id", w._id),
          )
          .collect();
    for (const r of rows) await ctx.db.delete(r._id);
    return { cleared: rows.length };
  },
});
