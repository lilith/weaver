# Weaver — Blob Storage

## Concept

Every durable piece of content in Weaver — location JSON, inline script source, world bible, theme JSON, image, module source — is stored as an **immutable, content-addressed blob**. The blob's address is the hash of its bytes. Same bytes → same hash → stored once.

Mutable state (what's the current version of this location, where is this character) lives in relational "heads" tables that *point* at blobs.

This separation is the single most leveraged architectural decision in the system. Once in place, it gives you for free:

- **Deduplication** — same content authored twice costs one blob.
- **Perfect backup/restore** — the blob store is append-only and durable; point-in-time restore is just replaying the heads tables to a timestamp.
- **Cheap branching** — a fork duplicates heads rows, not content. A million-location world forks in milliseconds.
- **Time travel** — every version is addressable; rewinding is just repointing heads.
- **Trivial rollback** — any prior version is one pointer update away.
- **Distributed-friendly** — content-addressed data replicates deterministically; agents can work offline and reconcile.
- **Audit** — the blob a user saw at a given moment is provably what they saw; hashes are tamper-evident.

This document is foundational. Every other spec now references it. Read it before the others if you're a new agent picking up the project.

## Hash algorithm

**BLAKE3**, truncated to 32 bytes (256 bits), hex-encoded.

Why BLAKE3 over SHA-256:
- 5-10x faster on modern CPUs.
- Tree-structured; streamable.
- 256-bit security is enough for content-addressing.

Hash of a blob is its canonical name. Canonicalization rules (below) ensure identical content always hashes identically.

## Canonicalization

Before hashing, content is normalized:

### JSON (locations, themes, world bibles, artifact versions)

- UTF-8 encoded.
- Keys sorted lexicographically at every depth.
- No trailing whitespace.
- Numbers in shortest canonical form (no trailing zeros, no leading zeros except for 0).
- No comments, no optional fields with null values (strip nulls before canonicalize).
- Newline-terminated.

Use `@aws-crypto/json-canonicalize` or equivalent. Write a single `canonicalizeJSON(obj): string` function and use it everywhere. Property-based tests assert `canonicalize(parse(canonicalize(x))) === canonicalize(x)` for arbitrary structures.

### Text (inline scripts, module source)

- UTF-8 encoded.
- Normalize line endings to LF.
- Strip trailing whitespace on each line.
- Single trailing newline.
- No other normalization (preserves author formatting).

### Images (PNG/WebP)

- No transformation. Hash raw bytes as produced by the generator.
- fal.ai / FLUX returns bytes; those bytes are the canonical form.
- If the user uploads an image, we hash the uploaded bytes as-is.

### Audio / future binary

- Hash raw bytes. No normalization.

## Storage tiers

Blobs live in one of two places based on size:

| Size | Location | Reason |
|---|---|---|
| < 4 KB | Convex `blobs` table (inline) | Avoid R2 round-trip for small hot data |
| ≥ 4 KB | Cloudflare R2 | Cheap, zero egress to Cloudflare Pages, unbounded size |

The `blobs` table in Convex tracks every blob regardless of where bytes live:

```ts
// convex/schema.ts addition
blobs: defineTable({
  hash: v.string(),                        // BLAKE3 hex
  size: v.number(),                        // bytes
  content_type: v.string(),                // "application/json" | "text/weaver-script" | "image/png" | ...
  storage: v.union(
    v.literal("inline"),
    v.literal("r2"),
  ),
  inline_bytes: v.optional(v.bytes()),     // populated when storage === "inline"
  r2_key: v.optional(v.string()),          // populated when storage === "r2"
  first_referenced_at: v.number(),
  last_marked_reachable_at: v.optional(v.number()),   // updated by the mark-sweep GC pass; unset blobs past grace age are swept
}).index("by_hash", ["hash"])
  .index("by_marked", ["last_marked_reachable_at"])
```

Note: earlier drafts used a `ref_count` column with increment/decrement on every heads change. Replaced by mark-sweep (§"Garbage collection") — refcount under concurrent mutations is a race-condition farm, and mark-sweep is simpler and provably correct.

`hash` is the primary lookup. The `by_hash` index makes exists-check O(1).

## R2 layout

```
r2://weaver-blobs/
  ├── blob/
  │   └── <first-2-hex>/
  │       └── <next-2-hex>/
  │           └── <full-hash>
```

Example: a blob with hash `a1b2c3...` lives at `blob/a1/b2/a1b2c3...`. Two-level fanout by hash prefix keeps directory sizes sane and makes manual inspection feasible.

Content-Type header set on upload. No other metadata needed — the hash is the name, the name is the truth.

## Write path

```ts
// packages/engine/blobs/write.ts
import { blake3 } from "@noble/hashes/blake3"

export async function writeBlob(
  ctx: MutationCtx,
  bytes: Uint8Array,
  content_type: string,
): Promise<string> {
  const hash = bytesToHex(blake3(bytes))
  const existing = await ctx.db.query("blobs").withIndex("by_hash", q => q.eq("hash", hash)).first()
  if (existing) return hash    // already stored; heads will reference it

  const storage = bytes.byteLength < 4096 ? "inline" : "r2"
  if (storage === "r2") {
    await uploadToR2(`blob/${hash.slice(0,2)}/${hash.slice(2,4)}/${hash}`, bytes, content_type)
  }

  await ctx.db.insert("blobs", {
    hash,
    size: bytes.byteLength,
    content_type,
    storage,
    inline_bytes: storage === "inline" ? bytes : undefined,
    r2_key: storage === "r2" ? `blob/${hash.slice(0,2)}/${hash.slice(2,4)}/${hash}` : undefined,
    first_referenced_at: Date.now(),
  })
  return hash
}
```

**Idempotency:** writing the same content twice is a no-op (the second write sees an existing row and returns the hash). Writes are safe to retry.

**Atomicity:** R2 upload happens before Convex insert, so a crash between them leaves an unreferenced R2 object (harmless, reclaimable by GC). Convex mutation is atomic — either blob row commits or it doesn't.

## Read path

```ts
export async function readBlob(
  ctx: QueryCtx,
  hash: string,
): Promise<Uint8Array> {
  const row = await ctx.db.query("blobs").withIndex("by_hash", q => q.eq("hash", hash)).first()
  if (!row) throw new Error(`blob not found: ${hash}`)
  if (row.storage === "inline") return row.inline_bytes!
  return await fetchFromR2(row.r2_key!)
}
```

Client-side reads of image blobs go directly to R2 via public URL (images have a public read policy); no Convex round-trip. Location JSON and other structured data flows through Convex queries which do blob dereferencing server-side.

## Schema integration

The rest of the schema changes minimally. Anywhere a payload was stored inline, it now stores a blob hash:

### Before (original spec)

```ts
artifact_versions: defineTable({
  artifact_entity_id: v.id("entities"),
  version: v.number(),
  payload: v.any(),                        // ← inline payload
  author_user_id: v.id("users"),
  ...
})
```

### After

```ts
artifact_versions: defineTable({
  artifact_entity_id: v.id("entities"),
  version: v.number(),
  blob_hash: v.string(),                   // ← content-addressed
  author_user_id: v.id("users"),
  ...
}).index("by_artifact_version", ["artifact_entity_id", "version"])
  .index("by_blob", ["blob_hash"])
```

Similarly, `components.payload` becomes `components.blob_hash`. Entity type and small metadata stay inline. A component record is then ~200 bytes regardless of the payload size.

Images: instead of storing an R2 URL in `entity.art_ref`, store a blob hash. Client resolves hash → URL via a public map `/api/blob/{hash} → r2_public_url` or by pattern-computing from hash.

## Entity "heads"

Each entity's *current* version is pointed to by the entity row itself, which acts as a head pointer:

```ts
entities: defineTable({
  // ... existing fields ...
  current_version: v.number(),             // points at artifact_versions.version
})
```

Reading an entity's current state:

```ts
async function readEntity(ctx, entity_id) {
  const entity = await ctx.db.get(entity_id)
  const version = await ctx.db.query("artifact_versions")
    .withIndex("by_artifact_version", q => q.eq("artifact_entity_id", entity_id).eq("version", entity.current_version))
    .first()
  const bytes = await readBlob(ctx, version.blob_hash)
  return JSON.parse(new TextDecoder().decode(bytes))
}
```

Readers ideally cache (hash → parsed) in-memory; same hash always gives same parsed object.

## Backup

Two ways, complementary:

### Continuous (free)

- Convex Pro includes automatic continuous backup with point-in-time restore (up to 14 days). Enable it.
- R2 is 11-nines durable out of the box. Cross-region replication available at extra cost; worth it for production.

That's it. With immutable blobs + durable R2 + Convex backups, you have a robust system without ever writing a backup script.

### Periodic snapshot (belt-and-suspenders)

For full off-platform backup (hedge against any single vendor outage):

```bash
# scripts/backup.sh — runs nightly via GitHub Actions
# Exports Convex data to JSON; R2 data is already durable + replicated.
npx convex export --path ./backups/$(date +%Y%m%d)/
rclone sync r2:weaver-blobs ./backups/$(date +%Y%m%d)/r2/ --progress
tar -czf ./backups/$(date +%Y%m%d).tar.gz ./backups/$(date +%Y%m%d)/
aws s3 cp ./backups/$(date +%Y%m%d).tar.gz s3://your-offsite-bucket/  # or Backblaze, etc.
```

A family's entire world, including all art, fits in ~100-500MB compressed. Nightly off-platform backup costs pennies.

## Restore

### Full restore (disaster recovery)

1. `npx convex import` the backup snapshot.
2. Sync R2 from offsite backup (usually unnecessary — R2 has 11-nines durability and hasn't lost your blobs).
3. Deploy Cloudflare Pages from git.
4. Flip DNS if the Convex deployment URL changed.

Total recovery time: <1 hour for a family-size world.

### Point-in-time restore (oops-I-broke-something)

Convex Pro supports this natively. Select timestamp, restore.

Or, since entity heads + artifact_versions are both preserved: query `artifact_versions` for each entity's "latest version where created_at ≤ target_time", set `entity.current_version` to that. Single Convex mutation, no data loss, reversible. Reverting a point-in-time restore is itself a point-in-time restore. Blobs are never deleted, so all history is intact.

### Per-artifact rollback

Already covered in `11_PROMPT_EDITING.md`. "Restore version N" is a single mutation updating `entity.current_version = N`. Even cleaner with blobs: no data movement, just pointer update.

## Garbage collection — mark-sweep

**Default policy: never delete.** A family's world is precious, storage is cheap. A fully-played 5-year world is probably under 5 GB. R2 at $0.015/GB-month = $0.075/month. Keep everything, forever.

**Optional: mark-sweep GC for aggressive cost control.**

Reference counting across concurrent mutations is famously hard — two mutations that both add a new reference and delete an old one can race and leave either orphan blobs (leak) or zero-ref blobs with live pointers (corruption). Mark-sweep avoids the race entirely: snapshot of live heads at a point in time, walk it, mark reachable blobs, sweep unreachable blobs older than a grace window.

### Mark phase (scheduled job, daily)

```ts
// convex/scheduled/markReachableBlobs.ts
export const markReachableBlobs = action(async (ctx) => {
  const now = Date.now()

  // Walk every heads-level table that references blobs.
  // artifact_versions.blob_hash, components.blob_hash, flows.state_blob_hash,
  // flow_transitions.state_blob_hash, mentorship_log.before/after_blob_hash,
  // art_queue.result_blob_hash.
  for (const row of await ctx.db.query("artifact_versions").collect()) {
    await markBlob(ctx, row.blob_hash, now)
  }
  for (const row of await ctx.db.query("components").filter(q => q.neq(q.field("blob_hash"), undefined)).collect()) {
    await markBlob(ctx, row.blob_hash!, now)
  }
  // ... one pass per referencing table ...
})

async function markBlob(ctx, hash, now) {
  const row = await ctx.db.query("blobs").withIndex("by_hash", q => q.eq("hash", hash)).first()
  if (row) await ctx.db.patch(row._id, { last_marked_reachable_at: now })
}
```

The mark phase is read-mostly and idempotent. Safe to re-run.

### Sweep phase (scheduled job, weekly, gated)

```ts
// convex/scheduled/sweepUnreachableBlobs.ts — DISABLED by default
export const sweepUnreachableBlobs = action(async (ctx) => {
  const grace_ms = 7 * 24 * 60 * 60 * 1000   // 7-day grace window
  const cutoff = Date.now() - grace_ms
  const unreachable = await ctx.db.query("blobs")
    .withIndex("by_marked", q => q.lt("last_marked_reachable_at", cutoff))
    .collect()
  for (const row of unreachable) {
    // Safety: only delete if older than grace AND not marked in the latest mark pass
    if ((row.last_marked_reachable_at ?? 0) > cutoff) continue
    if (row.storage === "r2") await deleteFromR2(row.r2_key!)
    await ctx.db.delete(row._id)
  }
})
```

**Default: disabled.** A family's world is small enough that storage cost is negligible. Enable only if storage grows enough to matter. When enabled, run the mark phase daily and the sweep phase weekly; the 7-day grace window combined with the mark-daily cadence gives a safety buffer against accidental data loss.

### Why mark-sweep over refcount

- Concurrent mutations can't corrupt the state — the mark phase is a single consistent read-pass.
- No rollback-hooks needed when a mutation fails mid-way (refcount requires careful decrement-on-rollback).
- New referencing tables are trivial to add: add them to the mark pass, done. Refcount requires plumbing every insert/delete site.
- Forks don't need to touch blob rows — blobs are "pointed at by heads" and mark-sweep discovers those pointers on the next pass.

### What mark-sweep cost to run

For a family world with ~10K locations, ~10K images, ~5K artifact versions: ~25K blob-pointing rows to walk per mark pass. Convex can stream this in a few seconds. Daily. Negligible.

## Migrating existing data

Wave 0 already wrote inline payloads. First step of Wave 1 is a one-time migration:

```ts
// convex/migrations/v1_inline_to_blobs.ts
export async function migrate_v1_inline_to_blobs(ctx) {
  const rows = await ctx.db.query("artifact_versions").filter(q => q.eq(q.field("blob_hash"), undefined)).collect()
  for (const row of rows) {
    const canonical = canonicalizeJSON(row.payload)
    const bytes = new TextEncoder().encode(canonical)
    const hash = await writeBlob(ctx, bytes, "application/json")
    await ctx.db.patch(row._id, { blob_hash: hash, payload: undefined })
  }
}
```

Run once at Wave 1 start. Keep the legacy `payload` field nullable for 30 days in case of rollback, then drop it.

## Integration into existing specs

The following docs need amendments when integrated:

- **`01_ARCHITECTURE.md`** — rewrite §"The store" to describe entity + components as pointers into the blob store. Add §"Blob storage" linking to this doc.
- **`02_LOCATION_SCHEMA.md`** — the LocationSchema definition is unchanged; only note that the location's payload is stored as a blob referenced by `artifact_versions.blob_hash`.
- **`11_PROMPT_EDITING.md`** — §"Versioning" update: artifact_versions stores `blob_hash` not `payload`; rollback mechanics simplify.
- **`09_TECH_STACK.md`** — add `@noble/hashes` to dependencies. Add `blobs` table to schema starter. Update `artifact_versions` and `components` schemas.

## Test coverage

- **Unit:** canonicalization is deterministic; hash is stable across runs; write is idempotent; read returns identical bytes to input.
- **Property:** for any JSON object, canonicalize(parse(canonicalize(x))) === canonicalize(x). For any sequence of writes and reads, bytes out == bytes in.
- **Integration:** write 1000 duplicate blobs → exactly 1 row (subsequent writes return the existing hash without inserting).
- **GC correctness:** write a blob, reference it from an entity, run mark; unreference the entity, run mark + sweep after grace; blob is deleted. And the reverse: write a blob, leave it referenced, run mark+sweep; blob is not deleted even across many cycles.
- **Crash simulation:** kill process between R2 upload and Convex insert; verify no corruption, orphan R2 objects are reclaimable by GC.
- **Migration:** v1_inline_to_blobs migration on a seeded Wave 0 snapshot produces identical read results before and after.

## Cost impact

Storage: a family of 5 playing for a year generates roughly:
- ~10K locations × ~3KB canonicalized JSON = 30 MB JSON blobs.
- ~10K images × ~300KB = 3 GB image blobs.
- ~2K chat messages × 200 bytes = 0.4 MB (stored per-message, not blobbed).
- ~5K artifact versions × ~3KB average = 15 MB edit history.

Total ~3 GB per family-year. R2 cost: **$0.045/month for the first year** of a family. Effectively zero.

Operations: each blob write is 1 Convex mutation + 0 or 1 R2 PUT. Each blob read is 1 Convex query + 0 or 1 R2 GET. Overhead versus inline storage: negligible, and zero for small blobs (inline path).

## Security

- Blob hashes are not secrets. They're not user-input; they're derived. Publishing a hash reveals nothing.
- R2 bucket policy: public read for image blobs (so `<img src="https://cdn.../blob/...">` works), authenticated write via Convex actions only.
- For JSON blobs, the policy is "public read via Convex query only" — the R2 bucket itself is not publicly listable. Convex action fetches, caches, serves via query.
- Content-Type headers set on upload, enforced on read — prevents serving a text blob as an image or vice versa.

## Open questions (answer during Wave 1 implementation)

- **Encryption at rest for private-world mode?** Probably not needed in Wave 1 (family beta) but flag for later. R2 supports server-side encryption automatically; application-level encryption (with user-held keys) is a Wave 3+ concern.
- **Signed URLs for image expiry?** Not for family mode. If public-world mode launches, revisit.
- **Content moderation on write?** Wave 1 skips it (closed family beta). Wave 2 should run image moderation check before committing an R2 upload.

## Why this is worth the extra complexity

Without blobs:
- Backup is a thing you have to implement.
- Rollback is copying whole payloads.
- Branching is copying whole entity trees (slow, expensive, risks corruption).
- Deduplication is nothing.
- Time travel is impossible.

With blobs:
- Backup happens by default.
- Rollback is a pointer update.
- Branching is O(metadata). A thousand-location world forks in milliseconds.
- Dedupe is automatic.
- Time travel is free (every hash is an address).

Forking (next doc) leans on this entirely. Without blobs, forking a large world would be days of engineering to get right. With blobs, it's one afternoon.
