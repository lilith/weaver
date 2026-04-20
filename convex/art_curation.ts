// Art curation — entity_art_renderings-based wardrobe (spec ART_CURATION.md).
//
// Flag-gated: `flag.art_curation`. When off, the legacy `entities.art_blob_hash`
// single-slot path stays live. When on, callers read from renderings;
// writes go through the wardrobe mutations here.
//
// Sequence for a typical visit:
//   1. Player opens eye on a location → client calls
//      art_curation.getRenderingsForEntity.
//   2. Family member taps a mode → art_curation.conjureForEntity creates a
//      rendering row in queued state, schedules runGenVariant.
//   3. runGenVariant calls fal.ai with the mode-prompt, stores result
//      blob, patches rendering to ready.
//   4. Family votes → art_curation.upvoteVariant; triggers reference-board
//      propagation indirectly via `addToReferenceBoard`.
//   5. Prefer mode per-character: characters.art_mode_preferred; falls
//      through to top-voted → ambient_palette.

import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server.js";
import { internal, api } from "./_generated/api.js";
import { resolveSession, resolveMember } from "./sessions.js";
import { isFeatureEnabled } from "./flags.js";
import { readJSONBlob } from "./blobs.js";
import { appendMentorship } from "./mentorship.js";
import { falCostUsd } from "./cost.js";
import {
  MODE_PROMPTS,
  MODE_SIZES,
  WAVE_2_MODES,
  isValidMode,
  nextVariantIndex,
  type ArtPromptCtx,
} from "@weaver/engine/art";
import { hashBytes } from "@weaver/engine/blobs";
import { fal } from "@fal-ai/client";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import type { Doc, Id } from "./_generated/dataModel.js";

const FLUX_MODEL = "fal-ai/flux/schnell";
// When at least one matching reference board entry exists, switch to
// flux-pro/kontext which accepts an image_url for reference-guided
// generation. Single-image reference is the sweet spot: strong style
// transfer with ~10s latency vs schnell's ~3s.
const FLUX_REF_MODEL = "fal-ai/flux-pro/kontext";

// --------------------------------------------------------------------
// Queries

/** All renderings for an entity, grouped by mode, ordered by upvote desc
 *  then by recency. Hidden variants are excluded. */
export const getRenderingsForEntity = query({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    entity_id: v.id("entities"),
  },
  handler: async (ctx, { session_token, world_slug, entity_id }) => {
    const world = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q) => q.eq("slug", world_slug))
      .first();
    if (!world) return null;
    await resolveMember(ctx, session_token, world._id);
    const entity = await ctx.db.get(entity_id);
    if (!entity || entity.world_id !== world._id) return null;
    const rows = await ctx.db
      .query("entity_art_renderings")
      .withIndex("by_entity_mode", (q) => q.eq("entity_id", entity_id))
      .collect();
    const visible = rows.filter((r: any) => r.status !== "hidden");
    // Group by mode.
    const byMode: Record<string, any[]> = {};
    for (const r of visible) {
      byMode[r.mode] ??= [];
      byMode[r.mode].push({
        id: r._id,
        variant_index: r.variant_index,
        blob_hash: r.blob_hash ?? null,
        status: r.status,
        upvote_count: r.upvote_count,
        prompt_used: r.prompt_used,
        created_at: r.created_at,
        requested_by_user_id: r.requested_by_user_id,
      });
    }
    // Order each group by upvote desc, then recency desc.
    for (const mode of Object.keys(byMode)) {
      byMode[mode].sort((a, b) => {
        if (b.upvote_count !== a.upvote_count)
          return b.upvote_count - a.upvote_count;
        return b.created_at - a.created_at;
      });
    }
    return {
      entity_id,
      entity_slug: entity.slug,
      entity_type: entity.type,
      modes: byMode,
      wave_2_modes: [...WAVE_2_MODES],
    };
  },
});

// --------------------------------------------------------------------
// Conjure — create rendering + schedule gen

