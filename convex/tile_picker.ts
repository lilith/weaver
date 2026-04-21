// AI-assisted tile picker (spec 26 §Pick / generate decision).
//
// Given a world bound to a style_tag and a location entity, Haiku
// decides whether to reuse an existing library asset or describe a
// new one. `pick` writes the entity_overrides map. `generate` stamps
// `map_hint` on the entity (descriptor + relative_direction/distance)
// so the human-orchestrated pixellab flow has everything it needs.
//
// Cost budget: ~500 input + ~120 output per call ≈ $0.0005. Cheap.

import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
} from "./_generated/server.js";
import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import Anthropic from "@anthropic-ai/sdk";
import { resolveMember } from "./sessions.js";
import { readJSONBlob } from "./blobs.js";
import { anthropicCostUsd } from "./cost.js";
import type { Doc, Id } from "./_generated/dataModel.js";

const PICKER_MODEL = "claude-haiku-4-5-20251001";

export type PickerResult =
  | {
      action: "pick";
      tile_id: Id<"tile_library">;
      reason: string;
    }
  | {
      action: "generate";
      kind: string;
      descriptor: string;
      relative_direction?: string;
      relative_distance?: "near" | "mid" | "far";
      reason: string;
    }
  | { action: "skip"; reason: string };

const PICKER_SYSTEM = `You pick a pixel-art tile for a location in a collaborative world-building game, or describe a new one to generate.

Return strict JSON with ONE of these shapes:

{ "action": "pick", "tile_id": "<catalog id>", "reason": "<≤20 words>" }
  — when a catalog entry clearly fits the location's name + biome.

{ "action": "generate", "kind": "portrait|map_object|biome_tile|building|path|bridge|character_walk",
  "descriptor": "<short pixel-art prompt — 8-20 words, no flowery language>",
  "relative_direction": "north|south|east|west|ne|nw|se|sw|up|down|in|out" (optional),
  "relative_distance": "near|mid|far" (optional),
  "reason": "<≤20 words>" }
  — when nothing in the catalog matches and a new tile should be generated.

Rules:
- Prefer pick when ANY catalog row's name/subject_tags overlap the location's biome + theme.
- kind=portrait is the default for graph-map place tiles (128x128 transparent).
- descriptor is a prompt for a pixel-art generator; keep it concrete ("stone well under oak canopy", not "a magical, mystical place"). No trademarks. Family-safe.
- relative_direction/distance describe how this location sits vs. its parent — used for the graph's initial layout hint.
- If context is insufficient to decide, return { "action": "skip", "reason": "..." }.

Output JSON only. No preamble, no code fences.`;

/** Load minimal context for the picker. */
export const prepareContext = internalQuery({
  args: {
    session_token: v.string(),
    world_id: v.id("worlds"),
    entity_slug: v.string(),
  },
  handler: async (ctx, { session_token, world_id, entity_slug }) => {
    const { user_id } = await resolveMember(ctx as any, session_token, world_id);
    const world = await ctx.db.get(world_id);
    if (!world?.current_branch_id) throw new Error("world has no branch");
    const branch_id = world.current_branch_id;
    if (world.owner_user_id !== user_id) {
      throw new Error("tile picker: owner-only");
    }

    const binding = await ctx.db
      .query("world_style_bindings")
      .withIndex("by_world", (q: any) => q.eq("world_id", world_id))
      .first();
    if (!binding?.style_tag) {
      return {
        style_tag: null,
        catalog: [] as Array<{ id: string; name: string; kind: string; subject_tags: string[] }>,
        entity: null,
      };
    }

    const entity = await ctx.db
      .query("entities")
      .withIndex("by_branch_type_slug", (q: any) =>
        q.eq("branch_id", branch_id).eq("type", "location").eq("slug", entity_slug),
      )
      .first();
    if (!entity) throw new Error(`location "${entity_slug}" not found`);
    let payload: any = null;
    try {
      const vr = await ctx.db
        .query("artifact_versions")
        .withIndex("by_artifact_version", (q: any) =>
          q.eq("artifact_entity_id", entity._id).eq("version", entity.current_version),
        )
        .first();
      if (vr) payload = await readJSONBlob<any>(ctx as any, vr.blob_hash);
    } catch {
      /* unreadable */
    }

    let parent: any = null;
    if (entity.expanded_from_entity_id) {
      const p = await ctx.db.get(entity.expanded_from_entity_id);
      if (p) {
        try {
          const pv = await ctx.db
            .query("artifact_versions")
            .withIndex("by_artifact_version", (q: any) =>
              q.eq("artifact_entity_id", p._id).eq("version", (p as any).current_version),
            )
            .first();
          if (pv) {
            const pp = await readJSONBlob<any>(ctx as any, pv.blob_hash);
            parent = { name: pp?.name ?? (p as any).slug, biome: pp?.biome ?? null };
          }
        } catch {
          /* pass */
        }
      }
    }

    // Catalog — up to 40 rows matching style_tag. Subject_tags + name only.
    const catalogRows = (await ctx.db
      .query("tile_library")
      .withIndex("by_style_active", (q: any) =>
        q.eq("style_tag", binding.style_tag).eq("active", true),
      )
      .take(80)) as Doc<"tile_library">[];
    const catalog = catalogRows.slice(0, 40).map((r) => ({
      id: r._id,
      name: r.name,
      kind: r.kind,
      subject_tags: r.subject_tags ?? [],
    }));

    return {
      style_tag: binding.style_tag,
      entity: {
        id: entity._id,
        slug: entity.slug,
        name: payload?.name ?? entity.slug,
        biome: payload?.biome ?? null,
        description:
          typeof payload?.description_template === "string"
            ? payload.description_template.slice(0, 400)
            : null,
        parent_name: parent?.name ?? null,
        parent_biome: parent?.biome ?? null,
      },
      catalog,
      branch_id,
    };
  },
});

