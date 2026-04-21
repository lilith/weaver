// Cross-world pixel-art tile library (pixellab-generated). Schema
// comment at convex/schema.ts `tile_library`.
//
// Flow:
//   1. Me (Claude) calls the pixellab MCP to generate tiles.
//   2. I hand the PNG bytes + generation metadata to ingestPixellabAsset.
//   3. Action decodes + hashes + uploads to R2 + writes a row.
//   4. map.loadWorldMap / play page look up the row for their
//      (style_tag, kind, subject) combo via pickLibraryAsset.
//
// R2 upload mirrors convex/art_curation.ts runGenVariant (S3 SDK +
// same key layout). The blobs table is bypassed for R2 assets by
// existing convention — the hash is the canonical reference.

import { action, mutation, query, internalMutation, internalQuery, internalAction } from "./_generated/server.js";
import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import { resolveMember, resolveSession } from "./sessions.js";
import { hashBytes } from "@weaver/engine/blobs";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import type { Doc, Id } from "./_generated/dataModel.js";

/** Public-facing R2 url for a tile blob. */
function publicUrlFor(hash: string): string | null {
  const base = process.env.R2_IMAGES_PUBLIC_URL;
  if (!base) return null;
  return `${base}/blob/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
}

/** Internal action used by the pixellab orchestration (called from
 *  an MCP-driven workflow that uploads base64 PNG bytes). */
export const ingestPixellabAsset = action({
  args: {
    session_token: v.string(),
    kind: v.union(
      v.literal("biome_tile"),
      v.literal("building"),
      v.literal("path"),
      v.literal("bridge"),
      v.literal("portrait"),
      v.literal("map_object"),
      v.literal("character_walk"),
      v.literal("misc"),
    ),
    style_tag: v.string(),
    subject_tags: v.array(v.string()),
    name: v.string(),
    png_base64: v.string(),
    width: v.number(),
    height: v.number(),
    view: v.optional(v.string()),
    pixellab_asset_id: v.optional(v.string()),
    pixellab_parent_id: v.optional(v.string()),
    generation: v.optional(v.any()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ tile_id: Id<"tile_library">; hash: string; url: string | null; deduped: boolean }> => {
    const user_id = await ctx.runQuery(internal.tile_library.resolveUser, {
      session_token: args.session_token,
    });
    if (!user_id) throw new Error("not authenticated");

    // Decode the base64 PNG. Node's atob + charCodeAt is slow for
    // large buffers; use Buffer if available (we run on Convex Node
    // runtime for actions).
    const bytes = decodeBase64(args.png_base64);
    if (bytes.length === 0) throw new Error("empty png_base64");
    const hash = hashBytes(bytes);

    // Dedup: if we've already ingested this exact hash, return it.
    const existing = await ctx.runQuery(internal.tile_library.findByHash, {
      blob_hash: hash,
    });
    if (existing) {
      return { tile_id: existing._id, hash, url: publicUrlFor(hash), deduped: true };
    }

    // R2 upload.
    const r2_key = `blob/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
    const s3 = new S3Client({
      region: "auto",
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID as string,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY as string,
      },
    });
    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.R2_IMAGES_BUCKET ?? "weaver-images",
        Key: r2_key,
        Body: bytes,
        ContentType: "image/png",
      }),
    );

    const tile_id = await ctx.runMutation(internal.tile_library.insertRow, {
      kind: args.kind,
      style_tag: args.style_tag,
      subject_tags: args.subject_tags,
      name: args.name,
      blob_hash: hash,
      width: args.width,
      height: args.height,
      view: args.view,
      pixellab_asset_id: args.pixellab_asset_id,
      pixellab_parent_id: args.pixellab_parent_id,
      generation: args.generation,
      created_by_user_id: user_id,
    });
    return { tile_id, hash, url: publicUrlFor(hash), deduped: false };
  },
});