export const conjureForEntity = action({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    entity_id: v.id("entities"),
    mode: v.string(),
  },
  handler: async (
    ctx,
    { session_token, world_slug, entity_id, mode },
  ): Promise<{ rendering_id: Id<"entity_art_renderings">; status: string }> => {
    if (!isValidMode(mode)) throw new Error(`unknown art mode: ${mode}`);
    const info = await ctx.runQuery(internal.art_curation.conjureContext, {
      session_token,
      world_slug,
      entity_id,
    });
    if (!info.flag_on) throw new Error("flag.art_curation is off for this world");

    // ambient_palette is free; no FLUX call. Create the rendering row
    // immediately as ready, hashing derived-from-style-anchor bytes.
    if (mode === "ambient_palette") {
      const { rendering_id } = await ctx.runMutation(
        internal.art_curation.insertRendering,
        {
          world_id: info.world_id,
          branch_id: info.branch_id,
          entity_id,
          mode,
          variant_index: info.next_variant_for_mode[mode] ?? 1,
          prompt_used: "ambient_palette (derived)",
          requested_by_user_id: info.user_id,
          status: "ready",
        },
      );
      return { rendering_id, status: "ready" };
    }

    // Real modes: queue + schedule FLUX.
    const { rendering_id } = await ctx.runMutation(
      internal.art_curation.insertRendering,
      {
        world_id: info.world_id,
        branch_id: info.branch_id,
        entity_id,
        mode,
        variant_index: info.next_variant_for_mode[mode] ?? 1,
        prompt_used: "(pending — filled on gen)",
        requested_by_user_id: info.user_id,
        status: "queued",
      },
    );
    await ctx.scheduler.runAfter(0, internal.art_curation.runGenVariant, {
      rendering_id,
    });
    return { rendering_id, status: "queued" };
  },
});

export const conjureContext = internalQuery({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    entity_id: v.id("entities"),
  },
  handler: async (ctx, { session_token, world_slug, entity_id }) => {
    const world = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q: any) => q.eq("slug", world_slug))
      .first();
    if (!world) throw new Error(`world not found: ${world_slug}`);
    const { user_id } = await resolveMember(ctx as any, session_token, world._id);
    const entity = await ctx.db.get(entity_id);
    if (!entity || entity.world_id !== world._id)
      throw new Error("entity not in this world");
    const branch_id = world.current_branch_id!;
    const flag_on = await isFeatureEnabled(ctx, "flag.art_curation", {
      world_id: world._id,
      user_id,
    });
    // Current variant numbers per mode.
    const existing = await ctx.db
      .query("entity_art_renderings")
      .withIndex("by_entity_mode", (q: any) => q.eq("entity_id", entity_id))
      .collect();
    const next_variant_for_mode: Record<string, number> = {};
    for (const mode of Object.keys(MODE_PROMPTS)) {
      const inMode = existing.filter((r: any) => r.mode === mode);
      next_variant_for_mode[mode] = nextVariantIndex(inMode.map((r: any) => r.variant_index));
    }
    return {
      world_id: world._id,
      branch_id,
      user_id,
      flag_on,
      next_variant_for_mode,
    };
  },
});

export const insertRendering = internalMutation({
  args: {
    world_id: v.id("worlds"),
    branch_id: v.id("branches"),
    entity_id: v.id("entities"),
    mode: v.string(),
    variant_index: v.number(),
    prompt_used: v.string(),
    requested_by_user_id: v.id("users"),
    status: v.union(
      v.literal("queued"),
      v.literal("generating"),
      v.literal("ready"),
      v.literal("failed"),
      v.literal("hidden"),
    ),
    blob_hash: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const id = await ctx.db.insert("entity_art_renderings", {
      world_id: args.world_id,
      branch_id: args.branch_id,
      entity_id: args.entity_id,
      mode: args.mode,
      variant_index: args.variant_index,
      blob_hash: args.blob_hash,
      status: args.status,
      prompt_used: args.prompt_used,
      requested_by_user_id: args.requested_by_user_id,
      upvote_count: 0,
      created_at: now,
      updated_at: now,
    });
    return { rendering_id: id };
  },
});