/** Apply the picker result to entity_overrides + map_hint. */
export const applyPick = internalMutation({
  args: {
    world_id: v.id("worlds"),
    entity_slug: v.string(),
    result: v.any(),
  },
  handler: async (ctx, { world_id, entity_slug, result }) => {
    const world = await ctx.db.get(world_id);
    if (!world?.current_branch_id) return;
    const branch_id = world.current_branch_id;

    const entity = await ctx.db
      .query("entities")
      .withIndex("by_branch_type_slug", (q: any) =>
        q.eq("branch_id", branch_id).eq("type", "location").eq("slug", entity_slug),
      )
      .first();
    if (!entity) return;

    if (result?.action === "pick" && result?.tile_id) {
      // Verify the id is a real tile_library row.
      const tile = await ctx.db.get(result.tile_id as Id<"tile_library">);
      if (!tile) return;
      const binding = await ctx.db
        .query("world_style_bindings")
        .withIndex("by_world", (q: any) => q.eq("world_id", world_id))
        .first();
      if (!binding) return;
      const next = { ...(binding.entity_overrides ?? {}) } as Record<string, any>;
      next[entity_slug] = result.tile_id;
      await ctx.db.patch(binding._id, {
        entity_overrides: next,
        updated_at: Date.now(),
      });
    }
    if (result?.action === "generate") {
      await ctx.db.patch(entity._id, {
        map_hint: {
          descriptor: String(result.descriptor ?? ""),
          kind: String(result.kind ?? "portrait"),
          relative_direction: result.relative_direction ?? null,
          relative_distance: result.relative_distance ?? null,
          proposed_at: Date.now(),
        },
      });
    }
  },
});

/** Owner-invoked. Runs the Haiku picker for one entity. */
export const pickTileForLocation = action({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    entity_slug: v.string(),
  },
  handler: async (ctx, { session_token, world_slug, entity_slug }) => {
    const world = await ctx.runQuery(internal.tile_picker.worldBySlug, {
      world_slug,
    });
    if (!world) throw new Error("world not found");
    const ctxData = await ctx.runQuery(internal.tile_picker.prepareContext, {
      session_token,
      world_id: world._id,
      entity_slug,
    });
    if (!ctxData.style_tag) {
      return { action: "skip" as const, reason: "no style_tag bound to world" };
    }
    if (!ctxData.entity) {
      return { action: "skip" as const, reason: "entity not found" };
    }

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const userContent = JSON.stringify({
      style_tag: ctxData.style_tag,
      entity: ctxData.entity,
      catalog: ctxData.catalog,
    });
    const response = await anthropic.messages.create({
      model: PICKER_MODEL,
      max_tokens: 400,
      temperature: 0,
      system: PICKER_SYSTEM,
      messages: [{ role: "user", content: userContent }],
    });
    await ctx.runMutation(internal.cost.logCostUsd, {
      world_id: world._id,
      kind: `anthropic:${PICKER_MODEL}:tile_pick`,
      cost_usd: anthropicCostUsd(PICKER_MODEL, response.usage as any),
      reason: `tile_pick "${entity_slug}"`,
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
    } catch {
      return { action: "skip" as const, reason: "bad model json" };
    }

    if (parsed?.action === "pick" || parsed?.action === "generate") {
      await ctx.runMutation(internal.tile_picker.applyPick, {
        world_id: world._id,
        entity_slug,
        result: parsed,
      });
    }
    return parsed as PickerResult;
  },
});

/** Iterate every canonical location in the world and run the picker.
 *  Cheap Haiku calls at ~$0.0005 each; for a 60-location world that's
 *  ~$0.03. Owner-only; no-op if style isn't bound. */
export const backfillWorldTiles = action({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { session_token, world_slug, limit },
  ): Promise<{
    processed: number;
    picks: number;
    generates: number;
    skips: number;
    results: Array<{ slug: string; outcome: string }>;
  }> => {
    const slugs = (await ctx.runQuery(internal.tile_picker.listCanonicalSlugs, {
      session_token,
      world_slug,
      limit: limit ?? 40,
    })) as string[];
    let picks = 0;
    let generates = 0;
    let skips = 0;
    const results: Array<{ slug: string; outcome: string }> = [];
    for (const slug of slugs) {
      const r: PickerResult = await ctx.runAction(internal.tile_picker.pickOne, {
        session_token,
        world_slug,
        entity_slug: slug,
      });
      if (r.action === "pick") picks++;
      else if (r.action === "generate") generates++;
      else skips++;
      results.push({ slug, outcome: r.action });
    }
    return { processed: slugs.length, picks, generates, skips, results };
  },
});