function decodeBase64(b64: string): Uint8Array {
  // Strip `data:image/png;base64,` prefix if present.
  const comma = b64.indexOf(",");
  const payload = comma > 0 && b64.slice(0, comma).includes("base64") ? b64.slice(comma + 1) : b64;
  // Convex V8 action runtime — no Node `Buffer`. Use `atob` + manual
  // byte copy. For 128×128 PNGs (~10 KB) this is trivially cheap; we'd
  // want the Node runtime only if we start ingesting MB-sized frames.
  const bin = atob(payload);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// --------------------------------------------------------------------
// Internal helpers — mutations + queries invoked by the ingest action.

export const resolveUser = internalQuery({
  args: { session_token: v.string() },
  handler: async (ctx, { session_token }) => {
    // Library is cross-world; we only need an authenticated user to
    // attribute the created_by.
    try {
      const session = await resolveSession(ctx as any, session_token);
      return session?.user_id ?? null;
    } catch {
      return null;
    }
  },
});

export const findByHash = internalQuery({
  args: { blob_hash: v.string() },
  handler: async (ctx, { blob_hash }) => {
    return await ctx.db
      .query("tile_library")
      .withIndex("by_blob_hash", (q: any) => q.eq("blob_hash", blob_hash))
      .first();
  },
});

export const insertRow = internalMutation({
  args: {
    kind: v.union(
      v.literal("biome_tile"),
      v.literal("building"),
      v.literal("path"),
      v.literal("bridge"),
      v.literal("portrait"),
      v.literal("map_object"),
      v.literal("character_walk"),
      v.literal("misc"),
    ),
    style_tag: v.string(),
    subject_tags: v.array(v.string()),
    name: v.string(),
    blob_hash: v.string(),
    width: v.number(),
    height: v.number(),
    view: v.optional(v.string()),
    pixellab_asset_id: v.optional(v.string()),
    pixellab_parent_id: v.optional(v.string()),
    generation: v.optional(v.any()),
    created_by_user_id: v.id("users"),
  },
  handler: async (ctx, args) => {
    // Bump version if same (kind, style_tag, name) pair already exists.
    const prior = await ctx.db
      .query("tile_library")
      .withIndex("by_kind_style", (q: any) =>
        q.eq("kind", args.kind).eq("style_tag", args.style_tag),
      )
      .collect();
    const sameName = prior.filter((r: any) => r.name === args.name);
    const nextVersion = sameName.length === 0 ? 1 : Math.max(...sameName.map((r: any) => r.version)) + 1;
    // Prior same-name versions flip to inactive so lookup returns
    // the latest by default.
    for (const p of sameName) {
      if (p.active) await ctx.db.patch(p._id, { active: false });
    }
    return await ctx.db.insert("tile_library", {
      ...args,
      version: nextVersion,
      active: true,
      created_at: Date.now(),
    });
  },
});

// --------------------------------------------------------------------
// Read surface — browsing + lookups.

export const listByStyle = query({
  args: {
    session_token: v.string(),
    style_tag: v.optional(v.string()),
    kind: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { session_token, style_tag, kind, limit }) => {
    // Any authenticated user sees the shared library (single-instance).
    const session = await resolveSession(ctx, session_token);
    if (!session) return [];
    let rows: Doc<"tile_library">[];
    if (style_tag && kind) {
      const all = await ctx.db
        .query("tile_library")
        .withIndex("by_kind_style", (q: any) =>
          q.eq("kind", kind).eq("style_tag", style_tag),
        )
        .collect();
      rows = all;
    } else if (style_tag) {
      rows = await ctx.db
        .query("tile_library")
        .withIndex("by_style_active", (q: any) => q.eq("style_tag", style_tag))
        .collect();
    } else {
      rows = await ctx.db.query("tile_library").collect();
    }
    rows = rows.filter((r: any) => r.active);
    rows.sort((a: any, b: any) => b.created_at - a.created_at);
    return rows.slice(0, limit ?? 200).map((r: any) => ({
      id: r._id,
      kind: r.kind,
      style_tag: r.style_tag,
      subject_tags: r.subject_tags,
      name: r.name,
      url: publicUrlFor(r.blob_hash),
      width: r.width,
      height: r.height,
      version: r.version,
      created_at: r.created_at,
    }));
  },
});

/** Lists the distinct style_tags present in the library. */
export const listStyles = query({
  args: { session_token: v.string() },
  handler: async (ctx, { session_token }) => {
    const session = await resolveSession(ctx, session_token);
    if (!session) return [];
    const all = await ctx.db.query("tile_library").collect();
    const byStyle = new Map<string, { count: number; kinds: Set<string> }>();
    for (const r of all) {
      if (!r.active) continue;
      const cur = byStyle.get(r.style_tag) ?? { count: 0, kinds: new Set() };
      cur.count++;
      cur.kinds.add(r.kind);
      byStyle.set(r.style_tag, cur);
    }
    return Array.from(byStyle.entries())
      .map(([style_tag, { count, kinds }]) => ({
        style_tag,
        count,
        kinds: Array.from(kinds).sort(),
      }))
      .sort((a, b) => b.count - a.count);
  },
});

// --------------------------------------------------------------------
// World style binding — pick / pin.

export const getWorldBinding = query({
  args: { session_token: v.string(), world_slug: v.string() },
  handler: async (ctx, { session_token, world_slug }) => {
    const world = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q) => q.eq("slug", world_slug))
      .first();
    if (!world) return null;
    await resolveMember(ctx, session_token, world._id);
    const binding = await ctx.db
      .query("world_style_bindings")
      .withIndex("by_world", (q: any) => q.eq("world_id", world._id))
      .first();
    if (!binding) return { world_id: world._id, style_tag: null, biome_overrides: {}, entity_overrides: {} };
    return {
      world_id: world._id,
      style_tag: binding.style_tag,
      biome_overrides: binding.biome_overrides ?? {},
      entity_overrides: binding.entity_overrides ?? {},
      updated_at: binding.updated_at,
    };
  },
});

