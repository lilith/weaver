// Art generation — FLUX via fal.ai → bytes → R2 blob → patched entity.
//
// Flow (async, scheduler-driven so page renders aren't blocked):
//   mutation creates a location with art_status=queued
//     → ctx.scheduler.runAfter(0, internal.art.generateForEntity, { entity_id })
//   action generateForEntity loads context, calls fal.ai, uploads to R2,
//     then calls storeArtResult mutation which writes the blob row +
//     patches the entity with art_blob_hash + art_status=ready.

import { action, internalAction, internalMutation, internalQuery, query } from "./_generated/server.js";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internal, api } from "./_generated/api.js";
import { fal } from "@fal-ai/client";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { hashBytes } from "@weaver/engine/blobs";
import { readJSONBlob } from "./blobs.js";
import { resolveMember } from "./sessions.js";

const FLUX_MODEL = "fal-ai/flux/schnell";
const IMAGE_SIZE = "square_hd"; // 1024×1024, cheap + fast on FLUX.schnell

/** Schedule art gen for a freshly-created location entity. Called from
 *  seed + expansion's insertExpandedLocation mutations. Idempotent — if
 *  art is already queued/ready, this is a no-op. */
export async function scheduleArtForEntity(
  ctx: any,
  entity_id: Id<"entities">,
) {
  const entity = await ctx.db.get(entity_id);
  if (!entity) return;
  if (entity.art_status === "ready" || entity.art_status === "generating" || entity.art_status === "queued") {
    return;
  }
  await ctx.db.patch(entity_id, { art_status: "queued" });
  await ctx.scheduler.runAfter(0, internal.art.generateForEntity, {
    entity_id,
  });
}

// ---------------------------------------------------------------
// Action: runs outside transactional ctx, can hit network.

export const generateForEntity = internalAction({
  args: { entity_id: v.id("entities") },
  handler: async (ctx, { entity_id }) => {
    const info = await ctx.runQuery(internal.art.loadArtContext, {
      entity_id,
    });
    if (!info) return; // entity gone

    await ctx.runMutation(internal.art.markGenerating, { entity_id });

    try {
      fal.config({ credentials: process.env.FAL_KEY });
      const prompt = buildPrompt(info);
      const result: any = await fal.subscribe(FLUX_MODEL, {
        input: {
          prompt,
          image_size: IMAGE_SIZE,
          num_inference_steps: 4,
          num_images: 1,
          enable_safety_checker: true,
        },
        logs: false,
      });
      const imageUrl: string | undefined = result?.data?.images?.[0]?.url;
      if (!imageUrl) throw new Error("fal returned no image url");

      const imageResp = await fetch(imageUrl);
      if (!imageResp.ok) throw new Error(`image fetch ${imageResp.status}`);
      const bytes = new Uint8Array(await imageResp.arrayBuffer());
      const content_type = imageResp.headers.get("content-type") ?? "image/jpeg";

      const hash = hashBytes(bytes);
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
          ContentType: content_type,
          CacheControl: "public, max-age=31536000, immutable",
        }),
      );

      await ctx.runMutation(internal.art.storeArtResult, {
        entity_id,
        hash,
        size: bytes.byteLength,
        content_type,
        r2_key,
      });
    } catch (err) {
      await ctx.runMutation(internal.art.markFailed, {
        entity_id,
        message: (err as Error).message,
      });
    }
  },
});

function buildPrompt(info: {
  location_name?: string;
  location_description?: string;
  biome_name?: string;
  biome_prompt?: string;
  canonical_features?: string[];
  style_fragment?: string;
}): string {
  const parts: string[] = [];
  if (info.biome_prompt) parts.push(info.biome_prompt);
  if (info.canonical_features?.length) {
    parts.push(info.canonical_features.slice(0, 3).join(", "));
  } else if (info.location_description) {
    parts.push(info.location_description.replace(/\s+/g, " ").slice(0, 300));
  }
  if (info.style_fragment) parts.push(info.style_fragment);
  parts.push(
    "no characters, no text, cinematic framing, 16:9 establishing shot",
  );
  return parts.filter(Boolean).join(", ");
}

// ---------------------------------------------------------------
// Internal query: build the prompt context (location + biome + bible style).

