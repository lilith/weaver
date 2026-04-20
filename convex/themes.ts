// Theme generation (spec 10). Opus reads the bible, proposes a full
// ThemeSchema (colors / typography / atoms / motion), we persist a
// row in `themes` and mark it active. Play page reads the active
// theme and injects CSS vars alongside the biome palette.
//
// Owner-only surface. Each generate creates a new version; prior
// versions stay readable (rollback path for a future UI).

import { action, mutation, query, internalQuery } from "./_generated/server.js";
import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import { resolveMember } from "./sessions.js";
import { readJSONBlob } from "./blobs.js";
import { ThemeSpecSchema, themeToCss } from "@weaver/engine/schemas";
import { appendMentorship } from "./mentorship.js";
import { anthropicCostUsd } from "./cost.js";
import Anthropic from "@anthropic-ai/sdk";
import type { Doc, Id } from "./_generated/dataModel.js";

const THEME_MODEL = "claude-opus-4-7";

const THEME_SYSTEM_PROMPT = `You design visual themes for a collaborative world-building game's UI. Given a world bible, return strict JSON matching the ThemeSchema.

ThemeSchema outline:
{
  "name": "<short evocative name>",
  "descriptor": "<one-line summary for humans>",
  "colors": {
    "primary": { "50": "#...", "100": "#...", ..., "900": "#..." },
    "accent":  { "50": "#...", ..., "900": "#..." },
    "neutral": { "50": "#...", ..., "900": "#..." },
    "success": { "50": "#...", ..., "900": "#..." },
    "warning": { "50": "#...", ..., "900": "#..." },
    "danger":  { "50": "#...", ..., "900": "#..." },
    "background": "#...",
    "surface":    "#...",
    "ink":        "#...",
    "ink_soft":   "#..."
  },
  "typography": {
    "heading_family": "<CSS font-family string>",
    "body_family":    "<CSS font-family string>",
    "mono_family":    "<CSS font-family string>",
    "base_size":      16,
    "scale":          "tight|default|loose",
    "heading_weight": 600,
    "body_weight":    400
  },
  "atoms": {
    "radius_scale":  "sharp|subtle|soft|round",
    "border_weight": "hairline|regular|bold",
    "button_shape":  "rectangle|rounded|pill",
    "card_style":    "flat|subtle_shadow|defined_shadow|inset|bordered",
    "divider_style": "solid|dashed|dotted|ornate",
    "texture":       "none|paper|parchment|canvas|film_grain"
  },
  "motion": {
    "pace":           "snappy|balanced|gentle|dreamy",
    "easing":         "linear|easeOut|easeInOut|spring_soft|spring_bouncy",
    "distance_scale": 1,
    "reduce_on_mobile": true
  }
}

Rules:
- All color values MUST be 6-digit hex (#rrggbb). Generate full 10-step ramps by interpolating light→dark through the base hue.
- Typography: prefer fonts widely available on the web (Google Fonts "Inter", "Source Serif 4", "JetBrains Mono" style names are fine). Body fonts must be readable at 16px on mobile.
- Atoms + motion should match the world's tone: a whimsical village reads differently from a grave fluorescent office.
- Background/surface/ink/ink_soft must contrast enough to pass basic a11y (no #666 on #777).
- No markdown, no code fences. JSON only.`;

/** Generate a theme from the world's current bible. Owner-only.
 *  Writes a new row in `themes` and marks it active for the branch. */
export const generateTheme = action({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
  },
  handler: async (
    ctx,
    { session_token, world_slug },
  ): Promise<{ theme_id: Id<"themes">; version: number; descriptor: string }> => {
    const info = await ctx.runQuery(internal.themes.loadBibleForTheme, {
      session_token,
      world_slug,
    });
    if (!info) throw new Error("world not found or forbidden");

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: THEME_MODEL,
      max_tokens: 4000,
      system: [{ type: "text", text: THEME_SYSTEM_PROMPT }],
      messages: [
        {
          role: "user",
          content: `<world_bible>\n${JSON.stringify(info.bible, null, 2)}\n</world_bible>\n\nGenerate the theme.`,
        },
      ],
    });
    await ctx.runMutation(internal.cost.logCostUsd, {
      world_id: info.world_id,
      kind: `anthropic:${THEME_MODEL}:theme_gen`,
      cost_usd: anthropicCostUsd(THEME_MODEL, response.usage as any),
      reason: `theme gen for ${world_slug}`,
    });
    if (response.stop_reason === "max_tokens") {
      throw new Error("theme generation hit max_tokens — bible may be too long");
    }
    const text = response.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("")
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "");
    let raw: any;
    try {
      raw = JSON.parse(text);
    } catch (e: any) {
      throw new Error(
        `theme JSON parse failed (${e?.message ?? e}); raw: ${text.slice(0, 240)}...`,
      );
    }
    const parsed = ThemeSpecSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`theme schema validation failed: ${parsed.error.message.slice(0, 300)}`);
    }
    const result = await ctx.runMutation(internal.themes.insertTheme, {
      world_id: info.world_id,
      branch_id: info.branch_id,
      user_id: info.user_id,
      spec: parsed.data,
    });
    return { theme_id: result.theme_id, version: result.version, descriptor: parsed.data.descriptor };
  },
});

