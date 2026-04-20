// Prompt-based entity editing (spec 11). Universal pattern:
//   1. Owner supplies feedback on an artifact (location, NPC, item, bible).
//   2. Opus proposes a JSON rewrite keeping tone/taboos/established facts.
//   3. Owner reviews diff; accepts → new artifact_version. Rejects → no-op.
//
// Bible-edit already landed at convex/worlds.ts; this module extends
// the pattern to locations + NPCs + items. Shared helper lives here.

import { action, mutation, internalQuery } from "./_generated/server.js";
import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import { resolveMember } from "./sessions.js";
import { readJSONBlob, writeJSONBlob } from "./blobs.js";
import { sanitizeLocationPayload } from "@weaver/engine/diagnostics";
import { logBugs } from "./diagnostics.js";
import { appendMentorship } from "./mentorship.js";
import { anthropicCostUsd } from "./cost.js";
import { stampEraOnCreate } from "./eras.js";
import Anthropic from "@anthropic-ai/sdk";
import type { Id } from "./_generated/dataModel.js";

const EDIT_MODEL = "claude-opus-4-7";

const EDIT_SYSTEM_PROMPT = `You help a family edit an entity in their Weaver world. They give you the current entity JSON plus feedback. Respond with strict JSON:

{
  "suggested": { <the full updated entity object, preserving existing fields that don't need to change> },
  "rationale": "<one short paragraph explaining what you changed and why>"
}

Rules:
- Keep every field that doesn't need to change. Don't rename slugs.
- Preserve tone/voice/biome/taboos; tighten what the feedback targets.
- Don't invent new entities (new npc names, new locations) unless the feedback asks.
- No markdown, no code fences, just JSON.`;

type EditableType = "location" | "npc" | "item";

/** Action: ask Opus for a diff on a location/NPC/item. Owner-only. */
export const suggestEntityEdit = action({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    type: v.string(),
    slug: v.string(),
    feedback: v.string(),
  },
  handler: async (
    ctx,
    { session_token, world_slug, type, slug, feedback },
  ): Promise<{
    current: Record<string, unknown>;
    suggested: Record<string, unknown>;
    rationale: string;
    entity_id: Id<"entities">;
    current_version: number;
  }> => {
    const t = assertEditable(type);
    const trimmed = feedback.trim();
    if (trimmed.length < 4) throw new Error("feedback too short");
    if (trimmed.length > 1500) throw new Error("feedback too long");

    const info = await ctx.runQuery(internal.entity_edit.loadEntityForEdit, {
      session_token,
      world_slug,
      type: t,
      slug,
    });
    if (!info) throw new Error("entity not found or forbidden");

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: EDIT_MODEL,
      max_tokens: 3000,
      system: [{ type: "text", text: EDIT_SYSTEM_PROMPT }],
      messages: [
        {
          role: "user",
          content: `<current_${t}>\n${JSON.stringify(info.payload, null, 2)}\n</current_${t}>\n\n<feedback>${trimmed}</feedback>\n\nRespond with strict JSON only.`,
        },
      ],
    });
    await ctx.runMutation(internal.cost.logCostUsd, {
      world_id: info.world_id,
      kind: `anthropic:${EDIT_MODEL}:${t}_edit`,
      cost_usd: anthropicCostUsd(EDIT_MODEL, response.usage as any),
      reason: `${t} edit for ${slug}`,
    });
    const text = response.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("")
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "");
    if (response.stop_reason === "max_tokens") {
      throw new Error(`${t}-edit hit max_tokens — try a terser feedback`);
    }
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch (e: any) {
      throw new Error(
        `${t}-edit JSON parse failed (${e?.message ?? e}); raw: ${text.slice(0, 240)}...`,
      );
    }
    if (!parsed?.suggested || typeof parsed.suggested !== "object")
      throw new Error("response missing suggested field");
    return {
      current: info.payload,
      suggested: parsed.suggested,
      rationale: String(parsed.rationale ?? ""),
      entity_id: info.entity_id,
      current_version: info.version,
    };
  },
});

