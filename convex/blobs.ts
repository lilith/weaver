// Content-addressed blob storage — mark-sweep GC (rule #6 — no ref_count).
// Inline-only in Wave 0; R2 path lands with the art worker.

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