export const setWorldStyle = mutation({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    style_tag: v.string(),
  },
  handler: async (ctx, { session_token, world_slug, style_tag }) => {
    const world = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q) => q.eq("slug", world_slug))
      .first();
    if (!world) throw new Error("world not found");
    const { user_id } = await resolveMember(ctx, session_token, world._id);
    if (world.owner_user_id !== user_id)
      throw new Error("setWorldStyle is owner-only");
    const existing = await ctx.db
      .query("world_style_bindings")
      .withIndex("by_world", (q: any) => q.eq("world_id", world._id))
      .first();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { style_tag, updated_at: now });
      return { id: existing._id };
    }
    const id = await ctx.db.insert("world_style_bindings", {
      world_id: world._id,
      style_tag,
      biome_overrides: {},
      entity_overrides: {},
      updated_at: now,
    });
    return { id };
  },
});

export const pinEntityToTile = mutation({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    scope: v.union(v.literal("biome"), v.literal("entity")),
    slug: v.string(),
    tile_id: v.id("tile_library"),
  },
  handler: async (ctx, { session_token, world_slug, scope, slug, tile_id }) => {
    const world = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q) => q.eq("slug", world_slug))
      .first();
    if (!world) throw new Error("world not found");
    const { user_id } = await resolveMember(ctx, session_token, world._id);
    if (world.owner_user_id !== user_id) throw new Error("owner-only");
    const tile = await ctx.db.get(tile_id);
    if (!tile) throw new Error("tile not found");
    const existing = await ctx.db
      .query("world_style_bindings")
      .withIndex("by_world", (q: any) => q.eq("world_id", world._id))
      .first();
    const now = Date.now();
    if (!existing) {
      await ctx.db.insert("world_style_bindings", {
        world_id: world._id,
        style_tag: (tile as any).style_tag,
        biome_overrides: scope === "biome" ? { [slug]: tile_id } : {},
        entity_overrides: scope === "entity" ? { [slug]: tile_id } : {},
        updated_at: now,
      });
      return { created: true };
    }
    const next = { ...((scope === "biome" ? existing.biome_overrides : existing.entity_overrides) ?? {}) };
    next[slug] = tile_id;
    await ctx.db.patch(existing._id, {
      [scope === "biome" ? "biome_overrides" : "entity_overrides"]: next,
      updated_at: now,
    });
    return { updated: true };
  },
});

// --------------------------------------------------------------------
// Lookup — pick a tile for a (world, kind, subject).

/** Deterministic string→int hash for stable tile selection. */
function stableHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Pick a library tile for a (world, subject) pair. Respects entity
 *  override > biome override > style-matched deterministic pick. Returns
 *  null when no candidates exist — caller falls back to palette. */
export const pickTileForEntity = query({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    kind: v.string(),
    subject: v.string(),
    entity_slug: v.optional(v.string()),
  },
  handler: async (ctx, { session_token, world_slug, kind, subject, entity_slug }) => {
    const world = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q) => q.eq("slug", world_slug))
      .first();
    if (!world) return null;
    await resolveMember(ctx, session_token, world._id);
    const binding = await ctx.db
      .query("world_style_bindings")
      .withIndex("by_world", (q: any) => q.eq("world_id", world._id))
      .first();
    if (!binding) return null;
    // Entity override first.
    if (entity_slug) {
      const pinId = (binding.entity_overrides ?? {})[entity_slug];
      if (pinId) {
        const row = await ctx.db.get(pinId as Id<"tile_library">);
        if (row) return makeTileResult(row);
      }
    }
    // Biome override (subject is treated as biome slug for biome_tile).
    const biomePin = (binding.biome_overrides ?? {})[subject];
    if (biomePin) {
      const row = await ctx.db.get(biomePin as Id<"tile_library">);
      if (row) return makeTileResult(row);
    }
    // Deterministic pick from style + kind + subject-tag match.
    const candidates = await ctx.db
      .query("tile_library")
      .withIndex("by_kind_style", (q: any) =>
        q.eq("kind", kind).eq("style_tag", binding.style_tag),
      )
      .collect();
    const matching = candidates.filter(
      (r: any) =>
        r.active && (r.subject_tags ?? []).some((t: string) => t === subject),
    );
    if (matching.length === 0) return null;
    const idx = stableHash(entity_slug ?? subject) % matching.length;
    return makeTileResult(matching[idx]);
  },
});

function makeTileResult(row: Doc<"tile_library">): {
  id: Id<"tile_library">;
  name: string;
  kind: string;
  style_tag: string;
  url: string | null;
  width: number;
  height: number;
} {
  return {
    id: row._id,
    name: row.name,
    kind: row.kind,
    style_tag: row.style_tag,
    url: publicUrlFor(row.blob_hash),
    width: row.width,
    height: row.height,
  };
}