// --------------------------------------------------------------------
// Gen — the FLUX call, run by the scheduler

export const runGenVariant = internalAction({
  args: { rendering_id: v.id("entity_art_renderings") },
  handler: async (ctx, { rendering_id }) => {
    const info = await ctx.runQuery(internal.art_curation.loadRenderingCtx, {
      rendering_id,
    });
    if (!info) return;
    await ctx.runMutation(internal.art_curation.markRenderingGenerating, {
      rendering_id,
    });
    try {
      const promptFn = MODE_PROMPTS[info.mode] ?? MODE_PROMPTS.hero_full;
      const prompt = promptFn(info.prompt_ctx as ArtPromptCtx);
      const size = MODE_SIZES[info.mode] ?? "square_hd";

      fal.config({ credentials: process.env.FAL_KEY });
      const refHash = (info as any).ref_blob_hash as string | null;
      const refKind = (info as any).ref_kind_used as string | null;
      const r2Public = process.env.R2_IMAGES_PUBLIC_URL;
      // Reference-guided gen: if the reference board has a relevant
      // pinned blob AND we have a public R2 URL for it, call
      // flux-pro/kontext with that image_url. Else fall back to schnell.
      let result: any;
      let modelUsed = FLUX_MODEL;
      let promptNote = "";
      if (refHash && r2Public) {
        const refUrl = `${r2Public}/blob/${refHash.slice(0, 2)}/${refHash.slice(2, 4)}/${refHash}`;
        modelUsed = FLUX_REF_MODEL;
        promptNote = ` [ref: ${refKind}]`;
        result = await fal.subscribe(FLUX_REF_MODEL, {
          input: {
            prompt,
            image_url: refUrl,
            // kontext tuning — these are typical defaults; fal ignores
            // unknown keys.
            num_images: 1,
            safety_tolerance: "2",
            guidance_scale: 3.5,
          } as any,
          logs: false,
        });
      } else {
        result = await fal.subscribe(FLUX_MODEL, {
          input: {
            prompt,
            image_size: size as any,
            num_inference_steps: 4,
            num_images: 1,
            enable_safety_checker: true,
          },
          logs: false,
        });
      }
      await ctx.runMutation(internal.cost.logCostUsd, {
        world_id: info.world_id,
        kind: `fal:${modelUsed}:art_variant`,
        cost_usd: falCostUsd(modelUsed),
        reason: `${info.entity_slug} ${info.mode} variant${promptNote}`,
      });
      const imageUrl: string | undefined = result?.data?.images?.[0]?.url;
      if (!imageUrl) throw new Error("fal returned no image url");

      const imageResp = await fetch(imageUrl);
      if (!imageResp.ok) throw new Error(`image fetch ${imageResp.status}`);
      const bytes = new Uint8Array(await imageResp.arrayBuffer());
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
          ContentType: imageResp.headers.get("content-type") ?? "image/jpeg",
        }),
      );
      await ctx.runMutation(internal.art_curation.markRenderingReady, {
        rendering_id,
        blob_hash: hash,
        prompt_used: `${modelUsed}${promptNote} · ${prompt}`,
      });
    } catch (e: any) {
      await ctx.runMutation(internal.art_curation.markRenderingFailed, {
        rendering_id,
        error: String(e?.message ?? e),
      });
    }
  },
});

