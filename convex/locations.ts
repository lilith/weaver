// Public queries for locations — slug-addressed reads with blob
// dereferencing. Options + description_template arrive at the client
// ready to render.

import { query, mutation } from "./_generated/server.js";
import { v } from "convex/values";
import { readJSONBlob } from "./blobs.js";
import type { Doc, Id } from "./_generated/dataModel.js";

async function readAuthoredPayload<T>(
  ctx: { db: { query: Function; get: Function } },
  entity: Doc<"entities">,
): Promise<T> {
  const version = await (ctx.db.query("artifact_versions") as any)
    .withIndex("by_artifact_version", (q: any) =>
      q.eq("artifact_entity_id", entity._id).eq("version", entity.current_version),
    )
    .first();
  if (!version) throw new Error(`no version for entity ${entity._id}`);
  return readJSONBlob<T>(ctx as any, version.blob_hash);
}

export const getLocationBySlug = query({
  args: { branch_id: v.id("branches"), slug: v.string() },
  handler: async (ctx, { branch_id, slug }) => {
    const entity = await ctx.db
      .query("entities")
      .withIndex("by_branch_type_slug", (q) =>
        q.eq("branch_id", branch_id).eq("type", "location").eq("slug", slug),
      )
      .first();
    if (!entity) return null;
    const payload = await readAuthoredPayload<Record<string, unknown>>(ctx as any, entity);
    return {
      entity_id: entity._id,
      author_pseudonym: entity.author_pseudonym,
      version: entity.current_version,
      ...payload,
    };
  },
});

export const getLocationByEntityId = query({
  args: { entity_id: v.id("entities") },
  handler: async (ctx, { entity_id }) => {
    const entity = await ctx.db.get(entity_id);
    if (!entity || entity.type !== "location") return null;
    const payload = await readAuthoredPayload<Record<string, unknown>>(ctx as any, entity);
    return {
      entity_id: entity._id,
      author_pseudonym: entity.author_pseudonym,
      version: entity.current_version,
      ...payload,
    };
  },
});

export const listLocations = query({
  args: { branch_id: v.id("branches") },
  handler: async (ctx, { branch_id }) => {
    const entities = await ctx.db
      .query("entities")
      .withIndex("by_branch_type", (q) =>
        q.eq("branch_id", branch_id).eq("type", "location"),
      )
      .collect();
    return entities.map((e) => ({
      entity_id: e._id,
      slug: e.slug,
      author_pseudonym: e.author_pseudonym,
      updated_at: e.updated_at,
    }));
  },
});

/**
 * Apply an option effect. Wave-0 minimal — handles `goto`, `say`, `inc`,
 * `set` on `this.*` (per-player-per-location) state. Returns the new
 * location id when `goto` fires, or `null` otherwise.
 *
 * This is a sketch: `this.*` state is meant to be per-character-per-location
 * (spec/02 §Scoped state). For Wave 0 we park it under
 * `character.state.this.<location_slug>.<key>`. Good enough to prove the loop;
 * refactor when `location.*` (shared) and proper `this.*` scoping are needed.
 */
export const applyOption = mutation({
  args: {
    character_id: v.id("characters"),
    location_entity_id: v.id("entities"),
    option_index: v.number(),
  },
  handler: async (ctx, { character_id, location_entity_id, option_index }) => {
    const character = await ctx.db.get(character_id);
    if (!character) throw new Error("character not found");
    const locEntity = await ctx.db.get(location_entity_id);
    if (!locEntity || locEntity.type !== "location") throw new Error("not a location");
    const payload = await readAuthoredPayload<{
      slug: string;
      options: Array<{
        label: string;
        target?: string;
        effect?: Array<{ kind: string; [k: string]: unknown }>;
      }>;
    }>(ctx as any, locEntity);
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

    let newLocationId: Id<"entities"> | null = null;
    if (gotoSlug) {
      const target = await ctx.db
        .query("entities")
        .withIndex("by_branch_type_slug", (q) =>
          q
            .eq("branch_id", character.branch_id)
            .eq("type", "location")
            .eq("slug", gotoSlug!),
        )
        .first();
      if (target) {
        newLocationId = target._id;
      }
    }

    await ctx.db.patch(character_id, {
      state,
      current_location_id: newLocationId ?? character.current_location_id,
      updated_at: Date.now(),
    });

    return { says, new_location_id: newLocationId };
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
  // location.* and world.* scopes deferred to Wave 1.
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
