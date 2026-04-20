// Location reads + applyOption mutation. Every call is world-scoped; the
// client addresses by slug; the server resolves entity ids from the
// caller's branch.

import { query, mutation } from "./_generated/server.js";
import { v } from "convex/values";
import { readJSONBlob, writeJSONBlob } from "./blobs.js";
import { resolveMember } from "./sessions.js";
import { recordJourneyTransition } from "./journeys.js";
import { advanceWorldTime, evalCondition } from "@weaver/engine/clock";
import type { Doc, Id } from "./_generated/dataModel.js";

async function readAuthoredPayload<T>(
  ctx: any,
  entity: Doc<"entities">,
): Promise<T> {
  const version = await ctx.db
    .query("artifact_versions")
    .withIndex("by_artifact_version", (q: any) =>
      q
        .eq("artifact_entity_id", entity._id)
        .eq("version", entity.current_version),
    )
    .first();
  if (!version) throw new Error(`no version for entity ${entity._id}`);
  return readJSONBlob<T>(ctx, version.blob_hash);
}

async function loadBranch(ctx: any, world_id: Id<"worlds">) {
  const world = await ctx.db.get(world_id);
  if (!world?.current_branch_id) throw new Error("world has no current branch");
  return world.current_branch_id as Id<"branches">;
}

export const getBySlug = query({
  args: {
    session_token: v.string(),
    world_id: v.id("worlds"),
    slug: v.string(),
  },
  handler: async (ctx, { session_token, world_id, slug }) => {
    const { user_id } = await resolveMember(ctx, session_token, world_id);
    const branch_id = await loadBranch(ctx, world_id);
    const entity = await ctx.db
      .query("entities")
      .withIndex("by_branch_type_slug", (q) =>
        q.eq("branch_id", branch_id).eq("type", "location").eq("slug", slug),
      )
      .first();
    if (!entity) return null;
    const payload = await readAuthoredPayload<Record<string, unknown>>(ctx, entity);

    // Build the scope for condition evaluation — world clock + character state.
    const branch = await ctx.db.get(branch_id);
    const worldState = (branch?.state ?? {}) as Record<string, unknown>;
    const character = await ctx.db
      .query("characters")
      .withIndex("by_world_user", (q) =>
        q.eq("world_id", world_id).eq("user_id", user_id),
      )
      .first();
    const characterState = (character?.state ?? {}) as Record<string, unknown>;
    const thisScope =
      ((characterState as any)?.this?.[slug] as Record<string, unknown>) ?? {};

    const conditionScope = {
      world: worldState,
      character: characterState,
      this: thisScope,
      location: {},
    };

    // Filter options by condition. Keep original index on each shown
    // option so the server can still resolve option_index -> full opt.
    const rawOpts = Array.isArray((payload as any).options)
      ? ((payload as any).options as Array<{
          label: string;
          condition?: string;
          target?: string;
          effect?: any[];
        }>)
      : [];
    const options = rawOpts
      .map((o, original_index) => ({ ...o, original_index }))
      .filter((o) => !o.condition || evalCondition(o.condition, conditionScope));
    const art_url =
      entity.art_blob_hash && process.env.R2_IMAGES_PUBLIC_URL
        ? `${process.env.R2_IMAGES_PUBLIC_URL}/blob/${entity.art_blob_hash.slice(0, 2)}/${entity.art_blob_hash.slice(2, 4)}/${entity.art_blob_hash}`
        : null;
    return {
      entity_id: entity._id,
      author_pseudonym: entity.author_pseudonym,
      author_user_id: entity.author_user_id,
      version: entity.current_version,
      draft: entity.draft === true,
      expanded_from_entity_id: entity.expanded_from_entity_id,
      art_url,
      art_status: entity.art_status ?? null,
      ...payload,
      // Override options with the condition-filtered list. Each has
      // `original_index` so applyOption can still look up the full
      // option payload server-side.
      options,
      // Expose world state so the page can render clock etc.
      world_state: worldState,
    };
  },
});

/** Look up a location's slug from its entity id (for redirect after goto). */
export const getSlugById = query({
  args: {
    session_token: v.string(),
    world_id: v.id("worlds"),
    entity_id: v.id("entities"),
  },
  handler: async (ctx, { session_token, world_id, entity_id }) => {
    await resolveMember(ctx, session_token, world_id);
    const entity = await ctx.db.get(entity_id);
    if (!entity || entity.world_id !== world_id) return null;
    return { slug: entity.slug };
  },
});

