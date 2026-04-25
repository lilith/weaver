// Stat schema admin — per-world presentation overlay for HP/Gold/
// Energy/inventory + display-only custom stats. See spec/STAT_SCHEMA.md.
//
// Pure presentation: modules never read this. The play-page renderer
// reads it; everything else (combat damage, give_item, etc.) keeps
// touching the canonical state paths.
//
// Three operations (mirror the bible-editor pattern):
//   getStatSchema      query  — returns world.stat_schema or null
//   suggestStatSchema  action — Opus drafts a schema diff matched to
//                                the world bible + the owner's feedback
//   applyStatSchema    mutation — owner-only; replaces the schema blob
//                                  (the action returns a full proposed
//                                  schema, so apply is a wholesale set)

import { v } from "convex/values";
import Anthropic from "@anthropic-ai/sdk";
import {
  action,
  internalQuery,
  mutation,
  query,
} from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { resolveMember, resolveSession } from "./sessions.js";
import { anthropicCostUsd } from "./cost.js";
import { appendMentorship } from "./mentorship.js";
import { readJSONBlob } from "./blobs.js";
import {
  CANONICAL_STATS,
  type StatSchema,
} from "@weaver/engine/stats";
import type { Doc, Id } from "./_generated/dataModel.js";

const STAT_SCHEMA_MODEL = "claude-opus-4-7";

const STAT_SCHEMA_SYSTEM_PROMPT = `You help a family tune how stats appear in their Weaver world. The engine has a fixed vocabulary of canonical stats — HP, GOLD, ENERGY, INVENTORY — that modules read and write directly. Your job is to design the *display overlay* for this world: what each stat is called, whether it's hidden, which custom display-only stats to add.

You CAN change:
- canonical[<key>].label  — what the player sees ("vitality", "coin")
- canonical[<key>].icon   — single glyph
- canonical[<key>].color  — token like "rose-400" / "candle-300" / "teal-400"
- canonical[<key>].format — "value" | "fraction" | "bar" | "tally"
- canonical[<key>].max    — cap for fraction/bar/tally
- canonical[<key>].hidden — true to omit from the panel
- canonical[<key>].order  — sort priority (lower = earlier)
- custom[]                — display-only stats sourced from arbitrary state.* paths
- item_kinds[<kind>]      — display tweaks per item kind
- inventory_label         — heading above inventory chips
- preset                  — purely a UX hint; "litrpg" / "standard-fantasy" / "cozy" / "custom"

You MUST NOT:
- Invent new canonical keys (the engine's vocabulary is frozen).
- Imply that custom stats are mutable by game rules — they aren't.
- Ignore the world bible's voice — match its tone.

Respond with strict JSON only:

{
  "suggested_schema": { <full StatSchema object> },
  "rationale": "<one short paragraph explaining the choices>"
}

If the user asked to remove the stat row entirely, set every canonical entry's hidden:true and add a tasteful inventory_label. Stay tight — JSON only.`;

async function loadWorldAsOwner(
  ctx: any,
  session_token: string,
  world_slug: string,
): Promise<{ world: Doc<"worlds">; user: Doc<"users">; user_id: Id<"users"> }> {
  const world = (await ctx.db
    .query("worlds")
    .withIndex("by_slug", (q: any) => q.eq("slug", world_slug))
    .first()) as Doc<"worlds"> | null;
  if (!world) throw new Error(`world not found: ${world_slug}`);
  const { user_id, user } = await resolveMember(ctx, session_token, world._id);
  if (world.owner_user_id !== user_id)
    throw new Error("forbidden: stat schema is owner-only");
  return { world, user, user_id };
}

// --------------------------------------------------------------------
// Query

/** Return the current stat schema. Visible to any world member so the
 *  play-page renderer can pick it up; not member-gated as confidential. */
export const getStatSchema = query({
  args: { session_token: v.string(), world_slug: v.string() },
  handler: async (ctx, { session_token, world_slug }) => {
    const world = (await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q: any) => q.eq("slug", world_slug))
      .first()) as Doc<"worlds"> | null;
    if (!world) return null;
    await resolveMember(ctx, session_token, world._id);
    const schema = (world.stat_schema ?? null) as StatSchema | null;
    return { schema, world_id: world._id };
  },
});

// --------------------------------------------------------------------
// Suggest (Opus)