export const loadRenderingCtx = internalQuery({
  args: { rendering_id: v.id("entity_art_renderings") },
  handler: async (ctx, { rendering_id }) => {
    const rendering = await ctx.db.get(rendering_id);
    if (!rendering) return null;
    const entity = await ctx.db.get(rendering.entity_id);
    if (!entity) return null;
    const world = await ctx.db.get(rendering.world_id);
    const branch_id = rendering.branch_id;
    // Pull the entity's authored payload so the prompt can reference
    // name/description/portrait_prompt/establishing_shot_prompt.
    const version = await ctx.db
      .query("artifact_versions")
      .withIndex("by_artifact_version", (q: any) =>
        q.eq("artifact_entity_id", entity._id).eq("version", entity.current_version),
      )
      .first();
    const payload = version
      ? await readJSONBlob<Record<string, any>>(ctx as any, version.blob_hash)
      : {};
    // Style anchor from the world's bible.
    const bibleEntity = await ctx.db
      .query("entities")
      .withIndex("by_branch_type_slug", (q: any) =>
        q.eq("branch_id", branch_id).eq("type", "bible").eq("slug", "bible"),
      )
      .first();
    let bible: any = {};
    if (bibleEntity) {
      const bv = await ctx.db
        .query("artifact_versions")
        .withIndex("by_artifact_version", (q: any) =>
          q
            .eq("artifact_entity_id", bibleEntity._id)
            .eq("version", bibleEntity.current_version),
        )
        .first();
      if (bv) bible = await readJSONBlob<any>(ctx as any, bv.blob_hash);
    }
    // Reference-board lookup — pick the most-recent (highest order)
    // entry for whichever kind best matches this entity + mode. Priority:
    //   character:<slug> / npc:<slug> / item:<slug>   (entity-specific)
    //   biome:<biome>                                  (scene continuity)
    //   mode:<mode>                                    (treatment style)
    //   style                                          (world aesthetic)
    // Only the top-1 is used because flux-pro/kontext takes a single
    // image_url and multi-ref lands in a future pass.
    const candidateKinds: string[] = [];
    if (entity.type === "character" || entity.type === "npc" || entity.type === "item") {
      candidateKinds.push(`${entity.type}:${entity.slug}`);
    }
    if (payload?.biome && entity.type === "location") {
      candidateKinds.push(`biome:${payload.biome}`);
    }
    candidateKinds.push(`mode:${rendering.mode}`);
    candidateKinds.push("style");

    let refBlobHash: string | null = null;
    let refKindUsed: string | null = null;
    for (const k of candidateKinds) {
      const rows = await ctx.db
        .query("art_reference_board")
        .withIndex("by_world_kind", (q: any) =>
          q.eq("world_id", rendering.world_id).eq("kind", k),
        )
        .collect();
      if (rows.length === 0) continue;
      // Highest order = most-recently-pinned canonical. Walk the pins
      // newest-first, skipping any whose rendering isn't ready-with-blob.
      rows.sort((a: any, b: any) => b.order - a.order);
      for (const r of rows) {
        const rend = (await ctx.db.get(r.rendering_id)) as any;
        if (!rend || rend.status !== "ready" || !rend.blob_hash) continue;
        refBlobHash = rend.blob_hash;
        refKindUsed = k;
        break;
      }
      if (refBlobHash) break;
    }

    return {
      mode: rendering.mode,
      world_id: rendering.world_id,
      entity_slug: entity.slug,
      prompt_ctx: {
        entity: {
          name: payload?.name ?? entity.slug,
          description:
            payload?.description ?? payload?.description_template ?? undefined,
          portrait_prompt: payload?.portrait_prompt,
          establishing_shot_prompt: payload?.establishing_shot_prompt,
          slug: entity.slug,
          kind: entity.type,
        },
        world_style_anchor: bible?.style_anchor,
      },
      ref_blob_hash: refBlobHash,
      ref_kind_used: refKindUsed,
    };
  },
});

export const markRenderingGenerating = internalMutation({
  args: { rendering_id: v.id("entity_art_renderings") },
  handler: async (ctx, { rendering_id }) => {
    await ctx.db.patch(rendering_id, {
      status: "generating",
      updated_at: Date.now(),
    });
  },
});

export const markRenderingReady = internalMutation({
  args: {
    rendering_id: v.id("entity_art_renderings"),
    blob_hash: v.string(),
    prompt_used: v.string(),
  },
  handler: async (ctx, { rendering_id, blob_hash, prompt_used }) => {
    await ctx.db.patch(rendering_id, {
      status: "ready",
      blob_hash,
      prompt_used,
      updated_at: Date.now(),
    });
  },
});