export const applyOption = mutation({
  args: {
    session_token: v.string(),
    world_id: v.id("worlds"),
    location_slug: v.string(),
    option_index: v.number(),
  },
  handler: async (ctx, { session_token, world_id, location_slug, option_index }) => {
    const { user_id } = await resolveMember(ctx, session_token, world_id);
    const branch_id = await loadBranch(ctx, world_id);

    const character = await ctx.db
      .query("characters")
      .withIndex("by_world_user", (q) =>
        q.eq("world_id", world_id).eq("user_id", user_id),
      )
      .first();
    if (!character) throw new Error("you have no character in this world");

    const entity = await ctx.db
      .query("entities")
      .withIndex("by_branch_type_slug", (q) =>
        q
          .eq("branch_id", branch_id)
          .eq("type", "location")
          .eq("slug", location_slug),
      )
      .first();
    if (!entity) throw new Error(`location "${location_slug}" not found`);

    // If the character's recorded location disagrees with the URL, we
    // trust the URL — the player arrived here via the UI, so reconcile
    // their current_location_id on the fly. (Every location is authored
    // content; options are indexed server-side; there's no "secret"
    // option you can pick from elsewhere. The per-user scope prevents
    // cross-user mischief.)
    if (character.current_location_id !== entity._id) {
      await ctx.db.patch(character._id, {
        current_location_id: entity._id,
      });
    }

    const payload = await readAuthoredPayload<{
      slug: string;
      options: Array<{
        label: string;
        target?: string;
        effect?: Array<{ kind: string; [k: string]: unknown }>;
      }>;
    }>(ctx, entity);

    const option = payload.options[option_index];
    if (!option) throw new Error(`option ${option_index} out of range`);
    // Re-check the option's condition server-side against current state.
    const branchRow = await ctx.db.get(branch_id);
    const worldState = (branchRow?.state ?? {}) as Record<string, unknown>;
    if ((option as any).condition) {
      const scope = {
        world: worldState,
        character: (character.state ?? {}) as Record<string, unknown>,
        this:
          ((character.state as any)?.this?.[payload.slug] as Record<string, unknown>) ?? {},
        location: {},
      };
      if (!evalCondition((option as any).condition as string, scope)) {
        throw new Error("this option is not available right now");
      }
    }

    const state = { ...(character.state ?? {}) };
    state.this ??= {};
    state.this[payload.slug] ??= {};
    const thisScope = state.this[payload.slug] as Record<string, unknown>;
    const says: string[] = [];
    let gotoSlug: string | null = option.target ?? null;

    for (const eff of option.effect ?? []) {
      if (eff.kind === "say") says.push(String(eff.text));
      else if (eff.kind === "goto") gotoSlug = String(eff.target);
      else if (eff.kind === "inc") {
        const path = String(eff.path);
        const by = Number(eff.by);
        applyNumericMutation(state, thisScope, path, (n) => n + by);
      } else if (eff.kind === "set") {
        const path = String(eff.path);
        applyScalarMutation(state, thisScope, path, eff.value);
      }
    }

    let newLocationSlug: string | null = null;
    let newLocationEntity: Doc<"entities"> | null = null;
    let needsExpansion: { hint: string } | null = null;
    if (gotoSlug) {
      const target = await ctx.db
        .query("entities")
        .withIndex("by_branch_type_slug", (q) =>
          q
            .eq("branch_id", branch_id)
            .eq("type", "location")
            .eq("slug", gotoSlug!),
        )
        .first();
      if (target) {
        newLocationEntity = target as Doc<"entities">;
        newLocationSlug = target.slug;
      } else {
        // Unresolved target — signal the client to chain into expansion.
        needsExpansion = { hint: option.label };
      }
    }

    let closedJourneyId: Id<"journeys"> | null = null;
    if (newLocationEntity) {
      const j = await recordJourneyTransition(ctx, {
        world_id,
        branch_id,
        user_id,
        character_id: character._id,
        new_location: newLocationEntity,
      });
      closedJourneyId = j.closed_journey_id;
    }

    await ctx.db.patch(character._id, {
      state,
      current_location_id:
        newLocationEntity?._id ?? character.current_location_id,
      updated_at: Date.now(),
    });

    // Advance the world clock one tick per option taken. Biome
    // time_dilation (Ask 1) will compose here later; Wave-2 MVP uses 1.
    if (branchRow?.state?.time) {
      const next = advanceWorldTime(branchRow.state.time as any, 1, 1);
      await ctx.db.patch(branch_id, {
        state: {
          ...branchRow.state,
          time: next,
          turn: ((branchRow.state as any)?.turn ?? 0) + 1,
        },
      });
    }

    return {
      says,
      new_location_slug: newLocationSlug,
      needs_expansion: needsExpansion,
      closed_journey_id: closedJourneyId,
    };
  },
});

function applyNumericMutation(
  state: Record<string, unknown>,
  thisScope: Record<string, unknown>,
  path: string,
  f: (n: number) => number,
) {
  if (path.startsWith("this.")) {
    const key = path.slice(5);
    const prev = Number(thisScope[key] ?? 0);
    thisScope[key] = f(prev);
  } else if (path.startsWith("character.")) {
    const key = path.slice(10);
    const prev = Number((state as Record<string, unknown>)[key] ?? 0);
    (state as Record<string, unknown>)[key] = f(prev);
  }
}

