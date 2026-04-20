// Journeys — tracks runs of draft locations between canonical stops,
// plus the journal UI's data layer. See spec/19_JOURNEYS_AND_JOURNAL.md.

import {
  query,
  mutation,
  internalAction,
  internalQuery,
  internalMutation,
} from "./_generated/server.js";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import { resolveMember, resolveSession } from "./sessions.js";
import { readJSONBlob, writeJSONBlob } from "./blobs.js";
import { internal } from "./_generated/api.js";
import Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------
// Helpers (called from applyOption + expandFromFreeText's mutation path)

export async function recordJourneyTransition(
  ctx: any,
  args: {
    world_id: Id<"worlds">;
    branch_id: Id<"branches">;
    user_id: Id<"users">;
    character_id: Id<"characters">;
    new_location: Doc<"entities">; // where the character just moved to
  },
): Promise<{ closed_journey_id: Id<"journeys"> | null }> {
  const { world_id, branch_id, user_id, character_id, new_location } = args;
  const now = Date.now();
  const isDraft = (new_location as any).draft === true;

  // Find the character's currently-open journey (there's at most one).
  const open = (await ctx.db
    .query("journeys")
    .withIndex("by_world_character_status", (q: any) =>
      q
        .eq("world_id", world_id)
        .eq("character_id", character_id)
        .eq("status", "open"),
    )
    .first()) as Doc<"journeys"> | null;

  if (isDraft) {
    if (open) {
      // Already dreaming — append if not already the tail.
      const last = open.entity_ids[open.entity_ids.length - 1];
      if (last !== new_location._id) {
        await ctx.db.patch(open._id, {
          entity_ids: [...open.entity_ids, new_location._id],
          entity_slugs: [...open.entity_slugs, new_location.slug],
        });
      }
    } else {
      await ctx.db.insert("journeys", {
        world_id,
        branch_id,
        character_id,
        user_id,
        opened_at: now,
        entity_ids: [new_location._id],
        entity_slugs: [new_location.slug],
        status: "open",
      });
    }
    return { closed_journey_id: null };
  }

  // Canonical arrival. If a journey is open with entries, close it.
  if (open && open.entity_ids.length > 0) {
    await ctx.db.patch(open._id, { closed_at: now, status: "closed" });
    // Async: generate a one-sentence cluster tag so the journal + close
    // panel can show it without blocking render.
    await ctx.scheduler.runAfter(0, internal.journeys.summarizeJourney, {
      journey_id: open._id,
    });
    return { closed_journey_id: open._id };
  }
  if (open) {
    // Open journey with zero entries (shouldn't happen but defensively clean).
    await ctx.db.patch(open._id, {
      closed_at: now,
      status: "dismissed",
    });
  }
  return { closed_journey_id: null };
}

// ---------------------------------------------------------------
// Queries

export const listMineInWorld = query({
  args: { session_token: v.string(), world_id: v.id("worlds") },
  handler: async (ctx, { session_token, world_id }) => {
    const { user_id } = await resolveMember(ctx, session_token, world_id);
    const rows = await ctx.db
      .query("journeys")
      .withIndex("by_world_user", (q) =>
        q.eq("world_id", world_id).eq("user_id", user_id),
      )
      .collect();
    // Hide dismissed from the journal UI.
    const visible = rows.filter((r) => r.status !== "dismissed");
    visible.sort((a, b) => (b.opened_at ?? 0) - (a.opened_at ?? 0));
    return visible.map((j) => ({
      _id: j._id,
      opened_at: j.opened_at,
      closed_at: j.closed_at,
      status: j.status,
      summary: j.summary ?? null,
      entity_slugs: j.entity_slugs,
      entity_ids: j.entity_ids,
    }));
  },
});