export const suggestStatSchema = action({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    feedback: v.string(),
  },
  handler: async (
    ctx,
    { session_token, world_slug, feedback },
  ): Promise<{
    current: StatSchema | null;
    suggested: StatSchema;
    rationale: string;
  }> => {
    const trimmed = feedback.trim();
    if (trimmed.length < 4) throw new Error("feedback too short");
    if (trimmed.length > 1500) throw new Error("feedback too long");

    const info = await ctx.runQuery(internal.stats.loadStatContext, {
      session_token,
      world_slug,
    });
    if (!info) throw new Error("world not found or forbidden");

    const userParts: string[] = [];
    userParts.push(`<canonical_keys>${Object.values(CANONICAL_STATS).join(", ")}</canonical_keys>`);
    userParts.push(`<bible>\n${JSON.stringify(info.bible, null, 2)}\n</bible>`);
    if (info.current_schema) {
      userParts.push(
        `<current_schema>\n${JSON.stringify(info.current_schema, null, 2)}\n</current_schema>`,
      );
    } else {
      userParts.push(`<current_schema>(none — engine defaults apply)</current_schema>`);
    }
    userParts.push(`<feedback>${trimmed}</feedback>`);

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: STAT_SCHEMA_MODEL,
      max_tokens: 2000,
      system: [{ type: "text", text: STAT_SCHEMA_SYSTEM_PROMPT }],
      messages: [
        {
          role: "user",
          content: userParts.join("\n\n") + "\n\nJSON only.",
        },
      ],
    });

    await ctx.runMutation(internal.cost.logCostUsd, {
      world_id: info.world_id,
      kind: `anthropic:opus:stat_schema`,
      cost_usd: anthropicCostUsd(STAT_SCHEMA_MODEL, response.usage as any),
      reason: `stat schema suggestion`,
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
      throw new Error(`stat-schema JSON parse failed: ${e?.message ?? e}`);
    }
    const suggested = sanitizeSchema(parsed?.suggested_schema);
    if (!suggested)
      throw new Error("response missing valid suggested_schema");
    return {
      current: info.current_schema,
      suggested,
      rationale: String(parsed?.rationale ?? ""),
    };
  },
});

export const loadStatContext = internalQuery({
  args: { session_token: v.string(), world_slug: v.string() },
  handler: async (ctx, { session_token, world_slug }) => {
    const { world } = await loadWorldAsOwner(ctx, session_token, world_slug);
    let bible: Record<string, unknown> = {};
    if (world.current_branch_id) {
      const bibleEntity = await ctx.db
        .query("entities")
        .withIndex("by_branch_type_slug", (q: any) =>
          q
            .eq("branch_id", world.current_branch_id)
            .eq("type", "bible")
            .eq("slug", "bible"),
        )
        .first();
      if (bibleEntity) {
        const vrow = await ctx.db
          .query("artifact_versions")
          .withIndex("by_artifact_version", (q: any) =>
            q
              .eq("artifact_entity_id", bibleEntity._id)
              .eq("version", bibleEntity.current_version),
          )
          .first();
        if (vrow) {
          try {
            bible = await readJSONBlob<Record<string, unknown>>(
              ctx as any,
              vrow.blob_hash,
            );
          } catch {
            /* best-effort */
          }
        }
      }
    }
    return {
      world_id: world._id,
      current_schema: (world.stat_schema ?? null) as StatSchema | null,
      bible,
    };
  },
});

// --------------------------------------------------------------------
// Apply

export const applyStatSchema = mutation({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    schema_json: v.string(),
    reason: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { session_token, world_slug, schema_json, reason },
  ) => {
    const { world, user, user_id } = await loadWorldAsOwner(
      ctx,
      session_token,
      world_slug,
    );
    let parsed: any;
    try {
      parsed = JSON.parse(schema_json);
    } catch (e: any) {
      throw new Error(`schema_json not parseable: ${e?.message ?? e}`);
    }
    const sanitized = sanitizeSchema(parsed);
    if (!sanitized) throw new Error("schema invalid after sanitization");
    const before = world.stat_schema ?? null;
    await ctx.db.patch(world._id, { stat_schema: sanitized });
    await appendMentorship(ctx, {
      world_id: world._id,
      user_id,
      scope: "stat_schema.apply",
      context: { reason: reason ?? null },
      human_action: { accepted: true },
      before: (before as Record<string, unknown> | null) ?? undefined,
      after: sanitized as unknown as Record<string, unknown>,
    });
    return { ok: true };
  },
});