export const loadArtContext = internalQuery({
  args: { entity_id: v.id("entities") },
  handler: async (ctx, { entity_id }) => {
    const entity = await ctx.db.get(entity_id);
    if (!entity) return null;
    if (entity.type !== "location") return null;

    const version = await ctx.db
      .query("artifact_versions")
      .withIndex("by_artifact_version", (q) =>
        q.eq("artifact_entity_id", entity._id).eq("version", entity.current_version),
      )
      .first();
    const loc = version
      ? await readJSONBlob<{
          name?: string;
          biome?: string;
          description_template?: string;
          canonical_features?: string[];
        }>(ctx as any, version.blob_hash)
      : null;

    // Bible for style anchor.
    const bibleEntity = await ctx.db
      .query("entities")
      .withIndex("by_branch_type_slug", (q) =>
        q.eq("branch_id", entity.branch_id).eq("type", "bible").eq("slug", "bible"),
      )
      .first();
    let style_fragment: string | undefined;
    if (bibleEntity) {
      const bv = await ctx.db
        .query("artifact_versions")
        .withIndex("by_artifact_version", (q) =>
          q.eq("artifact_entity_id", bibleEntity._id).eq("version", bibleEntity.current_version),
        )
        .first();
      const bible = bv
        ? await readJSONBlob<{ style_anchor?: { prompt_fragment?: string } }>(
            ctx as any,
            bv.blob_hash,
          )
        : null;
      style_fragment = bible?.style_anchor?.prompt_fragment;
    }

    // Biome for mood prompt.
    let biome_name: string | undefined;
    let biome_prompt: string | undefined;
    if (loc?.biome) {
      const biomeEntity = await ctx.db
        .query("entities")
        .withIndex("by_branch_type_slug", (q) =>
          q.eq("branch_id", entity.branch_id).eq("type", "biome").eq("slug", loc.biome!),
        )
        .first();
      if (biomeEntity) {
        const bv = await ctx.db
          .query("artifact_versions")
          .withIndex("by_artifact_version", (q) =>
            q
              .eq("artifact_entity_id", biomeEntity._id)
              .eq("version", biomeEntity.current_version),
          )
          .first();
        const biome = bv
          ? await readJSONBlob<{
              name?: string;
              establishing_shot_prompt?: string;
            }>(ctx as any, bv.blob_hash)
          : null;
        biome_name = biome?.name;
        biome_prompt = biome?.establishing_shot_prompt;
      }
    }

    return {
      location_name: loc?.name,
      location_description: loc?.description_template,
      canonical_features: loc?.canonical_features,
      biome_name,
      biome_prompt,
      style_fragment,
    };
  },
});

// ---------------------------------------------------------------
// Internal mutations: transitional state updates.

export const markGenerating = internalMutation({
  args: { entity_id: v.id("entities") },
  handler: async (ctx, { entity_id }) => {
    await ctx.db.patch(entity_id, { art_status: "generating" });
  },
});

export const markFailed = internalMutation({
  args: { entity_id: v.id("entities"), message: v.string() },
  handler: async (ctx, { entity_id, message }) => {
    await ctx.db.patch(entity_id, { art_status: "failed" });
    console.error(`[art] generateForEntity ${entity_id}: ${message}`);
  },
});

export const storeArtResult = internalMutation({
  args: {
    entity_id: v.id("entities"),
    hash: v.string(),
    size: v.number(),
    content_type: v.string(),
    r2_key: v.string(),
  },
  handler: async (ctx, { entity_id, hash, size, content_type, r2_key }) => {
    // Insert blob row if new (dedup by hash).
    const existing = await ctx.db
      .query("blobs")
      .withIndex("by_hash", (q) => q.eq("hash", hash))
      .first();
    if (!existing) {
      await ctx.db.insert("blobs", {
        hash,
        size,
        content_type,
        storage: "r2",
        r2_key,
        created_at: Date.now(),
      });
    }
    await ctx.db.patch(entity_id, {
      art_blob_hash: hash,
      art_status: "ready",
    });
  },
});

// ---------------------------------------------------------------
// User-facing action: manual regenerate.

export const regenerateArt = action({
  args: {
    session_token: v.string(),
    world_id: v.id("worlds"),
    location_slug: v.string(),
  },
  handler: async (
    ctx,
    { session_token, world_id, location_slug },
  ): Promise<{ queued: boolean }> => {
    // Verify membership inline so the scheduler call doesn't leak cross-world.
    const r: { entity_id: Id<"entities"> | null } = await ctx.runQuery(
      internal.art.lookupEntityAsMember,
      { session_token, world_id, location_slug },
    );
    if (!r.entity_id) throw new Error("location not found or forbidden");
    await ctx.runMutation(internal.art.resetAndEnqueue, { entity_id: r.entity_id });
    return { queued: true };
  },
});

export const lookupEntityAsMember = internalQuery({
  args: {
    session_token: v.string(),
    world_id: v.id("worlds"),
    location_slug: v.string(),
  },
  handler: async (ctx, { session_token, world_id, location_slug }) => {
    const { user_id } = await resolveMember(ctx as any, session_token, world_id);
    void user_id;
    const world = await ctx.db.get(world_id);
    if (!world?.current_branch_id) return { entity_id: null };
    const entity = await ctx.db
      .query("entities")
      .withIndex("by_branch_type_slug", (q) =>
        q.eq("branch_id", world.current_branch_id!).eq("type", "location").eq("slug", location_slug),
      )
      .first();
    return { entity_id: entity?._id ?? null };
  },
});

export const resetAndEnqueue = internalMutation({
  args: { entity_id: v.id("entities") },
  handler: async (ctx, { entity_id }) => {
    await ctx.db.patch(entity_id, { art_status: "queued", art_blob_hash: undefined });
    await ctx.scheduler.runAfter(0, internal.art.generateForEntity, {
      entity_id,
    });
  },
});
