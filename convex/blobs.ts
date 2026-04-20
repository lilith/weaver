// Content-addressed blob storage — mark-sweep GC (rule #6 — no ref_count).
// Inline storage for JSON + small assets; R2 for images.

import { internalMutation, internalQuery, query } from "./_generated/server.js";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel.js";
import {
  BLOB_INLINE_MAX_BYTES,
  canonicalizeJSON,
  hashBytes,
  utf8Decode,
  utf8Encode,
} from "@weaver/engine/blobs";

// Loose ctx shape for use from any Convex mutation/action. Uses `any`
// on the db methods rather than hand-rolling matching signatures — the
// real Convex GenericMutationCtx has overloaded methods with option
// bags our hand-rolled types can't express. Callers pass `ctx` and
// TypeScript on the outside wall does the real validation; inside
// blobs.ts the helpers just need `db.query / db.insert / db.patch /
// db.get` available.
type BlobCtx = {
  db: any;
};

/** Write bytes as a content-addressed blob. Idempotent by hash. */
export async function writeBlobBytes(
  ctx: BlobCtx,
  bytes: Uint8Array,
  content_type: string,
): Promise<string> {
  if (bytes.byteLength > BLOB_INLINE_MAX_BYTES) {
    throw new Error(
      `blob ${bytes.byteLength}B exceeds inline limit ${BLOB_INLINE_MAX_BYTES}B; R2 path not wired in Wave 0`,
    );
  }
  const hash = hashBytes(bytes);
  const existing = (await ctx.db
    .query("blobs")
    .withIndex("by_hash", (q: any) => q.eq("hash", hash))
    .first()) as Doc<"blobs"> | null;
  if (existing) return hash;

  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
  await ctx.db.insert("blobs", {
    hash,
    size: bytes.byteLength,
    content_type,
    storage: "inline",
    inline_bytes: buf,
    created_at: Date.now(),
  });
  return hash;
}

/** Canonicalize and write a JSON blob. Returns the hash. */
export async function writeJSONBlob(ctx: BlobCtx, value: unknown): Promise<string> {
  const bytes = utf8Encode(canonicalizeJSON(value));
  return writeBlobBytes(ctx, bytes, "application/json");
}

/** Read blob bytes by hash. */
export async function readBlobBytes(
  ctx: BlobCtx,
  hash: string,
): Promise<Uint8Array> {
  const row = (await ctx.db
    .query("blobs")
    .withIndex("by_hash", (q: any) => q.eq("hash", hash))
    .first()) as Doc<"blobs"> | null;
  if (!row) throw new Error(`blob not found: ${hash}`);
  if (row.storage === "inline") {
    if (!row.inline_bytes) throw new Error(`inline blob ${hash} missing bytes`);
    return new Uint8Array(row.inline_bytes as ArrayBuffer);
  }
  throw new Error(`R2 blob read not wired in Wave 0: ${hash}`);
}

export async function readJSONBlob<T = unknown>(ctx: BlobCtx, hash: string): Promise<T> {
  const bytes = await readBlobBytes(ctx, hash);
  return JSON.parse(utf8Decode(bytes)) as T;
}

export const getBlob = internalQuery({
  args: { hash: v.string() },
  handler: async (ctx, { hash }) => {
    const row = await ctx.db
      .query("blobs")
      .withIndex("by_hash", (q) => q.eq("hash", hash))
      .first();
    if (!row) return null;
    return {
      hash: row.hash,
      size: row.size,
      content_type: row.content_type,
      storage: row.storage,
    };
  },
});

// --------------------------------------------------------------------
// Mark-sweep GC (spec 12). Runs weekly. Walks every referrer column,
// collects referenced hashes, deletes blobs rows that are (a) not in
// the referent set and (b) older than BLOB_GC_AGE_MS. Inline blobs
// release storage immediately; r2-storage orphans are counted but
// not deleted — a separate cloudflare worker handles R2 object sweep
// against the manifest we emit.

const BLOB_GC_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30d

export const gcBlobs = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const cutoff = now - BLOB_GC_AGE_MS;
    const referenced = new Set<string>();
    // Walk every column that carries a blob hash. All loops are
    // single-table scans — cheap at our scale.
    for (const e of await ctx.db.query("entities").collect()) {
      if (e.art_blob_hash) referenced.add(e.art_blob_hash);
    }
    for (const v of await ctx.db.query("artifact_versions").collect()) {
      if (v.blob_hash) referenced.add(v.blob_hash);
    }
    for (const c of await ctx.db.query("components").collect()) {
      if (c.blob_hash) referenced.add(c.blob_hash);
    }
    for (const r of await ctx.db.query("entity_art_renderings").collect()) {
      if (r.blob_hash) referenced.add(r.blob_hash);
    }
    const rows = await ctx.db.query("blobs").collect();
    let inlineDeleted = 0;
    let r2Orphaned = 0;
    let kept = 0;
    const r2Keys: string[] = [];
    for (const row of rows) {
      const stale = row.created_at < cutoff;
      const orphan = !referenced.has(row.hash);
      if (orphan && stale) {
        if (row.storage === "inline") {
          await ctx.db.delete(row._id);
          inlineDeleted++;
        } else if (row.storage === "r2") {
          // Flag but don't delete the row — a separate R2 sweep needs
          // the hash list. We emit r2Keys in the return for the worker.
          r2Orphaned++;
          if (row.r2_key) r2Keys.push(row.r2_key);
        }
      } else {
        kept++;
      }
    }
    return {
      inline_deleted: inlineDeleted,
      r2_orphaned: r2Orphaned,
      kept,
      ran_at: now,
      r2_keys_for_sweep: r2Keys.slice(0, 200),
    };
  },
});

/** CLI surface to preview GC without running it. */
export const previewBlobGc = query({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const cutoff = now - BLOB_GC_AGE_MS;
    const referenced = new Set<string>();
    for (const e of await ctx.db.query("entities").collect())
      if (e.art_blob_hash) referenced.add(e.art_blob_hash);
    for (const v of await ctx.db.query("artifact_versions").collect())
      referenced.add(v.blob_hash);
    for (const c of await ctx.db.query("components").collect())
      referenced.add(c.blob_hash);
    for (const r of await ctx.db.query("entity_art_renderings").collect())
      if (r.blob_hash) referenced.add(r.blob_hash);
    let inlineStale = 0;
    let r2Stale = 0;
    let totalInline = 0;
    let totalR2 = 0;
    let bytesInlineStale = 0;
    for (const row of await ctx.db.query("blobs").collect()) {
      if (row.storage === "inline") totalInline++;
      else totalR2++;
      if (!referenced.has(row.hash) && row.created_at < cutoff) {
        if (row.storage === "inline") {
          inlineStale++;
          bytesInlineStale += row.size ?? 0;
        } else r2Stale++;
      }
    }
    return {
      inline_stale: inlineStale,
      r2_stale: r2Stale,
      bytes_inline_stale: bytesInlineStale,
      total_inline: totalInline,
      total_r2: totalR2,
      cutoff_at: cutoff,
    };
  },
});