/** Fetch the entities in a journey (for rendering the close panel / journal detail). */
export const getJourney = query({
  args: { session_token: v.string(), journey_id: v.id("journeys") },
  handler: async (ctx, { session_token, journey_id }) => {
    const journey = await ctx.db.get(journey_id);
    if (!journey) return null;
    // Don't throw for non-owners — soft-404 so the existence of a
    // journey_id never leaks cross-user. user_id equality is the only
    // check needed; journey.user_id is isolation's strong link.
    const { user_id } = await resolveSession(ctx, session_token);
    if (journey.user_id !== user_id) return null;

    const entities = [];
    for (const entity_id of journey.entity_ids) {
      const e = await ctx.db.get(entity_id);
      if (!e) continue;
      const v = await ctx.db
        .query("artifact_versions")
        .withIndex("by_artifact_version", (q) =>
          q.eq("artifact_entity_id", e._id).eq("version", e.current_version),
        )
        .first();
      const payload = v
        ? await readJSONBlob<{ name?: string; biome?: string }>(
            ctx as any,
            v.blob_hash,
          )
        : null;
      entities.push({
        entity_id: e._id,
        slug: e.slug,
        draft: (e as any).draft === true,
        name: payload?.name ?? e.slug,
        biome: payload?.biome ?? null,
      });
    }

    return {
      _id: journey._id,
      world_id: journey.world_id,
      opened_at: journey.opened_at,
      closed_at: journey.closed_at,
      status: journey.status,
      summary: journey.summary ?? null,
      entities,
    };
  },
});

// ---------------------------------------------------------------
// Mutations

/**
 * Save some-or-all of the drafts in a journey to the map. For each
 * given slug: flips draft=false, extends its parent's options.
 * Updates the journey's status to "saved" (if any saved) or "discarded"
 * (if zero). Rejects slugs that aren't part of this journey.
 */
export const resolveJourney = mutation({
  args: {
    session_token: v.string(),
    journey_id: v.id("journeys"),
    keep_slugs: v.array(v.string()),
  },
  handler: async (ctx, { session_token, journey_id, keep_slugs }) => {
    const journey = await ctx.db.get(journey_id);
    if (!journey) throw new Error("journey not found");
    const { user, user_id } = await resolveMember(
      ctx,
      session_token,
      journey.world_id,
    );
    if (journey.user_id !== user_id) throw new Error("forbidden");

    const now = Date.now();
    const slugSet = new Set(journey.entity_slugs);
    const invalid = keep_slugs.filter((s) => !slugSet.has(s));
    if (invalid.length > 0) {
      throw new Error(
        `slugs not in this journey: ${invalid.join(", ")}`,
      );
    }

    let saved = 0;
    for (const slug of keep_slugs) {
      const entity = await ctx.db
        .query("entities")
        .withIndex("by_branch_type_slug", (q) =>
          q
            .eq("branch_id", journey.branch_id)
            .eq("type", "location")
            .eq("slug", slug),
        )
        .first();
      if (!entity) continue;
      if (entity.draft !== true) {
        // Already saved — skip silently.
        continue;
      }
      await ctx.db.patch(entity._id, { draft: false, updated_at: now });

      // Extend the parent's options with a door to this location.
      if (entity.expanded_from_entity_id) {
        const parent = await ctx.db.get(entity.expanded_from_entity_id);
        if (parent && parent.type === "location") {
          const parentVersion = await ctx.db
            .query("artifact_versions")
            .withIndex("by_artifact_version", (q) =>
              q
                .eq("artifact_entity_id", parent._id)
                .eq("version", parent.current_version),
            )
            .first();
          if (parentVersion) {
            const parentPayload = await readJSONBlob<{
              options?: Array<{ label: string; target?: string }>;
              [k: string]: unknown;
            }>(ctx as any, parentVersion.blob_hash);
            const optionsExisting = Array.isArray(parentPayload.options)
              ? parentPayload.options
              : [];
            if (!optionsExisting.some((o) => o.target === slug)) {
              const childVersion = await ctx.db
                .query("artifact_versions")
                .withIndex("by_artifact_version", (q) =>
                  q
                    .eq("artifact_entity_id", entity._id)
                    .eq("version", entity.current_version),
                )
                .first();
              const childPayload = childVersion
                ? await readJSONBlob<{ name?: string }>(
                    ctx as any,
                    childVersion.blob_hash,
                  )
                : null;
              const doorLabel = childPayload?.name
                ? `Toward ${childPayload.name}`
                : `Toward ${slug}`;
              const nextOptions = [
                ...optionsExisting,
                { label: doorLabel, target: slug },
              ];
              const nextPayload = { ...parentPayload, options: nextOptions };
              const nextHash = await writeJSONBlob(ctx as any, nextPayload);
              const nextVersion = parent.current_version + 1;
              await ctx.db.insert("artifact_versions", {
                world_id: journey.world_id,
                branch_id: journey.branch_id,
                artifact_entity_id: parent._id,
                version: nextVersion,
                blob_hash: nextHash,
                content_type: "application/json",
                author_user_id: user_id,
                author_pseudonym: user.display_name ?? user.email,
                edit_kind: "edit_direct",
                reason: `journey saveCluster: add door to ${slug}`,
                created_at: now,
              });
              await ctx.db.patch(parent._id, {
                current_version: nextVersion,
                updated_at: now,
              });
            }
          }
        }
      }
      saved++;
    }

    await ctx.db.patch(journey._id, {
      status: saved > 0 ? "saved" : "discarded",
    });

    return { saved, total: journey.entity_ids.length };
  },
});