export const loadBibleForTheme = internalQuery({
  args: { session_token: v.string(), world_slug: v.string() },
  handler: async (ctx, { session_token, world_slug }) => {
    const world = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q: any) => q.eq("slug", world_slug))
      .first();
    if (!world) return null;
    const { user_id } = await resolveMember(ctx as any, session_token, world._id);
    if (world.owner_user_id !== user_id) return null;
    if (!world.current_branch_id) return null;
    const bibleEntity = await ctx.db
      .query("entities")
      .withIndex("by_branch_type_slug", (q: any) =>
        q
          .eq("branch_id", world.current_branch_id!)
          .eq("type", "bible")
          .eq("slug", "bible"),
      )
      .first();
    if (!bibleEntity) return null;
    const v = await ctx.db
      .query("artifact_versions")
      .withIndex("by_artifact_version", (q: any) =>
        q
          .eq("artifact_entity_id", bibleEntity._id)
          .eq("version", bibleEntity.current_version),
      )
      .first();
    if (!v) return null;
    const bible = await readJSONBlob<any>(ctx as any, v.blob_hash);
    return {
      bible,
      world_id: world._id,
      branch_id: world.current_branch_id,
      user_id,
    };
  },
});

import { internalMutation } from "./_generated/server.js";

/** Internal: write the theme row + mark active. Prior active rows for
 *  this branch flip to inactive. */
export const insertTheme = internalMutation({
  args: {
    world_id: v.id("worlds"),
    branch_id: v.id("branches"),
    user_id: v.id("users"),
    spec: v.any(),
  },
  handler: async (ctx, args) => {
    const prior = await ctx.db
      .query("themes")
      .withIndex("by_world_branch_active", (q: any) =>
        q.eq("world_id", args.world_id).eq("branch_id", args.branch_id).eq("active", true),
      )
      .collect();
    for (const p of prior) {
      await ctx.db.patch(p._id, { active: false });
    }
    const maxVersion = Math.max(
      0,
      ...(
        await ctx.db
          .query("themes")
          .withIndex("by_world_branch_version", (q: any) =>
            q.eq("world_id", args.world_id).eq("branch_id", args.branch_id),
          )
          .collect()
      ).map((r: any) => r.version),
    );
    const version = maxVersion + 1;
    const theme_id = await ctx.db.insert("themes", {
      world_id: args.world_id,
      branch_id: args.branch_id,
      spec: args.spec,
      version,
      active: true,
      created_at: Date.now(),
    });
    await appendMentorship(ctx, {
      world_id: args.world_id,
      user_id: args.user_id,
      scope: "other",
      context: { theme_id, version },
      human_action: { theme_generated: true },
      after: args.spec,
      note: "theme generation",
    });
    return { theme_id, version };
  },
});

/** Read the active theme for a world. Public (members see it). */
export const getActiveTheme = query({
  args: { session_token: v.string(), world_slug: v.string() },
  handler: async (ctx, { session_token, world_slug }) => {
    const world = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q) => q.eq("slug", world_slug))
      .first();
    if (!world?.current_branch_id) return null;
    await resolveMember(ctx, session_token, world._id);
    const active = await ctx.db
      .query("themes")
      .withIndex("by_world_branch_active", (q: any) =>
        q
          .eq("world_id", world._id)
          .eq("branch_id", world.current_branch_id!)
          .eq("active", true),
      )
      .first();
    if (!active) return null;
    const parsed = ThemeSpecSchema.safeParse(active.spec);
    if (!parsed.success) return null;
    return {
      id: active._id,
      version: active.version,
      spec: parsed.data,
      css: themeToCss(parsed.data, ":root"),
      created_at: active.created_at,
    };
  },
});

/** List all versions (for owner's rollback UI). */
export const listThemes = query({
  args: { session_token: v.string(), world_slug: v.string() },
  handler: async (ctx, { session_token, world_slug }) => {
    const world = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q) => q.eq("slug", world_slug))
      .first();
    if (!world?.current_branch_id) return [];
    const { user_id } = await resolveMember(ctx, session_token, world._id);
    if (world.owner_user_id !== user_id) return [];
    const rows = await ctx.db
      .query("themes")
      .withIndex("by_world_branch_version", (q: any) =>
        q.eq("world_id", world._id).eq("branch_id", world.current_branch_id!),
      )
      .collect();
    rows.sort((a: any, b: any) => b.version - a.version);
    return rows.map((r: any) => ({
      id: r._id,
      version: r.version,
      active: r.active,
      name: r.spec?.name ?? "(unnamed)",
      descriptor: r.spec?.descriptor ?? "",
      created_at: r.created_at,
    }));
  },
});

/** Owner-only: activate a specific theme version (rollback). */
export const setActiveTheme = mutation({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    theme_id: v.id("themes"),
  },
  handler: async (ctx, { session_token, world_slug, theme_id }) => {
    const world = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q) => q.eq("slug", world_slug))
      .first();
    if (!world) throw new Error("world not found");
    const { user_id } = await resolveMember(ctx, session_token, world._id);
    if (world.owner_user_id !== user_id) throw new Error("setActiveTheme is owner-only");
    const theme = await ctx.db.get(theme_id);
    if (!theme || theme.world_id !== world._id) throw new Error("theme not in this world");
    // Flip any prior active flag off.
    const actives = await ctx.db
      .query("themes")
      .withIndex("by_world_branch_active", (q: any) =>
        q.eq("world_id", world._id).eq("branch_id", theme.branch_id).eq("active", true),
      )
      .collect();
    for (const a of actives) await ctx.db.patch(a._id, { active: false });
    await ctx.db.patch(theme_id, { active: true });
    return { theme_id };
  },
});