/** Internal: same body as pickTileForLocation but callable from an
 *  action. (Convex won't let actions call public actions.) */
export const pickOne = internalAction({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    entity_slug: v.string(),
  },
  handler: async (ctx, args): Promise<PickerResult> => {
    const world = await ctx.runQuery(internal.tile_picker.worldBySlug, {
      world_slug: args.world_slug,
    });
    if (!world) return { action: "skip", reason: "world not found" };
    const ctxData = await ctx.runQuery(internal.tile_picker.prepareContext, {
      session_token: args.session_token,
      world_id: world._id,
      entity_slug: args.entity_slug,
    });
    if (!ctxData.style_tag) return { action: "skip", reason: "no style_tag" };
    if (!ctxData.entity) return { action: "skip", reason: "no entity" };
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const userContent = JSON.stringify({
      style_tag: ctxData.style_tag,
      entity: ctxData.entity,
      catalog: ctxData.catalog,
    });
    const response = await anthropic.messages.create({
      model: PICKER_MODEL,
      max_tokens: 400,
      temperature: 0,
      system: PICKER_SYSTEM,
      messages: [{ role: "user", content: userContent }],
    });
    await ctx.runMutation(internal.cost.logCostUsd, {
      world_id: world._id,
      kind: `anthropic:${PICKER_MODEL}:tile_pick`,
      cost_usd: anthropicCostUsd(PICKER_MODEL, response.usage as any),
      reason: `tile_pick "${args.entity_slug}"`,
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
    } catch {
      return { action: "skip", reason: "bad json" };
    }
    if (parsed?.action === "pick" || parsed?.action === "generate") {
      await ctx.runMutation(internal.tile_picker.applyPick, {
        world_id: world._id,
        entity_slug: args.entity_slug,
        result: parsed,
      });
    }
    return parsed as PickerResult;
  },
});

/** Internal: list canonical location slugs without tile overrides,
 *  oldest-first. Used by backfillWorldTiles so the operator can walk
 *  the world deterministically. */
export const listCanonicalSlugs = internalQuery({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    limit: v.number(),
  },
  handler: async (ctx, { session_token, world_slug, limit }) => {
    const world = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q) => q.eq("slug", world_slug))
      .first();
    if (!world?.current_branch_id) return [] as string[];
    const { user_id } = await resolveMember(ctx as any, session_token, world._id);
    if (world.owner_user_id !== user_id) return [] as string[];

    const binding = await ctx.db
      .query("world_style_bindings")
      .withIndex("by_world", (q: any) => q.eq("world_id", world._id))
      .first();
    const overrides = (binding?.entity_overrides ?? {}) as Record<string, unknown>;
    const branch_id = world.current_branch_id;
    const rows = (await ctx.db
      .query("entities")
      .withIndex("by_branch_type", (q: any) =>
        q.eq("branch_id", branch_id).eq("type", "location"),
      )
      .collect()) as Doc<"entities">[];
    return rows
      .filter((e) => !e.draft && !overrides[e.slug])
      .sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0))
      .slice(0, limit)
      .map((e) => e.slug);
  },
});

export const worldBySlug = internalQuery({
  args: { world_slug: v.string() },
  handler: async (ctx, { world_slug }) => {
    const world = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q) => q.eq("slug", world_slug))
      .first();
    return world;
  },
});

/** Owner-only: write a map_hint directly (e.g., admin backfill via CLI
 *  after reviewing a generated descriptor). Separate from applyPick
 *  because we want to gate on membership at the Convex edge. */
export const setMapHint = mutation({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    entity_slug: v.string(),
    descriptor: v.string(),
    kind: v.optional(v.string()),
    relative_direction: v.optional(v.string()),
    relative_distance: v.optional(v.string()),
  },
  handler: async (
    ctx,
    {
      session_token,
      world_slug,
      entity_slug,
      descriptor,
      kind,
      relative_direction,
      relative_distance,
    },
  ) => {
    const world = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q) => q.eq("slug", world_slug))
      .first();
    if (!world?.current_branch_id) throw new Error("world not found");
    const { user_id } = await resolveMember(ctx as any, session_token, world._id);
    if (world.owner_user_id !== user_id) throw new Error("owner-only");
    const branch_id = world.current_branch_id;

    const entity = await ctx.db
      .query("entities")
      .withIndex("by_branch_type_slug", (q: any) =>
        q.eq("branch_id", branch_id).eq("type", "location").eq("slug", entity_slug),
      )
      .first();
    if (!entity) throw new Error("entity not found");
    await ctx.db.patch(entity._id, {
      map_hint: {
        descriptor,
        kind: kind ?? "portrait",
        relative_direction: relative_direction ?? null,
        relative_distance: relative_distance ?? null,
        proposed_at: Date.now(),
      },
    });
    return { ok: true };
  },
});