// ---------------------------------------------------------------
// Summary — Sonnet cluster-tag, populated async on journey close.

export const summarizeJourney = internalAction({
  args: { journey_id: v.id("journeys") },
  handler: async (ctx, { journey_id }) => {
    const details: {
      descriptions: string[];
      existing_summary?: string | null;
    } | null = await ctx.runQuery(internal.journeys.loadSummaryContext, {
      journey_id,
    });
    if (!details) return;
    if (details.existing_summary) return; // don't re-summarize
    if (details.descriptions.length === 0) return;

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const system =
      "You read a sequence of location descriptions from a collaborative story-game and return a single sentence (≤80 characters) that captures the cluster. If the places don't feel like one coherent arc, say so briefly. Plain text. No quotes, no preamble.";
    const user = details.descriptions
      .map((d, i) => `${i + 1}. ${d.replace(/\s+/g, " ").slice(0, 400)}`)
      .join("\n\n");

    let summary = "";
    try {
      const resp = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 120,
        system,
        messages: [{ role: "user", content: user }],
      });
      summary =
        resp.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("")
          .trim()
          .replace(/^["']|["']$/g, "")
          .slice(0, 120) ?? "";
    } catch (e) {
      console.error(`[journeys] summarize ${journey_id}: ${(e as Error).message}`);
      return;
    }
    if (summary) {
      await ctx.runMutation(internal.journeys.patchSummary, {
        journey_id,
        summary,
      });
    }
  },
});

export const loadSummaryContext = internalQuery({
  args: { journey_id: v.id("journeys") },
  handler: async (ctx, { journey_id }) => {
    const j = await ctx.db.get(journey_id);
    if (!j) return null;
    const descriptions: string[] = [];
    for (const id of j.entity_ids) {
      const e = await ctx.db.get(id);
      if (!e) continue;
      const v = await ctx.db
        .query("artifact_versions")
        .withIndex("by_artifact_version", (q) =>
          q.eq("artifact_entity_id", e._id).eq("version", e.current_version),
        )
        .first();
      if (!v) continue;
      const payload = await readJSONBlob<{
        name?: string;
        description_template?: string;
      }>(ctx as any, v.blob_hash);
      const label = payload?.name ? `${payload.name}: ` : "";
      const body = (payload?.description_template ?? "").replace(/\{\{.*?\}\}/g, "");
      descriptions.push(label + body);
    }
    return {
      descriptions,
      existing_summary: j.summary ?? null,
    };
  },
});

export const patchSummary = internalMutation({
  args: { journey_id: v.id("journeys"), summary: v.string() },
  handler: async (ctx, { journey_id, summary }) => {
    await ctx.db.patch(journey_id, { summary });
  },
});

/** Mark a journey dismissed — hides from journal, keeps drafts navigable by URL. */
export const dismissJourney = mutation({
  args: { session_token: v.string(), journey_id: v.id("journeys") },
  handler: async (ctx, { session_token, journey_id }) => {
    const journey = await ctx.db.get(journey_id);
    if (!journey) throw new Error("journey not found");
    const { user_id } = await resolveMember(ctx, session_token, journey.world_id);
    if (journey.user_id !== user_id) throw new Error("forbidden");
    await ctx.db.patch(journey._id, { status: "dismissed" });
    return { ok: true };
  },
});
