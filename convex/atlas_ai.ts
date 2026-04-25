// Atlas AI — icon-prompt suggestion (Haiku) + basemap generation
// (fal.ai). Kept separate from atlases.ts so the data layer stays
// boring and the network-touching paths are easy to find.
//
// Icon prompts:
//   suggestIconPrompt(placement)
//     reads (atlas.style_anchor, layer.kind, entity bible+biome) and
//     asks Haiku to return { icon_style, icon_prompt }. The owner
//     reviews; if they accept, they call applyIconPrompt(...) which
//     patches the placement. No image is generated yet — that's the
//     fal.ai pass.
//
// Basemap:
//   regenerateBasemap(layer)
//     schedules an internalAction that calls fal.ai with the atlas
//     style + layer kind + placement-names. Stores the result blob in
//     R2, patches map_layers.basemap_blob_hash + basemap_prompt.
//
// Permission model mirrors atlases.ts: world owner OR atlas owner can
// invoke; everyone else is forbidden.

import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
} from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { resolveMember } from "./sessions.js";
import { readJSONBlob } from "./blobs.js";
import Anthropic from "@anthropic-ai/sdk";
import { fal } from "@fal-ai/client";
import { hashBytes } from "@weaver/engine/blobs";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { anthropicCostUsd } from "./cost.js";
import type { Doc, Id } from "./_generated/dataModel.js";

const ICON_MODEL = "claude-haiku-4-5-20251001";
const BASEMAP_MODEL = "fal-ai/flux-pro";

const ICON_SYSTEM_PROMPT = `You design tiny landmark icons for a hand-drawn fantasy atlas. Given context about an atlas + a layer + (optionally) the place that's being marked, propose ONE icon — its style and a short visual prompt for an image model.

Return strict JSON only:

{
  "icon_style": "sticker" | "emblem" | "inkwash" | "photoreal" | "flat",
  "icon_prompt": "<short visual phrase, ≤ 120 chars; no place names>"
}

Rules:
- Match the atlas's style anchor when one is given (ink-and-watercolor, vellum, celestial-chart, etc.).
- Pick "inkwash" for vellum / cartographic looks; "emblem" for bold heraldic; "sticker" for cute/kid-friendly; "flat" for minimalist; "photoreal" only if explicitly asked.
- The icon_prompt is what an image model will draw — describe the shape and material, NOT the place's name. ("rough-inked tower with banner") ✓ ("Castle Greyhall") ✗
- No people. No text in the image.
- No markdown, no commentary — JSON only.`;

async function loadAtlasAsWriter(
  ctx: any,
  session_token: string,
  world_slug: string,
  atlas_slug: string,
): Promise<{
  world: Doc<"worlds">;
  atlas: Doc<"atlases">;
  user_id: Id<"users">;
}> {
  const world = (await ctx.db
    .query("worlds")
    .withIndex("by_slug", (q: any) => q.eq("slug", world_slug))
    .first()) as Doc<"worlds"> | null;
  if (!world) throw new Error(`world not found: ${world_slug}`);
  const { user_id } = await resolveMember(ctx, session_token, world._id);
  const atlas = (await ctx.db
    .query("atlases")
    .withIndex("by_world_slug", (q: any) =>
      q.eq("world_id", world._id).eq("slug", atlas_slug),
    )
    .first()) as Doc<"atlases"> | null;
  if (!atlas) throw new Error(`atlas not found: ${atlas_slug}`);
  if (
    atlas.owner_user_id !== user_id &&
    world.owner_user_id !== user_id
  ) {
    throw new Error(
      "forbidden: only the atlas owner or the world owner may write",
    );
  }
  return { world, atlas, user_id };
}

// --------------------------------------------------------------------
// Icon-prompt suggestion (Haiku)