function applyScalarMutation(
  state: Record<string, unknown>,
  thisScope: Record<string, unknown>,
  path: string,
  value: unknown,
) {
  if (path.startsWith("this.")) thisScope[path.slice(5)] = value;
  else if (path.startsWith("character.")) state[path.slice(10)] = value;
}

/**
 * Pin a dreamed location to the shared map. Flips the entity's
 * `draft` flag to false and extends the parent location's options
 * with a link to this one (creating a new canonical version of the
 * parent so every future visitor sees the new door).
 */
export const saveToMap = mutation({
  args: {
    session_token: v.string(),
    world_id: v.id("worlds"),
    location_slug: v.string(),
    label: v.optional(v.string()),
  },
  handler: async (ctx, { session_token, world_id, location_slug, label }) => {
    const { user, user_id } = await resolveMember(ctx, session_token, world_id);
    const world = await ctx.db.get(world_id);
    if (!world?.current_branch_id) throw new Error("no current branch");
    const branch_id = world.current_branch_id as Id<"branches">;

    const entity = await ctx.db
      .query("entities")
      .withIndex("by_branch_type_slug", (q) =>
        q.eq("branch_id", branch_id).eq("type", "location").eq("slug", location_slug),
      )
      .first();
    if (!entity) throw new Error("location not found");
    if (entity.draft !== true) {
      return { ok: true, already_saved: true };
    }
    // Only the author can canonize their own draft in Wave 0. Owner
    // override lands when the roles surface matures.
    if (entity.author_user_id !== user_id) {
      const membership = await ctx.db
        .query("world_memberships")
        .withIndex("by_world_user", (q) =>
          q.eq("world_id", world_id).eq("user_id", user_id),
        )
        .first();
      if (membership?.role !== "owner") {
        throw new Error("only the author or world owner can save a draft");
      }
    }

    const now = Date.now();
    await ctx.db.patch(entity._id, { draft: false, updated_at: now });

    // Extend the parent's options with a door to this place.
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
          // Don't double-add if the author clicked save twice quickly.
          if (!optionsExisting.some((o) => o.target === location_slug)) {
            const newLocPayload = await readJSONBlob<{ name?: string }>(
              ctx as any,
              (await ctx.db
                .query("artifact_versions")
                .withIndex("by_artifact_version", (q) =>
                  q.eq("artifact_entity_id", entity._id).eq("version", entity.current_version),
                )
                .first())!.blob_hash,
            );
            const doorLabel =
              label?.trim() ||
              (newLocPayload.name
                ? `Toward ${newLocPayload.name}`
                : `Toward ${location_slug}`);
            const nextOptions = [
              ...optionsExisting,
              { label: doorLabel, target: location_slug },
            ];
            const nextPayload = { ...parentPayload, options: nextOptions };
            const nextHash = await writeJSONBlob(ctx as any, nextPayload);
            const nextVersion = parent.current_version + 1;
            await ctx.db.insert("artifact_versions", {
              world_id,
              branch_id,
              artifact_entity_id: parent._id,
              version: nextVersion,
              blob_hash: nextHash,
              content_type: "application/json",
              author_user_id: user_id,
              author_pseudonym: user.display_name ?? user.email,
              edit_kind: "edit_direct",
              reason: `saveToMap: add door to ${location_slug}`,
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

    return { ok: true, already_saved: false };
  },
});

/** List every draft location this player has created in a world. */
export const listMyDrafts = query({
  args: { session_token: v.string(), world_id: v.id("worlds") },
  handler: async (ctx, { session_token, world_id }) => {
    const { user_id } = await resolveMember(ctx, session_token, world_id);
    const entities = await ctx.db
      .query("entities")
      .withIndex("by_branch_type", (q) => q.eq("branch_id", undefined as any).eq("type", "location"))
      // The index starts with branch_id, so the `by_branch_type` query
      // scopes to a branch. We need the world's current branch:
      .collect();
    // Filter in-memory for draft + author_user_id + world_id.
    const mine = entities.filter(
      (e) =>
        e.world_id === world_id &&
        e.author_user_id === user_id &&
        e.draft === true,
    );
    // Enrich with parent slug + name for display.
    const enriched = [];
    for (const e of mine) {
      const v = await ctx.db
        .query("artifact_versions")
        .withIndex("by_artifact_version", (q) =>
          q.eq("artifact_entity_id", e._id).eq("version", e.current_version),
        )
        .first();
      const payload = v
        ? await readJSONBlob<{ name?: string; biome?: string }>(ctx as any, v.blob_hash)
        : null;
      let parent_slug: string | null = null;
      if (e.expanded_from_entity_id) {
        const parent = await ctx.db.get(e.expanded_from_entity_id);
        parent_slug = (parent as any)?.slug ?? null;
      }
      enriched.push({
        slug: e.slug,
        name: payload?.name ?? e.slug,
        biome: payload?.biome ?? null,
        parent_slug,
        created_at: e.created_at,
      });
    }
    enriched.sort((a, b) => b.created_at - a.created_at);
    return enriched;
  },
});