export const markRenderingFailed = internalMutation({
  args: {
    rendering_id: v.id("entity_art_renderings"),
    error: v.string(),
  },
  handler: async (ctx, { rendering_id, error }) => {
    await ctx.db.patch(rendering_id, {
      status: "failed",
      error,
      updated_at: Date.now(),
    });
  },
});

// --------------------------------------------------------------------
// Variant-level operations: regen, delete, upvote, feedback, board

/** Regenerate: creates a fresh rendering row in the same mode, scheduling
 *  a new FLUX gen. Older variants stay. */
export const regenVariant = action({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    rendering_id: v.id("entity_art_renderings"),
  },
  handler: async (
    ctx,
    { session_token, world_slug, rendering_id },
  ): Promise<{ rendering_id: Id<"entity_art_renderings">; status: string }> => {
    const info = await ctx.runQuery(internal.art_curation.regenContext, {
      session_token,
      world_slug,
      rendering_id,
    });
    if (!info) throw new Error("rendering not found or forbidden");
    // Log regen request for feedback telemetry.
    await ctx.runMutation(internal.art_curation.logFeedback, {
      world_id: info.world_id,
      rendering_id,
      user_id: info.user_id,
      action: "regen_requested",
    });
    return await ctx.runAction(api.art_curation.conjureForEntity, {
      session_token,
      world_slug,
      entity_id: info.entity_id,
      mode: info.mode,
    });
  },
});

export const regenContext = internalQuery({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    rendering_id: v.id("entity_art_renderings"),
  },
  handler: async (ctx, { session_token, world_slug, rendering_id }) => {
    const world = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q: any) => q.eq("slug", world_slug))
      .first();
    if (!world) return null;
    const { user_id } = await resolveMember(ctx as any, session_token, world._id);
    const rendering = await ctx.db.get(rendering_id);
    if (!rendering || rendering.world_id !== world._id) return null;
    return {
      world_id: world._id,
      user_id,
      entity_id: rendering.entity_id,
      mode: rendering.mode,
    };
  },
});

/** Soft-delete (status → hidden). Non-destructive. */
export const deleteVariant = mutation({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    rendering_id: v.id("entity_art_renderings"),
  },
  handler: async (ctx, { session_token, world_slug, rendering_id }) => {
    const world = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q) => q.eq("slug", world_slug))
      .first();
    if (!world) throw new Error(`world not found: ${world_slug}`);
    const { user_id } = await resolveMember(ctx, session_token, world._id);
    const rendering = await ctx.db.get(rendering_id);
    if (!rendering || rendering.world_id !== world._id)
      throw new Error("rendering not in this world");
    await ctx.db.patch(rendering_id, {
      status: "hidden",
      updated_at: Date.now(),
    });
    await ctx.db.insert("art_feedback", {
      world_id: world._id,
      rendering_id,
      user_id,
      action: "delete",
      created_at: Date.now(),
    });
    return { ok: true };
  },
});

/** Undelete (hidden → ready) — recovery. */
export const undeleteVariant = mutation({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    rendering_id: v.id("entity_art_renderings"),
  },
  handler: async (ctx, { session_token, world_slug, rendering_id }) => {
    const world = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q) => q.eq("slug", world_slug))
      .first();
    if (!world) throw new Error(`world not found: ${world_slug}`);
    const { user_id } = await resolveMember(ctx, session_token, world._id);
    const rendering = await ctx.db.get(rendering_id);
    if (!rendering || rendering.world_id !== world._id)
      throw new Error("rendering not in this world");
    if (rendering.status !== "hidden")
      throw new Error("rendering isn't hidden");
    await ctx.db.patch(rendering_id, {
      status: "ready",
      updated_at: Date.now(),
    });
    await ctx.db.insert("art_feedback", {
      world_id: world._id,
      rendering_id,
      user_id,
      action: "undelete",
      created_at: Date.now(),
    });
    return { ok: true };
  },
});