export const loadEntityForEdit = internalQuery({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    type: v.string(),
    slug: v.string(),
  },
  handler: async (ctx, { session_token, world_slug, type, slug }) => {
    const world = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q: any) => q.eq("slug", world_slug))
      .first();
    if (!world) return null;
    const { user_id } = await resolveMember(ctx as any, session_token, world._id);
    if (world.owner_user_id !== user_id) return null;
    if (!world.current_branch_id) return null;
    const entity = await ctx.db
      .query("entities")
      .withIndex("by_branch_type_slug", (q: any) =>
        q.eq("branch_id", world.current_branch_id!).eq("type", type).eq("slug", slug),
      )
      .first();
    if (!entity) return null;
    const v = await ctx.db
      .query("artifact_versions")
      .withIndex("by_artifact_version", (q: any) =>
        q.eq("artifact_entity_id", entity._id).eq("version", entity.current_version),
      )
      .first();
    if (!v) return null;
    const payload = await readJSONBlob<Record<string, unknown>>(
      ctx as any,
      v.blob_hash,
    );
    return {
      payload,
      entity_id: entity._id,
      version: entity.current_version,
      world_id: world._id,
      branch_id: world.current_branch_id,
    };
  },
});

/** Mutation: persist the accepted diff as a new artifact_version.
 *  Optimistic-concurrency-checked on expected_version. Owner-only. */
export const applyEntityEdit = mutation({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    type: v.string(),
    slug: v.string(),
    new_payload_json: v.string(),
    expected_version: v.number(),
    reason: v.optional(v.string()),
  },
  handler: async (
    ctx,
    {
      session_token,
      world_slug,
      type,
      slug,
      new_payload_json,
      expected_version,
      reason,
    },
  ) => {
    const t = assertEditable(type);
    const world = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q) => q.eq("slug", world_slug))
      .first();
    if (!world) throw new Error(`world not found: ${world_slug}`);
    const { user, user_id } = await resolveMember(ctx, session_token, world._id);
    if (world.owner_user_id !== user_id)
      throw new Error(`apply-${t}-edit is owner-only`);
    if (!world.current_branch_id) throw new Error("world has no branch");
    const entity = await ctx.db
      .query("entities")
      .withIndex("by_branch_type_slug", (q) =>
        q.eq("branch_id", world.current_branch_id!).eq("type", t).eq("slug", slug),
      )
      .first();
    if (!entity) throw new Error(`${t} not found: ${slug}`);
    if (entity.current_version !== expected_version) {
      throw new Error(
        `${t} version changed (saw v${entity.current_version}, expected v${expected_version}); reload and retry`,
      );
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(new_payload_json);
    } catch (e: any) {
      throw new Error(`new_payload_json not parseable: ${e?.message ?? e}`);
    }
    // Sanitize locations through the existing diagnostics pass so
    // prompt-edits go through the same invariant gate as CLI pushes.
    if (t === "location") {
      const { payload: sanitized, fixes } = sanitizeLocationPayload(payload);
      if (fixes.length > 0) {
        await logBugs(ctx, fixes, {
          world_id: world._id,
          branch_id: world.current_branch_id,
        });
      }
      payload = sanitized as Record<string, unknown>;
    }
    // Snapshot prior payload for mentorship log.
    let before: Record<string, unknown> | undefined;
    try {
      const priorVersion = await ctx.db
        .query("artifact_versions")
        .withIndex("by_artifact_version", (q) =>
          q
            .eq("artifact_entity_id", entity._id)
            .eq("version", entity.current_version),
        )
        .first();
      if (priorVersion) {
        before = (await readJSONBlob<Record<string, unknown>>(
          ctx as any,
          priorVersion.blob_hash,
        )) as Record<string, unknown>;
      }
    } catch {}
    const hash = await writeJSONBlob(ctx, payload);
    const nextV = entity.current_version + 1;
    const eraAtEdit = await stampEraOnCreate(ctx, world._id);
    await ctx.db.insert("artifact_versions", {
      world_id: world._id,
      branch_id: world.current_branch_id,
      artifact_entity_id: entity._id,
      version: nextV,
      blob_hash: hash,
      content_type: "application/json",
      author_user_id: user_id,
      author_pseudonym: user.display_name ?? "author",
      edit_kind: `${t}_prompt_edit`,
      reason: reason ?? "ai-suggested edit approved",
      era: eraAtEdit,
      created_at: Date.now(),
    });
    await ctx.db.patch(entity._id, {
      current_version: nextV,
      updated_at: Date.now(),
    });
    await appendMentorship(ctx, {
      world_id: world._id,
      user_id,
      scope: `${t}.edit` as any,
      context: { entity_id: entity._id, slug, prior_version: expected_version },
      human_action: { accepted: true, new_version: nextV, reason },
      before,
      after: payload,
    });
    return { version: nextV };
  },
});

function assertEditable(type: string): EditableType {
  if (type === "location" || type === "npc" || type === "item") return type;
  throw new Error(`entity type not editable via prompt: ${type}`);
}
