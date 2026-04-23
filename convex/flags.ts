// Feature flags — Convex-side surface. Pure logic lives in
// packages/engine/src/flags/index.ts; this file wraps it in queries +
// mutations with proper session/isolation gating.

import { query, mutation } from "./_generated/server.js";
import { v } from "convex/values";
import { resolveSession, resolveMember } from "./sessions.js";
import {
  OWNER_FLIPPABLE_FLAGS,
  REGISTRY_DEFAULTS,
  resolveFlag,
  scopeCandidates,
  type FeatureFlagRow,
  type FlagScope,
  type FlagScopeKind,
} from "@weaver/engine/flags";
import type { Doc, Id } from "./_generated/dataModel.js";

// --------------------------------------------------------------------
// Server-side helpers — importable from other Convex files.

/** Resolve a single flag against the DB. Queries only the scope rows
 *  that could match, so resolution is O(1..4) reads, not a full scan. */
export async function isFeatureEnabled(
  ctx: any,
  flag_key: string,
  scope: FlagScope,
): Promise<boolean> {
  const candidates = scopeCandidates(scope);
  const rows: FeatureFlagRow[] = [];
  for (const c of candidates) {
    const row = await ctx.db
      .query("feature_flags")
      .withIndex("by_key_scope", (q: any) =>
        q
          .eq("flag_key", flag_key)
          .eq("scope_kind", c.scope_kind)
          .eq("scope_id", c.scope_id ?? undefined),
      )
      .first();
    if (row) {
      rows.push({
        flag_key: row.flag_key,
        scope_kind: row.scope_kind,
        scope_id: row.scope_id,
        enabled: row.enabled,
      });
    }
  }
  return resolveFlag(flag_key, rows, scope);
}

// --------------------------------------------------------------------
// Public API

const scopeKindUnion = v.union(
  v.literal("character"),
  v.literal("user"),
  v.literal("world"),
  v.literal("global"),
);

/** List all flag rows. Optionally filter by key. Requires auth; no
 *  world-membership check — flags are authoring-layer, not per-world
 *  confidential.  */
export const listAll = query({
  args: {
    session_token: v.string(),
    flag_key: v.optional(v.string()),
  },
  handler: async (ctx, { session_token, flag_key }) => {
    await resolveSession(ctx, session_token);
    const rows = flag_key
      ? await ctx.db
          .query("feature_flags")
          .withIndex("by_key", (q: any) => q.eq("flag_key", flag_key))
          .collect()
      : await ctx.db.query("feature_flags").collect();
    return {
      rows: rows.map((r: any) => ({
        flag_key: r.flag_key,
        scope_kind: r.scope_kind,
        scope_id: r.scope_id ?? null,
        enabled: r.enabled,
        set_at: r.set_at,
        notes: r.notes ?? null,
      })),
      defaults: REGISTRY_DEFAULTS,
    };
  },
});

/** Resolve a single flag for a given scope. Handy for CLI `weaver flag
 *  resolve` + server self-tests. */
export const resolve = query({
  args: {
    session_token: v.string(),
    flag_key: v.string(),
    world_slug: v.optional(v.string()),
    character_id: v.optional(v.id("characters")),
  },
  handler: async (ctx, { session_token, flag_key, world_slug, character_id }) => {
    const { user_id } = await resolveSession(ctx, session_token);
    let world_id: string | undefined;
    if (world_slug) {
      const world = await ctx.db
        .query("worlds")
        .withIndex("by_slug", (q) => q.eq("slug", world_slug))
        .first();
      if (!world) throw new Error(`world not found: ${world_slug}`);
      world_id = world._id;
    }
    const scope: FlagScope = {
      user_id,
      world_id,
      character_id: character_id ?? undefined,
    };
    const enabled = await isFeatureEnabled(ctx, flag_key, scope);
    return {
      flag_key,
      enabled,
      scope: {
        user_id,
        world_id: world_id ?? null,
        character_id: character_id ?? null,
      },
      default: REGISTRY_DEFAULTS[flag_key] ?? false,
    };
  },
});

/** Owner-only: load every owner-flippable flag's state for a world in
 *  one round-trip. Each row reports the resolved value (what the app
 *  actually sees) + whether there's a world-scoped override on top of
 *  the global default. Used by /admin/settings/<slug>. */
export const listOwnerFlippable = query({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
  },
  handler: async (ctx, { session_token, world_slug }) => {
    const { user_id } = await resolveSession(ctx, session_token);
    const world = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q) => q.eq("slug", world_slug))
      .first();
    if (!world) throw new Error(`world not found: ${world_slug}`);
    if (world.owner_user_id !== user_id)
      throw new Error("forbidden: admin settings are owner-only");
    const out: Array<{
      key: string;
      label: string;
      description: string;
      group: string;
      caveat: string | null;
      enabled: boolean;
      default: boolean;
      world_override: boolean | null;
    }> = [];
    for (const meta of OWNER_FLIPPABLE_FLAGS) {
      // World-scoped override (what a toggle writes).
      const worldRow = await ctx.db
        .query("feature_flags")
        .withIndex("by_key_scope", (q: any) =>
          q
            .eq("flag_key", meta.key)
            .eq("scope_kind", "world")
            .eq("scope_id", world._id),
        )
        .first();
      // Global override (set via CLI or older admin path). Falls through
      // when resolving but we show it for transparency.
      const globalRow = await ctx.db
        .query("feature_flags")
        .withIndex("by_key_scope", (q: any) =>
          q
            .eq("flag_key", meta.key)
            .eq("scope_kind", "global")
            .eq("scope_id", undefined),
        )
        .first();
      const rows: FeatureFlagRow[] = [];
      if (worldRow)
        rows.push({
          flag_key: worldRow.flag_key,
          scope_kind: worldRow.scope_kind,
          scope_id: worldRow.scope_id,
          enabled: worldRow.enabled,
        });
      if (globalRow)
        rows.push({
          flag_key: globalRow.flag_key,
          scope_kind: globalRow.scope_kind,
          scope_id: globalRow.scope_id,
          enabled: globalRow.enabled,
        });
      const enabled = resolveFlag(meta.key, rows, {
        world_id: world._id as unknown as string,
        user_id: user_id as unknown as string,
      });
      out.push({
        key: meta.key,
        label: meta.label,
        description: meta.description,
        group: meta.group,
        caveat: meta.caveat ?? null,
        enabled,
        default: REGISTRY_DEFAULTS[meta.key] ?? false,
        world_override: worldRow ? worldRow.enabled : null,
      });
    }
    return { world_id: world._id, flags: out };
  },
});