/** Upvote: one per (rendering, user). Denormalizes count on rendering.  */
export const upvoteVariant = mutation({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    rendering_id: v.id("entity_art_renderings"),
  },
  handler: async (ctx, { session_token, world_slug, rendering_id }) => {
    const world = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q) => q.eq("slug", world_slug))
      .first();
    if (!world) throw new Error(`world not found: ${world_slug}`);
    const { user_id } = await resolveMember(ctx, session_token, world._id);
    const rendering = await ctx.db.get(rendering_id);
    if (!rendering || rendering.world_id !== world._id)
      throw new Error("rendering not in this world");
    // Already upvoted?
    const prior = await ctx.db
      .query("art_feedback")
      .withIndex("by_rendering", (q) => q.eq("rendering_id", rendering_id))
      .collect();
    const alreadyUpvoted = prior.some(
      (p: any) => p.user_id === user_id && p.action === "upvote",
    );
    if (alreadyUpvoted) return { ok: true, already: true };
    await ctx.db.insert("art_feedback", {
      world_id: world._id,
      rendering_id,
      user_id,
      action: "upvote",
      created_at: Date.now(),
    });
    await ctx.db.patch(rendering_id, {
      upvote_count: (rendering.upvote_count ?? 0) + 1,
      updated_at: Date.now(),
    });
    return { ok: true, upvote_count: (rendering.upvote_count ?? 0) + 1 };
  },
});

/** Free-text feedback comment. Future gens consult recent comments. */
export const addFeedback = mutation({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    rendering_id: v.id("entity_art_renderings"),
    comment: v.string(),
  },
  handler: async (
    ctx,
    { session_token, world_slug, rendering_id, comment },
  ) => {
    const world = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q) => q.eq("slug", world_slug))
      .first();
    if (!world) throw new Error(`world not found: ${world_slug}`);
    const { user_id } = await resolveMember(ctx, session_token, world._id);
    const rendering = await ctx.db.get(rendering_id);
    if (!rendering || rendering.world_id !== world._id)
      throw new Error("rendering not in this world");
    await ctx.db.insert("art_feedback", {
      world_id: world._id,
      rendering_id,
      user_id,
      action: "feedback_comment",
      comment: comment.slice(0, 500),
      created_at: Date.now(),
    });
    return { ok: true };
  },
});

export const logFeedback = internalMutation({
  args: {
    world_id: v.id("worlds"),
    rendering_id: v.id("entity_art_renderings"),
    user_id: v.id("users"),
    action: v.string(),
    comment: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("art_feedback", {
      world_id: args.world_id,
      rendering_id: args.rendering_id,
      user_id: args.user_id,
      action: args.action as any,
      comment: args.comment,
      created_at: Date.now(),
    });
  },
});

/** Add to reference board. */
export const addToReferenceBoard = mutation({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    rendering_id: v.id("entity_art_renderings"),
    kind: v.string(),
    caption: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { session_token, world_slug, rendering_id, kind, caption },
  ) => {
    const world = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q) => q.eq("slug", world_slug))
      .first();
    if (!world) throw new Error(`world not found: ${world_slug}`);
    const { user_id } = await resolveMember(ctx, session_token, world._id);
    const rendering = await ctx.db.get(rendering_id);
    if (!rendering || rendering.world_id !== world._id)
      throw new Error("rendering not in this world");
    // Next order number for this kind.
    const existing = await ctx.db
      .query("art_reference_board")
      .withIndex("by_world_kind", (q) =>
        q.eq("world_id", world._id).eq("kind", kind),
      )
      .collect();
    const nextOrder =
      existing.length === 0
        ? 1
        : Math.max(...existing.map((r: any) => r.order)) + 1;
    const id = await ctx.db.insert("art_reference_board", {
      world_id: world._id,
      rendering_id,
      kind,
      added_by_user_id: user_id,
      caption,
      order: nextOrder,
      created_at: Date.now(),
    });
    await appendMentorship(ctx, {
      world_id: world._id,
      user_id,
      scope: "art.reference_board_add",
      context: { rendering_id, kind, caption },
      human_action: { board_id: id, order: nextOrder },
    });
    return { id, order: nextOrder };
  },
});