export const suggestIconPrompt = action({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    atlas_slug: v.string(),
    placement_id: v.id("map_placements"),
  },
  handler: async (
    ctx,
    { session_token, world_slug, atlas_slug, placement_id },
  ): Promise<{ icon_style: string; icon_prompt: string }> => {
    const info = await ctx.runQuery(internal.atlas_ai.loadIconContext, {
      session_token,
      world_slug,
      atlas_slug,
      placement_id,
    });

    const userParts: string[] = [];
    userParts.push(`<atlas_name>${info.atlas_name}</atlas_name>`);
    if (info.atlas_style_anchor)
      userParts.push(
        `<atlas_style>${info.atlas_style_anchor}</atlas_style>`,
      );
    userParts.push(`<layer_name>${info.layer_name}</layer_name>`);
    userParts.push(`<layer_kind>${info.layer_kind}</layer_kind>`);
    if (info.entity_name) userParts.push(`<place>${info.entity_name}</place>`);
    if (info.entity_description)
      userParts.push(
        `<place_description>${info.entity_description.slice(0, 600)}</place_description>`,
      );
    if (info.biome_name)
      userParts.push(`<biome>${info.biome_name}</biome>`);
    if (info.custom_label)
      userParts.push(
        `<custom_landmark>${info.custom_label}</custom_landmark>`,
      );

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: ICON_MODEL,
      max_tokens: 400,
      system: [{ type: "text", text: ICON_SYSTEM_PROMPT }],
      messages: [
        { role: "user", content: userParts.join("\n") + "\n\nJSON only." },
      ],
    });

    await ctx.runMutation(internal.cost.logCostUsd, {
      world_id: info.world_id,
      kind: `anthropic:haiku:atlas_icon`,
      cost_usd: anthropicCostUsd(ICON_MODEL, response.usage as any),
      reason: `atlas icon suggestion`,
    });

    const text = response.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("")
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "");
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch (e: any) {
      throw new Error(`icon-prompt JSON parse failed: ${e?.message ?? e}`);
    }
    const ALLOWED = ["sticker", "emblem", "inkwash", "photoreal", "flat"];
    const icon_style = ALLOWED.includes(parsed?.icon_style)
      ? parsed.icon_style
      : "inkwash";
    const icon_prompt = String(parsed?.icon_prompt ?? "").slice(0, 200).trim();
    if (icon_prompt.length < 4)
      throw new Error("icon-prompt response too short");
    return { icon_style, icon_prompt };
  },
});

export const loadIconContext = internalQuery({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    atlas_slug: v.string(),
    placement_id: v.id("map_placements"),
  },
  handler: async (
    ctx,
    { session_token, world_slug, atlas_slug, placement_id },
  ) => {
    const { world, atlas } = await loadAtlasAsWriter(
      ctx,
      session_token,
      world_slug,
      atlas_slug,
    );
    const placement = await ctx.db.get(placement_id);
    if (!placement) throw new Error("placement not found");
    if (placement.atlas_id !== atlas._id)
      throw new Error("forbidden: placement belongs to another atlas");
    const layer = await ctx.db.get(placement.layer_id);
    if (!layer) throw new Error("layer disappeared");

    let entity_name: string | undefined;
    let entity_description: string | undefined;
    let biome_name: string | undefined;
    if (placement.entity_id) {
      const entity = (await ctx.db.get(placement.entity_id)) as Doc<"entities"> | null;
      if (entity) {
        entity_name =
          (entity as any).slug && (entity as any).slug.length > 0
            ? (entity as any).slug
            : entity_name;
        const vrow = await ctx.db
          .query("artifact_versions")
          .withIndex("by_artifact_version", (q: any) =>
            q
              .eq("artifact_entity_id", entity._id)
              .eq("version", entity.current_version),
          )
          .first();
        if (vrow) {
          try {
            const payload = await readJSONBlob<any>(ctx as any, vrow.blob_hash);
            entity_name = payload?.name ?? entity_name ?? entity.slug;
            entity_description =
              payload?.description ?? payload?.description_template;
            biome_name = payload?.biome;
          } catch {
            /* ok — best-effort */
          }
        }
      }
    }

    return {
      world_id: world._id,
      atlas_name: atlas.name,
      atlas_style_anchor: atlas.style_anchor ?? null,
      layer_name: layer.name,
      layer_kind: layer.kind,
      entity_name: entity_name ?? null,
      entity_description: entity_description ?? null,
      biome_name: biome_name ?? null,
      custom_label: placement.custom_label ?? null,
    };
  },
});

/** Apply the suggested icon style + prompt to a placement. Owner taps
 *  this once they've reviewed the AI's draft. */
export const applyIconPrompt = mutation({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    atlas_slug: v.string(),
    placement_id: v.id("map_placements"),
    icon_style: v.string(),
    icon_prompt: v.string(),
  },
  handler: async (ctx, args) => {
    const { atlas } = await loadAtlasAsWriter(
      ctx,
      args.session_token,
      args.world_slug,
      args.atlas_slug,
    );
    const placement = await ctx.db.get(args.placement_id);
    if (!placement) throw new Error("placement not found");
    if (placement.atlas_id !== atlas._id)
      throw new Error("forbidden: placement belongs to another atlas");
    const trimmedPrompt = args.icon_prompt.slice(0, 1500);
    const trimmedStyle = args.icon_style.slice(0, 40);
    await ctx.db.patch(args.placement_id, {
      icon_style: trimmedStyle,
      icon_prompt: trimmedPrompt,
      updated_at: Date.now(),
    });
    return { ok: true };
  },
});

// --------------------------------------------------------------------
// Basemap generation (fal.ai → R2 → patched layer)