/** Clear the world's stat_schema, reverting to engine defaults. Owner
 *  only. Useful for "I changed my mind, just give me HP/Gold/Energy
 *  back". */
export const resetStatSchema = mutation({
  args: { session_token: v.string(), world_slug: v.string() },
  handler: async (ctx, { session_token, world_slug }) => {
    const { world } = await loadWorldAsOwner(ctx, session_token, world_slug);
    await ctx.db.patch(world._id, { stat_schema: undefined });
    return { ok: true };
  },
});

// --------------------------------------------------------------------
// Sanitization — the schema is `v.any()` in the table, so we keep the
// validator close to the apply path. Rejects anything we don't
// recognize; trims string lengths; coerces obvious mistakes.

const ALLOWED_FORMATS = new Set(["value", "fraction", "bar", "tally"]);
const ALLOWED_PRESETS = new Set([
  "litrpg",
  "standard-fantasy",
  "cozy",
  "custom",
]);

function sanitizeSchema(input: unknown): StatSchema | null {
  if (input == null || typeof input !== "object" || Array.isArray(input))
    return null;
  const src = input as Record<string, unknown>;
  const out: StatSchema = {};
  if (src.canonical && typeof src.canonical === "object") {
    out.canonical = {};
    for (const key of Object.values(CANONICAL_STATS) as string[]) {
      const entry = (src.canonical as any)[key];
      if (!entry || typeof entry !== "object") continue;
      const display: any = {};
      if (typeof entry.label === "string")
        display.label = entry.label.slice(0, 40);
      if (typeof entry.icon === "string") display.icon = entry.icon.slice(0, 4);
      if (typeof entry.color === "string")
        display.color = entry.color.slice(0, 30);
      if (typeof entry.format === "string" && ALLOWED_FORMATS.has(entry.format))
        display.format = entry.format;
      if (typeof entry.max === "number" && Number.isFinite(entry.max))
        display.max = entry.max;
      if (typeof entry.hidden === "boolean") display.hidden = entry.hidden;
      if (typeof entry.order === "number" && Number.isFinite(entry.order))
        display.order = entry.order;
      (out.canonical as any)[key] = display;
    }
  }
  if (Array.isArray(src.custom)) {
    out.custom = [];
    for (const c of src.custom as any[]) {
      if (!c || typeof c !== "object") continue;
      if (typeof c.key !== "string" || c.key.length === 0) continue;
      if (typeof c.source !== "string" || c.source.length === 0) continue;
      if (typeof c.label !== "string" || c.label.length === 0) continue;
      const item: any = {
        key: c.key.slice(0, 40),
        source: c.source.slice(0, 80),
        label: c.label.slice(0, 40),
      };
      if (typeof c.icon === "string") item.icon = c.icon.slice(0, 4);
      if (typeof c.color === "string") item.color = c.color.slice(0, 30);
      if (typeof c.format === "string" && ALLOWED_FORMATS.has(c.format))
        item.format = c.format;
      if (typeof c.max === "number" && Number.isFinite(c.max)) item.max = c.max;
      if (typeof c.hidden === "boolean") item.hidden = c.hidden;
      if (typeof c.order === "number" && Number.isFinite(c.order))
        item.order = c.order;
      out.custom.push(item);
      if (out.custom.length >= 16) break;
    }
  }
  if (src.item_kinds && typeof src.item_kinds === "object") {
    out.item_kinds = {};
    for (const [k, v] of Object.entries(src.item_kinds as any)) {
      if (!v || typeof v !== "object") continue;
      const item: any = {};
      if (typeof (v as any).label === "string")
        item.label = (v as any).label.slice(0, 40);
      if (typeof (v as any).icon === "string")
        item.icon = (v as any).icon.slice(0, 4);
      if (typeof (v as any).color === "string")
        item.color = (v as any).color.slice(0, 30);
      if (typeof (v as any).hidden === "boolean") item.hidden = (v as any).hidden;
      out.item_kinds[k.slice(0, 40)] = item;
    }
  }
  if (typeof src.inventory_label === "string")
    out.inventory_label = src.inventory_label.slice(0, 40);
  if (typeof src.preset === "string" && ALLOWED_PRESETS.has(src.preset)) {
    out.preset = src.preset as any;
  }
  return out;
}