// --------------------------------------------------------------------
// Admin — reference-board management.

/** List every reference-board entry in a world, grouped by kind,
 *  with blob hashes + upvote counts for rendering thumbnails. */
export const listReferenceBoard = query({
  args: { session_token: v.string(), world_slug: v.string() },
  handler: async (ctx, { session_token, world_slug }) => {
    const world = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q) => q.eq("slug", world_slug))
      .first();
    if (!world) return null;
    const { user_id } = await resolveMember(ctx, session_token, world._id);
    // Owner-only for the full board (it's a curation surface).
    if (world.owner_user_id !== user_id) return null;
    const rows = await ctx.db
      .query("art_reference_board")
      .withIndex("by_world_kind", (q) => q.eq("world_id", world._id))
      .collect();
    const byKind: Record<string, any[]> = {};
    for (const r of rows) {
      const rendering = (await ctx.db.get(r.rendering_id)) as any;
      if (!rendering || rendering.status === "hidden") continue;
      byKind[r.kind] ??= [];
      byKind[r.kind].push({
        id: r._id,
        rendering_id: r.rendering_id,
        kind: r.kind,
        caption: r.caption ?? null,
        order: r.order,
        added_at: r.created_at,
        blob_hash: rendering.blob_hash ?? null,
        upvote_count: rendering.upvote_count ?? 0,
        mode: rendering.mode,
        entity_id: rendering.entity_id,
      });
    }
    for (const k of Object.keys(byKind)) {
      byKind[k].sort((a, b) => a.order - b.order);
    }
    return byKind;
  },
});

/** Remove a single reference-board entry. Owner-only. */
export const removeFromReferenceBoard = mutation({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    board_id: v.id("art_reference_board"),
  },
  handler: async (ctx, { session_token, world_slug, board_id }) => {
    const world = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q) => q.eq("slug", world_slug))
      .first();
    if (!world) throw new Error(`world not found: ${world_slug}`);
    const { user_id } = await resolveMember(ctx, session_token, world._id);
    if (world.owner_user_id !== user_id)
      throw new Error("remove-from-board is owner-only");
    const row = await ctx.db.get(board_id);
    if (!row || row.world_id !== world._id) throw new Error("not in this world");
    await ctx.db.delete(board_id);
    return { ok: true };
  },
});

/** Every ready-status rendering in a world, flat list, for the admin
 *  page's "pick art to pin to board" surface. */
export const listAllRenderings = query({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    mode_filter: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { session_token, world_slug, mode_filter, limit }) => {
    const world = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q) => q.eq("slug", world_slug))
      .first();
    if (!world) return null;
    const { user_id } = await resolveMember(ctx, session_token, world._id);
    if (world.owner_user_id !== user_id) return null;
    const rows = await ctx.db
      .query("entity_art_renderings")
      .withIndex("by_world", (q) => q.eq("world_id", world._id))
      .collect();
    let filtered = rows.filter((r: any) => r.status === "ready");
    if (mode_filter) filtered = filtered.filter((r: any) => r.mode === mode_filter);
    filtered.sort((a: any, b: any) =>
      b.upvote_count - a.upvote_count || b.created_at - a.created_at,
    );
    const capped = filtered.slice(0, limit ?? 200);
    // Hydrate each with the parent entity's slug + type for display.
    const out = [];
    for (const r of capped) {
      const e = await ctx.db.get(r.entity_id);
      out.push({
        id: r._id,
        mode: r.mode,
        variant_index: r.variant_index,
        blob_hash: r.blob_hash ?? null,
        upvote_count: r.upvote_count,
        created_at: r.created_at,
        entity_id: r.entity_id,
        entity_type: e?.type ?? null,
        entity_slug: e?.slug ?? null,
      });
    }
    return out;
  },
});

