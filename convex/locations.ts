// Location reads + applyOption mutation. Every call is world-scoped; the
// client addresses by slug; the server resolves entity ids from the
// caller's branch.

import { query, mutation } from "./_generated/server.js";
import { v } from "convex/values";
import { readJSONBlob } from "./blobs.js";
import { resolveMember } from "./sessions.js";
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
    await resolveMember(ctx, session_token, world_id);
    const branch_id = await loadBranch(ctx, world_id);
    const entity = await ctx.db
      .query("entities")
      .withIndex("by_branch_type_slug", (q) =>
        q.eq("branch_id", branch_id).eq("type", "location").eq("slug", slug),
      )
      .first();
    if (!entity) return null;
    const payload = await readAuthoredPayload<Record<string, unknown>>(ctx, entity);
    return {
      entity_id: entity._id,
      author_pseudonym: entity.author_pseudonym,
      version: entity.current_version,
      ...payload,
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

    // Server-enforced: character must currently be at this location, to
    // prevent acting from anywhere.
    if (character.current_location_id !== entity._id) {
      throw new Error("character is not at this location");
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
    let newLocationId: Id<"entities"> | null = null;
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
        newLocationId = target._id;
        newLocationSlug = target.slug;
      }
    }

    await ctx.db.patch(character._id, {
      state,
      current_location_id: newLocationId ?? character.current_location_id,
      updated_at: Date.now(),
    });

    return { says, new_location_slug: newLocationSlug };
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