/** Set (or unset) a flag for a given scope. Scoping rules:
 *    - global scope: any authed user may set (single-instance trust model).
 *    - world scope:  caller must be world owner.
 *    - user scope:   caller must be that user.
 *    - character scope: caller must own that character. */
export const set = mutation({
  args: {
    session_token: v.string(),
    flag_key: v.string(),
    scope_kind: scopeKindUnion,
    scope_id: v.optional(v.string()),
    enabled: v.boolean(),
    notes: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { session_token, flag_key, scope_kind, scope_id, enabled, notes },
  ) => {
    const { user_id } = await resolveSession(ctx, session_token);
    // Permission per scope kind.
    if (scope_kind === "world") {
      if (!scope_id) throw new Error("world scope requires scope_id (world_slug)");
      const wslug: string = scope_id;
      const world = await ctx.db
        .query("worlds")
        .withIndex("by_slug", (q) => q.eq("slug", wslug))
        .first();
      if (!world) throw new Error(`world not found: ${wslug}`);
      if (world.owner_user_id !== user_id)
        throw new Error("forbidden: only world owner may set world-scoped flags");
      scope_id = world._id;
    } else if (scope_kind === "user") {
      if (!scope_id) throw new Error("user scope requires scope_id");
      if (scope_id !== user_id)
        throw new Error("forbidden: can only set your own user-scoped flags");
    } else if (scope_kind === "character") {
      if (!scope_id) throw new Error("character scope requires scope_id");
      const char = await ctx.db.get(scope_id as Id<"characters">);
      if (!char) throw new Error(`character not found: ${scope_id}`);
      if ((char as Doc<"characters">).user_id !== user_id)
        throw new Error("forbidden: only the character's user may flag-scope it");
    }
    // Find existing row.
    const existing = await ctx.db
      .query("feature_flags")
      .withIndex("by_key_scope", (q: any) =>
        q
          .eq("flag_key", flag_key)
          .eq("scope_kind", scope_kind)
          .eq("scope_id", scope_id ?? undefined),
      )
      .first();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        enabled,
        set_by_user_id: user_id,
        set_at: now,
        notes: notes ?? existing.notes,
      });
      return { updated: true, flag_key, scope_kind, scope_id: scope_id ?? null, enabled };
    }
    await ctx.db.insert("feature_flags", {
      flag_key,
      scope_kind,
      scope_id: scope_id ?? undefined,
      enabled,
      set_by_user_id: user_id,
      set_at: now,
      notes,
    });
    return { created: true, flag_key, scope_kind, scope_id: scope_id ?? null, enabled };
  },
});

/** Delete a flag override (falls through to next-lower-precedence). */
export const unset = mutation({
  args: {
    session_token: v.string(),
    flag_key: v.string(),
    scope_kind: scopeKindUnion,
    scope_id: v.optional(v.string()),
  },
  handler: async (ctx, { session_token, flag_key, scope_kind, scope_id }) => {
    const { user_id } = await resolveSession(ctx, session_token);
    // Same permission gate as set.
    if (scope_kind === "world") {
      if (!scope_id) throw new Error("world scope requires scope_id (world_slug)");
      const wslug: string = scope_id;
      const world = await ctx.db
        .query("worlds")
        .withIndex("by_slug", (q) => q.eq("slug", wslug))
        .first();
      if (!world) throw new Error(`world not found: ${wslug}`);
      if (world.owner_user_id !== user_id)
        throw new Error("forbidden: only world owner may unset world-scoped flags");
      scope_id = world._id;
    } else if (scope_kind === "user" || scope_kind === "character") {
      const target_user_id =
        scope_kind === "user"
          ? (scope_id as Id<"users"> | undefined)
          : (await ctx.db.get(scope_id as Id<"characters">))?.user_id;
      if (!scope_id || target_user_id !== user_id)
        throw new Error("forbidden");
    }
    const existing = await ctx.db
      .query("feature_flags")
      .withIndex("by_key_scope", (q: any) =>
        q
          .eq("flag_key", flag_key)
          .eq("scope_kind", scope_kind)
          .eq("scope_id", scope_id ?? undefined),
      )
      .first();
    if (!existing) return { ok: true, deleted: 0 };
    await ctx.db.delete(existing._id);
    return { ok: true, deleted: 1 };
  },
});
