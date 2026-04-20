// Blob store read/write — inline (Convex) path only in Wave 0.
// R2 path lands when the art worker starts uploading image bytes.
// spec/12_BLOB_STORAGE.md §Write path and §Read path.

import { internalMutation, internalQuery } from "./_generated/server.js";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel.js";
import {
  BLOB_INLINE_MAX_BYTES,
  canonicalizeJSON,
  hashBytes,
  utf8Decode,
  utf8Encode,
} from "@weaver/engine/blobs";

type BlobCtx = {
  db: {
    query: (name: "blobs") => {
      withIndex: (
        name: "by_hash",
        predicate: (q: { eq: (field: "hash", v: string) => unknown }) => unknown,
      ) => { first: () => Promise<Doc<"blobs"> | null> };
    };
    insert: (name: "blobs", row: Omit<Doc<"blobs">, "_id" | "_creationTime">) => Promise<unknown>;
    patch: (id: unknown, fields: Partial<Doc<"blobs">>) => Promise<void>;
    get: (id: unknown) => Promise<Doc<"blobs"> | null>;
  };
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
  const existing = await ctx.db
    .query("blobs")
    .withIndex("by_hash", (q) => q.eq("hash", hash))
    .first();
  const now = Date.now();
  if (existing) {
    await ctx.db.patch((existing as { _id: unknown })._id, {
      last_referenced_at: now,
      ref_count: (existing as Doc<"blobs">).ref_count + 1,
    });
    return hash;
  }
  // Convex's v.bytes() accepts ArrayBuffer. Slice to produce an
  // independent buffer view (safe even when bytes is a subarray).
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
    first_referenced_at: now,
    last_referenced_at: now,
    ref_count: 1,
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
  const row = await ctx.db
    .query("blobs")
    .withIndex("by_hash", (q) => q.eq("hash", hash))
    .first();
  if (!row) throw new Error(`blob not found: ${hash}`);
  const r = row as Doc<"blobs">;
  if (r.storage === "inline") {
    if (!r.inline_bytes) throw new Error(`inline blob ${hash} missing bytes`);
    return new Uint8Array(r.inline_bytes as ArrayBuffer);
  }
  throw new Error(`R2 blob read not wired in Wave 0: ${hash}`);
}

/** Parse a JSON blob back into a value. */
export async function readJSONBlob<T = unknown>(ctx: BlobCtx, hash: string): Promise<T> {
  const bytes = await readBlobBytes(ctx, hash);
  return JSON.parse(utf8Decode(bytes)) as T;
}

// Internal Convex function exposed for dashboard-driven ops.
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
      ref_count: row.ref_count,
    };
  },
});

export const putJSONBlob = internalMutation({
  args: { value: v.any() },
  handler: async (ctx, { value }) => writeJSONBlob(ctx, value),
});