// --------------------------------------------------------------------
// Retrofit: migrate existing entity.art_blob_hash → entity_art_renderings

export const migrateArtToRenderings = mutation({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    confirm: v.literal("yes-migrate-art"),
  },
  handler: async (ctx, { session_token, world_slug }) => {
    const world = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q) => q.eq("slug", world_slug))
      .first();
    if (!world) throw new Error(`world not found: ${world_slug}`);
    const { user_id } = await resolveMember(ctx, session_token, world._id);
    if (world.owner_user_id !== user_id)
      throw new Error("migrate is owner-only");
    if (!world.current_branch_id) throw new Error("world has no branch");
    const branch_id = world.current_branch_id;

    const entities = await ctx.db
      .query("entities")
      .withIndex("by_branch_type", (q: any) => q.eq("branch_id", branch_id))
      .collect();
    let migrated = 0;
    let skipped = 0;
    const now = Date.now();
    for (const e of entities) {
      const hash = (e as any).art_blob_hash as string | undefined;
      if (!hash) {
        skipped++;
        continue;
      }
      // Idempotence: skip if a hero_full variant already exists with this hash.
      const existing = await ctx.db
        .query("entity_art_renderings")
        .withIndex("by_entity_mode", (q: any) =>
          q.eq("entity_id", e._id).eq("mode", "hero_full"),
        )
        .collect();
      if (existing.some((r: any) => r.blob_hash === hash)) {
        skipped++;
        continue;
      }
      const nextV = nextVariantIndex(
        existing.map((r: any) => r.variant_index as number),
      );
      await ctx.db.insert("entity_art_renderings", {
        world_id: world._id,
        branch_id,
        entity_id: e._id,
        mode: "hero_full",
        variant_index: nextV,
        blob_hash: hash,
        status: "ready",
        prompt_used: "(retrofit from legacy art_blob_hash)",
        requested_by_user_id: world.owner_user_id,
        upvote_count: 0,
        created_at: now,
        updated_at: now,
      });
      migrated++;
    }
    return { migrated, skipped, total_entities: entities.length };
  },
});

// --------------------------------------------------------------------
// Utility: resolve a display-preferred rendering for (entity, character).
// Mode-fallthrough: character.art_mode_preferred → top-voted existing → ambient_palette.

export const resolveDisplayRendering = query({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    entity_id: v.id("entities"),
  },
  handler: async (ctx, { session_token, world_slug, entity_id }) => {
    const world = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q) => q.eq("slug", world_slug))
      .first();
    if (!world) return null;
    const { user_id } = await resolveMember(ctx, session_token, world._id);
    const character = await ctx.db
      .query("characters")
      .withIndex("by_world_user", (q) =>
        q.eq("world_id", world._id).eq("user_id", user_id),
      )
      .first();
    const preferred = (character as any)?.art_mode_preferred as string | undefined;
    const rows = await ctx.db
      .query("entity_art_renderings")
      .withIndex("by_entity_mode", (q) => q.eq("entity_id", entity_id))
      .collect();
    const visible = rows.filter((r: any) => r.status === "ready");
    if (visible.length === 0) return { rendering: null, fallback: "no-art" };
    let pick: any = null;
    if (preferred) {
      const inPreferred = visible
        .filter((r: any) => r.mode === preferred)
        .sort(
          (a: any, b: any) =>
            b.upvote_count - a.upvote_count || b.created_at - a.created_at,
        );
      if (inPreferred[0]) pick = inPreferred[0];
    }
    if (!pick) {
      // Top-voted across all modes.
      visible.sort(
        (a: any, b: any) =>
          b.upvote_count - a.upvote_count || b.created_at - a.created_at,
      );
      pick = visible[0];
    }
    return {
      rendering: pick
        ? {
            id: pick._id,
            mode: pick.mode,
            variant_index: pick.variant_index,
            blob_hash: pick.blob_hash,
            status: pick.status,
            upvote_count: pick.upvote_count,
          }
        : null,
      fallback: preferred ? "preferred" : "top-voted",
    };
  },
});