export const regenerateBasemap = mutation({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    atlas_slug: v.string(),
    layer_slug: v.string(),
    extra_prompt: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { world, atlas } = await loadAtlasAsWriter(
      ctx,
      args.session_token,
      args.world_slug,
      args.atlas_slug,
    );
    const layer = (await ctx.db
      .query("map_layers")
      .withIndex("by_atlas_slug", (q: any) =>
        q.eq("atlas_id", atlas._id).eq("slug", args.layer_slug),
      )
      .first()) as Doc<"map_layers"> | null;
    if (!layer) throw new Error(`layer not found: ${args.layer_slug}`);
    await ctx.db.patch(layer._id, {
      basemap_prompt:
        (args.extra_prompt ?? layer.basemap_prompt ?? "").slice(0, 1500) ||
        undefined,
      updated_at: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.atlas_ai.runBasemapGen, {
      world_id: world._id,
      atlas_id: atlas._id,
      layer_id: layer._id,
    });
    return { queued: true };
  },
});

export const runBasemapGen = internalAction({
  args: {
    world_id: v.id("worlds"),
    atlas_id: v.id("atlases"),
    layer_id: v.id("map_layers"),
  },
  handler: async (ctx, { world_id, atlas_id, layer_id }) => {
    const ctxInfo = await ctx.runQuery(internal.atlas_ai.loadBasemapContext, {
      atlas_id,
      layer_id,
    });
    if (!ctxInfo) return;

    const prompt = buildBasemapPrompt(ctxInfo);

    fal.config({ credentials: process.env.FAL_KEY });
    const result: any = await fal.subscribe(BASEMAP_MODEL, {
      input: {
        prompt,
        image_size: "landscape_16_9",
        num_inference_steps: 28,
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
    const content_type =
      imageResp.headers.get("content-type") ?? "image/jpeg";
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
    await ctx.runMutation(internal.atlas_ai.storeBasemapResult, {
      layer_id,
      hash,
      size: bytes.byteLength,
      content_type,
      r2_key,
      prompt,
    });
  },
});

export const loadBasemapContext = internalQuery({
  args: {
    atlas_id: v.id("atlases"),
    layer_id: v.id("map_layers"),
  },
  handler: async (ctx, { atlas_id, layer_id }) => {
    const atlas = (await ctx.db.get(atlas_id)) as Doc<"atlases"> | null;
    const layer = (await ctx.db.get(layer_id)) as Doc<"map_layers"> | null;
    if (!atlas || !layer) return null;
    const placements = (await ctx.db
      .query("map_placements")
      .withIndex("by_layer", (q: any) => q.eq("layer_id", layer_id))
      .collect()) as Doc<"map_placements">[];
    const labels: string[] = [];
    for (const p of placements.slice(0, 12)) {
      if (p.custom_label) {
        labels.push(p.custom_label);
        continue;
      }
      if (p.entity_id) {
        const e = (await ctx.db.get(p.entity_id)) as Doc<"entities"> | null;
        if (e) labels.push(e.slug);
      }
    }
    return {
      atlas_style: atlas.style_anchor ?? null,
      layer_name: layer.name,
      layer_kind: layer.kind,
      layer_prompt: layer.basemap_prompt ?? null,
      labels,
    };
  },
});

function buildBasemapPrompt(info: {
  atlas_style: string | null;
  layer_name: string;
  layer_kind: string;
  layer_prompt: string | null;
  labels: string[];
}): string {
  const parts: string[] = [];
  parts.push("a hand-drawn fantasy atlas basemap");
  if (info.atlas_style) parts.push(info.atlas_style);
  parts.push(`${info.layer_kind} layer`);
  if (info.layer_prompt) parts.push(info.layer_prompt);
  if (info.labels.length > 0) {
    parts.push(`landmarks: ${info.labels.slice(0, 8).join(", ")}`);
  }
  parts.push(
    "no characters, no text labels in the image, painted on aged parchment",
  );
  return parts.filter(Boolean).join("; ");
}

export const storeBasemapResult = internalMutation({
  args: {
    layer_id: v.id("map_layers"),
    hash: v.string(),
    size: v.number(),
    content_type: v.string(),
    r2_key: v.string(),
    prompt: v.string(),
  },
  handler: async (ctx, args) => {
    // Upsert blobs row with R2 storage so other readers can find it via
    // the same code path as inline blobs.
    const existing = await ctx.db
      .query("blobs")
      .withIndex("by_hash", (q: any) => q.eq("hash", args.hash))
      .first();
    if (!existing) {
      await ctx.db.insert("blobs", {
        hash: args.hash,
        size: args.size,
        content_type: args.content_type,
        storage: "r2",
        r2_key: args.r2_key,
        created_at: Date.now(),
      });
    }
    await ctx.db.patch(args.layer_id, {
      basemap_blob_hash: args.hash,
      basemap_prompt: args.prompt,
      updated_at: Date.now(),
    });
  },
});
