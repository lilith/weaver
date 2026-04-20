// CLI-facing queries + mutations for scripts/weaver.mjs.
//
// Split into tiers by permission:
//
//   - Queries: session + membership required. Safe for observer mode.
//   - Owner mutations: require world.owner_user_id === caller.user_id.
//     Used when Claude drives its own sandbox world.
//   - Fix mutations: any member. Non-destructive — each fix creates a
//     new artifact_version tagged `edit_kind: "prose_fix"` etc., so the
//     world owner can revert trivially.
//
// Isolation: every function takes `session_token` + `world_slug`; the
// user is server-resolved via `resolveSession`, membership required,
// world scoped by slug (then by id). No cross-world reads.

import { query, mutation } from "./_generated/server.js";
import { v } from "convex/values";
import { readJSONBlob, writeJSONBlob } from "./blobs.js";
import { resolveSession, resolveMember } from "./sessions.js";
import {
  advanceWorldTime,
  evalCondition,
  initWorldTime,
  traceReferencedPaths,
} from "@weaver/engine/clock";
import { scheduleArtForEntity } from "./art.js";
import { sanitizeLocationPayload } from "@weaver/engine/diagnostics";
import { logBugs } from "./diagnostics.js";
import { stampEraOnCreate } from "./eras.js";
import type { Doc, Id } from "./_generated/dataModel.js";

// --------------------------------------------------------------------
// Helpers

async function worldBySlug(ctx: any, slug: string): Promise<Doc<"worlds">> {
  const w = await ctx.db
    .query("worlds")
    .withIndex("by_slug", (q: any) => q.eq("slug", slug))
    .first();
  if (!w) throw new Error(`world not found: ${slug}`);
  return w as Doc<"worlds">;
}

async function resolveOwned(
  ctx: any,
  session_token: string,
  world_slug: string,
) {
  const world = await worldBySlug(ctx, world_slug);
  const { user_id, membership } = await resolveMember(
    ctx,
    session_token,
    world._id,
  );
  if (world.owner_user_id !== user_id) {
    throw new Error(
      `forbidden: author-mode action on world "${world_slug}" but you are not its owner`,
    );
  }
  return { world, user_id, membership };
}

async function resolveMemberBySlug(
  ctx: any,
  session_token: string,
  world_slug: string,
) {
  const world = await worldBySlug(ctx, world_slug);
  const { user, user_id, membership } = await resolveMember(
    ctx,
    session_token,
    world._id,
  );
  return { world, user, user_id, membership };
}

async function readPayload<T>(ctx: any, entity: Doc<"entities">): Promise<T> {
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

async function myCharacter(
  ctx: any,
  world_id: Id<"worlds">,
  user_id: Id<"users">,
): Promise<Doc<"characters"> | null> {
  return (await ctx.db
    .query("characters")
    .withIndex("by_world_user", (q: any) =>
      q.eq("world_id", world_id).eq("user_id", user_id),
    )
    .first()) as Doc<"characters"> | null;
}

// --------------------------------------------------------------------
// Queries

/** Determines whether the caller owns this world (author mode vs observer). */
export const getOwnership = query({
  args: { session_token: v.string(), world_slug: v.string() },
  handler: async (ctx, { session_token, world_slug }) => {
    const world = await worldBySlug(ctx, world_slug);
    const { user_id, membership } = await resolveMember(
      ctx,
      session_token,
      world._id,
    );
    return {
      world_slug: world.slug,
      world_name: world.name,
      world_id: world._id,
      is_owner: world.owner_user_id === user_id,
      role: membership.role,
      content_rating: world.content_rating,
    };
  },
});

/** Fast "where am I" — returns world clock, current location slug, character state summary. */
export const whereAmI = query({
  args: { session_token: v.string(), world_slug: v.string() },
  handler: async (ctx, { session_token, world_slug }) => {
    const { world, user_id } = await resolveMemberBySlug(
      ctx,
      session_token,
      world_slug,
    );
    if (!world.current_branch_id) throw new Error("world has no current branch");
    const branch = await ctx.db.get(world.current_branch_id);
    const character = await myCharacter(ctx, world._id, user_id);
    let current_location_slug: string | null = null;
    if (character?.current_location_id) {
      const loc = await ctx.db.get(character.current_location_id);
      current_location_slug = (loc as Doc<"entities"> | null)?.slug ?? null;
    }
    return {
      world: { slug: world.slug, name: world.name, id: world._id },
      is_owner: world.owner_user_id === user_id,
      branch: branch
        ? {
            id: branch._id,
            name: branch.name,
            state: branch.state ?? null,
          }
        : null,
      character: character
        ? {
            id: character._id,
            name: character.name,
            pseudonym: character.pseudonym,
            current_location_slug,
            state: character.state ?? null,
          }
        : null,
    };
  },
});

/** Full location dump with ALL options (visible + hidden), condition results,
 *  and the scope used to evaluate. The core inspection command. */
export const dumpLocation = query({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    loc_slug: v.string(),
  },
  handler: async (ctx, { session_token, world_slug, loc_slug }) => {
    const { world, user_id } = await resolveMemberBySlug(
      ctx,
      session_token,
      world_slug,
    );
    if (!world.current_branch_id) throw new Error("world has no current branch");
    const branch = await ctx.db.get(world.current_branch_id);
    const entity = (await ctx.db
      .query("entities")
      .withIndex("by_branch_type_slug", (q: any) =>
        q
          .eq("branch_id", world.current_branch_id!)
          .eq("type", "location")
          .eq("slug", loc_slug),
      )
      .first()) as Doc<"entities"> | null;
    if (!entity) return null;
    const payload = await readPayload<Record<string, unknown>>(ctx, entity);

    const character = await myCharacter(ctx, world._id, user_id);
    const worldState = (branch?.state ?? {}) as Record<string, unknown>;
    const characterState = (character?.state ?? {}) as Record<string, unknown>;
    const thisScope =
      ((characterState as any)?.this?.[loc_slug] as Record<string, unknown>) ??
      {};
    const scope = {
      world: worldState,
      character: characterState,
      this: thisScope,
      location: {},
    };

    const rawOpts = Array.isArray((payload as any).options)
      ? ((payload as any).options as Array<{
          label: string;
          condition?: string;
          target?: string;
          effect?: any[];
        }>)
      : [];
    const options = rawOpts.map((o, i) => {
      const hasCond = Boolean(o.condition);
      const visible = !hasCond || evalCondition(o.condition!, scope);
      // When hidden, list the paths referenced + their current values
      // so the reader can see why without parsing the expression.
      const hidden_because = !visible && hasCond
        ? {
            condition: o.condition!,
            refs: traceReferencedPaths(o.condition!, scope),
          }
        : null;
      return {
        index: i,
        label: o.label,
        target: o.target ?? null,
        condition: o.condition ?? null,
        condition_result: hasCond ? visible : null,
        hidden_because,
        effect: o.effect ?? null,
        visible,
      };
    });

    return {
      entity_id: entity._id,
      slug: entity.slug,
      draft: entity.draft === true,
      author_pseudonym: entity.author_pseudonym,
      version: entity.current_version,
      name: (payload as any).name,
      biome: (payload as any).biome,
      tags: (payload as any).tags ?? [],
      description_template: (payload as any).description_template ?? null,
      prose: (payload as any).prose ?? null,
      neighbors: (payload as any).neighbors ?? null,
      options,
      on_enter: (payload as any).on_enter ?? null,
      world_state: worldState,
      character_state: characterState,
      this_scope: thisScope,
    };
  },
});

/** Lists entities of a given type (or all) with slugs + version + draft flag. */
export const listEntities = query({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    type: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { session_token, world_slug, type, limit }) => {
    const { world } = await resolveMemberBySlug(ctx, session_token, world_slug);
    if (!world.current_branch_id) return [];
    const rows = type
      ? await ctx.db
          .query("entities")
          .withIndex("by_branch_type_slug", (q: any) =>
            q.eq("branch_id", world.current_branch_id!).eq("type", type),
          )
          .collect()
      : await ctx.db
          .query("entities")
          .withIndex("by_branch_type", (q: any) =>
            q.eq("branch_id", world.current_branch_id!),
          )
          .collect();
    const capped = rows.slice(0, limit ?? 200);
    return capped.map((e: Doc<"entities">) => ({
      id: e._id,
      type: e.type,
      slug: e.slug,
      version: e.current_version,
      draft: e.draft === true,
      author_pseudonym: e.author_pseudonym ?? null,
      art_status: e.art_status ?? null,
    }));
  },
});

/** Returns the full payload for a single entity by type+slug. */
export const getEntity = query({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    type: v.string(),
    slug: v.string(),
  },
  handler: async (ctx, { session_token, world_slug, type, slug }) => {
    const { world } = await resolveMemberBySlug(ctx, session_token, world_slug);
    if (!world.current_branch_id) return null;
    const entity = (await ctx.db
      .query("entities")
      .withIndex("by_branch_type_slug", (q: any) =>
        q.eq("branch_id", world.current_branch_id!).eq("type", type).eq("slug", slug),
      )
      .first()) as Doc<"entities"> | null;
    if (!entity) return null;
    const payload = await readPayload<Record<string, unknown>>(ctx, entity);
    return {
      id: entity._id,
      type: entity.type,
      slug: entity.slug,
      version: entity.current_version,
      draft: entity.draft === true,
      author_pseudonym: entity.author_pseudonym ?? null,
      payload,
    };
  },
});

/** Cost ledger — recent rows + totals. */
export const getCostSummary = query({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    since_ms: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { session_token, world_slug, since_ms, limit }) => {
    const { world } = await resolveMemberBySlug(ctx, session_token, world_slug);
    const cutoff = since_ms ?? Date.now() - 7 * 24 * 60 * 60 * 1000;
    const rows = await ctx.db
      .query("cost_ledger")
      .withIndex("by_world_day", (q: any) =>
        q.eq("world_id", world._id).gte("created_at", cutoff),
      )
      .collect();
    const total = rows.reduce((s: number, r: any) => s + (r.cost_usd ?? 0), 0);
    const by_kind: Record<string, { count: number; usd: number }> = {};
    for (const r of rows) {
      const k = r.kind ?? "other";
      by_kind[k] ??= { count: 0, usd: 0 };
      by_kind[k].count++;
      by_kind[k].usd += r.cost_usd ?? 0;
    }
    const recent = rows
      .slice(-(limit ?? 20))
      .map((r: any) => ({
        kind: r.kind,
        cost_usd: r.cost_usd,
        reason: r.reason,
        created_at: r.created_at,
      }));
    return {
      total_usd: total,
      count: rows.length,
      by_kind,
      recent,
      since_ms: cutoff,
    };
  },
});

/** Bulk export: every entity in the world's current branch, with full
 *  payloads. Used by `weaver export` to dump a world into the authoring
 *  file format defined in spec/AUTHORING_AND_SYNC.md. */
export const exportWorld = query({
  args: { session_token: v.string(), world_slug: v.string() },
  handler: async (ctx, { session_token, world_slug }) => {
    const { world } = await resolveMemberBySlug(ctx, session_token, world_slug);
    if (!world.current_branch_id) return null;
    const entities = await ctx.db
      .query("entities")
      .withIndex("by_branch_type", (q: any) =>
        q.eq("branch_id", world.current_branch_id!),
      )
      .collect();
    const dumps: Array<{
      id: string;
      type: string;
      slug: string;
      version: number;
      draft: boolean;
      author_pseudonym: string | null;
      payload: Record<string, unknown>;
    }> = [];
    for (const e of entities) {
      try {
        const payload = await readPayload<Record<string, unknown>>(ctx, e);
        dumps.push({
          id: e._id,
          type: e.type,
          slug: e.slug,
          version: e.current_version,
          draft: (e as any).draft === true,
          author_pseudonym: e.author_pseudonym ?? null,
          payload,
        });
      } catch {
        // skip entities whose payload can't be read (shouldn't happen)
      }
    }
    return {
      world: {
        id: world._id,
        slug: world.slug,
        name: world.name,
        content_rating: world.content_rating,
        current_branch_id: world.current_branch_id,
      },
      exported_at: Date.now(),
      entities: dumps,
    };
  },
});

/** Version list for an entity — shows edit history, with author pseudonyms. */
export const listVersions = query({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    entity_id: v.id("entities"),
  },
  handler: async (ctx, { session_token, world_slug, entity_id }) => {
    const { world } = await resolveMemberBySlug(ctx, session_token, world_slug);
    const entity = await ctx.db.get(entity_id);
    if (!entity || (entity as any).world_id !== world._id) return null;
    const versions = await ctx.db
      .query("artifact_versions")
      .withIndex("by_artifact_version", (q: any) =>
        q.eq("artifact_entity_id", entity_id),
      )
      .collect();
    return versions.map((v: any) => ({
      version: v.version,
      edit_kind: v.edit_kind,
      reason: v.reason ?? null,
      author_pseudonym: v.author_pseudonym ?? null,
      created_at: v.created_at,
    }));
  },
});

// --------------------------------------------------------------------
// Owner-only mutations (author mode)

/** Create a fresh sandbox world for the caller. Owner = caller. */
export const createSandboxWorld = mutation({
  args: {
    session_token: v.string(),
    name: v.string(),
    slug_suffix: v.optional(v.string()),
    content_rating: v.optional(
      v.union(v.literal("family"), v.literal("teen"), v.literal("adult")),
    ),
    character_name: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { session_token, name, slug_suffix, content_rating, character_name },
  ) => {
    const { user, user_id } = await resolveSession(ctx, session_token);
    const now = Date.now();
    const suffix =
      slug_suffix?.trim() || Math.random().toString(36).slice(2, 8);
    const slug = `${slugify(name)}-${suffix}`;

    const existing = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();
    if (existing) throw new Error(`world slug already exists: ${slug}`);

    const worldId = await ctx.db.insert("worlds", {
      name,
      slug,
      owner_user_id: user_id,
      content_rating: content_rating ?? "family",
      created_at: now,
    });
    const branchId = await ctx.db.insert("branches", {
      world_id: worldId,
      name: "Main",
      slug: "main",
      transient: false,
      state: { time: initWorldTime({}), turn: 0 },
      created_at: now,
    });
    await ctx.db.patch(worldId, { current_branch_id: branchId });
    await ctx.db.insert("world_memberships", {
      world_id: worldId,
      user_id,
      role: "owner",
      created_at: now,
    });

    const bibleHash = await writeJSONBlob(ctx, {
      name,
      tagline: "A Claude sandbox. Empty until something is woven.",
      content_rating: content_rating ?? "family",
      tone: {
        descriptors: ["open", "generative"],
        avoid: [],
        prose_sample: "The page is blank. The pen is yours.",
      },
      style_anchor: {
        descriptor: "ink and watercolor, soft palette",
        prompt_fragment: "ink and watercolor, soft palette",
      },
      biomes: [],
      characters: [],
      established_facts: [],
    });
    const bibleEntityId = await ctx.db.insert("entities", {
      world_id: worldId,
      branch_id: branchId,
      type: "bible",
      slug: "bible",
      current_version: 1,
      schema_version: 1,
      author_user_id: user_id,
      author_pseudonym: user.display_name ?? "sandbox",
      created_at: now,
      updated_at: now,
    });
    await ctx.db.insert("artifact_versions", {
      world_id: worldId,
      branch_id: branchId,
      artifact_entity_id: bibleEntityId,
      version: 1,
      blob_hash: bibleHash,
      content_type: "application/json",
      author_user_id: user_id,
      author_pseudonym: user.display_name ?? "sandbox",
      edit_kind: "create",
      reason: "sandbox_init",
      created_at: now,
    });

    // Starter location: a single empty room with one back-link option that
    // triggers expansion on pick. Lets the CLI immediately `weave` outward.
    const starterPayload = {
      slug: "starter",
      type: "location",
      name: "The starting room",
      biome: "unset",
      tags: ["safe_anchor"],
      safe_anchor: true,
      author_pseudonym: user.display_name ?? "sandbox",
      options: [
        { label: "Look around", effect: [{ kind: "say", text: "Nothing yet. Weave something." }] },
      ],
      description_template:
        "An empty room with a pen on a table. The walls are blank, the door is wherever you need it to be.",
    };
    const starterHash = await writeJSONBlob(ctx, starterPayload);
    const starterId = await ctx.db.insert("entities", {
      world_id: worldId,
      branch_id: branchId,
      type: "location",
      slug: "starter",
      current_version: 1,
      schema_version: 1,
      author_user_id: user_id,
      author_pseudonym: user.display_name ?? "sandbox",
      created_at: now,
      updated_at: now,
    });
    await ctx.db.insert("artifact_versions", {
      world_id: worldId,
      branch_id: branchId,
      artifact_entity_id: starterId,
      version: 1,
      blob_hash: starterHash,
      content_type: "application/json",
      author_user_id: user_id,
      author_pseudonym: user.display_name ?? "sandbox",
      edit_kind: "create",
      reason: "sandbox_init",
      created_at: now,
    });

    await ctx.db.insert("characters", {
      world_id: worldId,
      branch_id: branchId,
      user_id,
      name: character_name?.trim() || user.display_name || "sandbox-author",
      pseudonym: character_name?.trim() || user.display_name || "sandbox-author",
      current_location_id: starterId,
      state: { inventory: [], hp: 10, gold: 0, energy: 5 },
      schema_version: 1,
      created_at: now,
      updated_at: now,
    });

    return { world_id: worldId, slug, branch_id: branchId };
  },
});

/** Fast-forward the world clock. Owner-only. Either delta_minutes or
 *  to_day_of_week+to_hhmm (jumps to the next matching slot). */
export const fastForwardClock = mutation({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    delta_minutes: v.optional(v.number()),
    to_day_of_week: v.optional(v.string()),
    to_hhmm: v.optional(v.string()),
    tick_turn_counter: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    {
      session_token,
      world_slug,
      delta_minutes,
      to_day_of_week,
      to_hhmm,
      tick_turn_counter,
    },
  ) => {
    const { world } = await resolveOwned(ctx, session_token, world_slug);
    if (!world.current_branch_id) throw new Error("world has no branch");
    const branch = await ctx.db.get(world.current_branch_id);
    if (!branch) throw new Error("branch missing");
    const time = (branch.state as any)?.time;
    if (!time) throw new Error("branch has no time state");

    let minutes: number;
    if (typeof delta_minutes === "number") {
      minutes = Math.round(delta_minutes);
    } else if (to_day_of_week && to_hhmm) {
      minutes = computeDeltaMinutes(time, to_day_of_week, to_hhmm);
    } else {
      throw new Error(
        "fastForwardClock: provide delta_minutes OR (to_day_of_week + to_hhmm)",
      );
    }
    if (minutes < 0) throw new Error("cannot rewind time");

    // Advance using the existing helper. Ticks = ceil(minutes / tick_minutes),
    // dilation = 1. For fine-grained delta, override tick_minutes temporarily.
    const tmpStart = { ...time, tick_minutes: 1 };
    const next = advanceWorldTime(tmpStart, minutes, 1);
    // Restore the real tick_minutes.
    next.tick_minutes = time.tick_minutes;

    const newState: Record<string, any> = {
      ...(branch.state as any),
      time: next,
    };
    if (tick_turn_counter) {
      newState.turn = ((branch.state as any)?.turn ?? 0) + 1;
    }
    await ctx.db.patch(branch._id, { state: newState });
    return { time: next, minutes_added: minutes };
  },
});

function computeDeltaMinutes(
  cur: { iso: string },
  targetDow: string,
  targetHhmm: string,
): number {
  const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const targetIdx = DOW.indexOf(targetDow.toLowerCase());
  if (targetIdx < 0) throw new Error(`unknown day_of_week: ${targetDow}`);
  const m = /^(\d{1,2}):(\d{2})$/.exec(targetHhmm);
  if (!m) throw new Error(`bad hhmm: ${targetHhmm}`);
  const th = parseInt(m[1], 10);
  const tm = parseInt(m[2], 10);
  // Work at minute precision. The clock display truncates seconds, so
  // the "current time" the user sees is hh:mm — delta should land at
  // the target's exact hh:mm, not be off by ceil/floor of stored secs.
  const curDate = new Date(cur.iso);
  curDate.setUTCSeconds(0, 0);
  const curDowIdx = curDate.getUTCDay();
  let daysAhead = (targetIdx - curDowIdx + 7) % 7;
  const target = new Date(curDate);
  target.setUTCDate(curDate.getUTCDate() + daysAhead);
  target.setUTCHours(th, tm, 0, 0);
  if (target.getTime() <= curDate.getTime()) {
    target.setUTCDate(target.getUTCDate() + 7);
  }
  return Math.round((target.getTime() - curDate.getTime()) / 60000);
}

/** Directly mutate character state. Owner-only. Dotted path, JSON value. */
export const setCharacterState = mutation({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    path: v.string(),
    value_json: v.string(),
  },
  handler: async (ctx, { session_token, world_slug, path, value_json }) => {
    const { world, user_id } = await resolveOwned(
      ctx,
      session_token,
      world_slug,
    );
    const character = await myCharacter(ctx, world._id, user_id);
    if (!character) throw new Error("no character for this user in this world");
    let value: unknown;
    try {
      value = JSON.parse(value_json);
    } catch (e: any) {
      throw new Error(`value_json not parseable: ${e?.message ?? e}`);
    }
    const state = { ...(character.state ?? {}) };
    setDeep(state, path, value);
    await ctx.db.patch(character._id, { state, updated_at: Date.now() });
    return { path, value };
  },
});

function setDeep(obj: any, path: string, value: unknown) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (typeof cur[p] !== "object" || cur[p] === null) cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

/** Teleport the caller's character to a location slug. Owner-only. */
export const teleportCharacter = mutation({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    loc_slug: v.string(),
  },
  handler: async (ctx, { session_token, world_slug, loc_slug }) => {
    const { world, user_id } = await resolveOwned(
      ctx,
      session_token,
      world_slug,
    );
    if (!world.current_branch_id) throw new Error("world has no branch");
    const character = await myCharacter(ctx, world._id, user_id);
    if (!character) throw new Error("no character");
    const entity = (await ctx.db
      .query("entities")
      .withIndex("by_branch_type_slug", (q: any) =>
        q
          .eq("branch_id", world.current_branch_id!)
          .eq("type", "location")
          .eq("slug", loc_slug),
      )
      .first()) as Doc<"entities"> | null;
    if (!entity) throw new Error(`location not found: ${loc_slug}`);
    await ctx.db.patch(character._id, {
      current_location_id: entity._id,
      updated_at: Date.now(),
    });
    return { loc_slug: entity.slug, entity_id: entity._id };
  },
});

// --------------------------------------------------------------------
// Fix mutations — member-level. Non-destructive (new artifact_version).

/** Edit prose on a location (or any entity with a `description_template` /
 *  `prose` field). Creates a new artifact_version; never deletes history. */
export const fixEntityField = mutation({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    type: v.string(),
    slug: v.string(),
    field: v.string(),
    new_value_json: v.string(),
    reason: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { session_token, world_slug, type, slug, field, new_value_json, reason },
  ) => {
    const { world, user, user_id } = await resolveMemberBySlug(
      ctx,
      session_token,
      world_slug,
    );
    if (!world.current_branch_id) throw new Error("world has no branch");
    const entity = (await ctx.db
      .query("entities")
      .withIndex("by_branch_type_slug", (q: any) =>
        q
          .eq("branch_id", world.current_branch_id!)
          .eq("type", type)
          .eq("slug", slug),
      )
      .first()) as Doc<"entities"> | null;
    if (!entity) throw new Error(`entity not found: ${type}/${slug}`);
    const allowed = new Set([
      "description_template",
      "prose",
      "name",
      "biome",
      "tags",
      "options",
      "on_enter",
      "description",
      "neighbors",
    ]);
    if (!allowed.has(field)) {
      throw new Error(`field "${field}" not in the fix-allowlist`);
    }
    let newValue: unknown;
    try {
      newValue = JSON.parse(new_value_json);
    } catch (e: any) {
      throw new Error(`new_value_json not parseable: ${e?.message ?? e}`);
    }
    const current = await readPayload<Record<string, unknown>>(ctx, entity);
    const nextPayload = { ...current, [field]: newValue };
    const newHash = await writeJSONBlob(ctx, nextPayload);
    const newVersion = entity.current_version + 1;
    const pseudonym = user.display_name ?? "claude-cli";
    await ctx.db.insert("artifact_versions", {
      world_id: world._id,
      branch_id: world.current_branch_id,
      artifact_entity_id: entity._id,
      version: newVersion,
      blob_hash: newHash,
      content_type: "application/json",
      author_user_id: user_id,
      author_pseudonym: pseudonym,
      edit_kind: `fix:${field}`,
      reason: reason ?? "cli fix",
      created_at: Date.now(),
    });
    await ctx.db.patch(entity._id, {
      current_version: newVersion,
      updated_at: Date.now(),
    });
    return {
      entity_id: entity._id,
      field,
      new_version: newVersion,
      previous_version: entity.current_version,
    };
  },
});

/** Replace an entity's full payload in one shot. Non-destructive —
 *  creates a new artifact_version. Member-level (observer mode fix
 *  cap), with an allowlist on entity types so nobody pushes garbage
 *  into bible/theme without a clearer migration path. */
export const pushEntityPayload = mutation({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    type: v.string(),
    slug: v.string(),
    payload_json: v.string(),
    reason: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { session_token, world_slug, type, slug, payload_json, reason },
  ) => {
    const { world, user, user_id } = await resolveMemberBySlug(
      ctx,
      session_token,
      world_slug,
    );
    if (!world.current_branch_id) throw new Error("world has no branch");
    const allowed = new Set(["location", "biome", "character", "npc", "item"]);
    if (!allowed.has(type))
      throw new Error(`push not allowed for type "${type}" (allowlist: ${[...allowed].join(",")})`);
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(payload_json);
    } catch (e: any) {
      throw new Error(`payload_json not parseable: ${e?.message ?? e}`);
    }
    // Sanitize location payloads at author time — catch malformed
    // options/effects + undeclared state_keys as info-severity bugs.
    if (type === "location") {
      const { payload: sanitized, fixes } = sanitizeLocationPayload(payload);
      if (fixes.length > 0) {
        await logBugs(ctx, fixes, { world_id: world._id, branch_id: world.current_branch_id });
      }
      payload = sanitized as Record<string, unknown>;
    }
    const entity = (await ctx.db
      .query("entities")
      .withIndex("by_branch_type_slug", (q: any) =>
        q
          .eq("branch_id", world.current_branch_id!)
          .eq("type", type)
          .eq("slug", slug),
      )
      .first()) as Doc<"entities"> | null;
    const eraAtCreate = await stampEraOnCreate(ctx, world._id);
    if (!entity) {
      // Create brand-new entity — the push-is-create path. Author as
      // caller. Useful for agents authoring new content into an
      // existing world.
      const now = Date.now();
      const hash = await writeJSONBlob(ctx, payload);
      const pseudonym = user.display_name ?? "claude-cli";
      const id = await ctx.db.insert("entities", {
        world_id: world._id,
        branch_id: world.current_branch_id,
        type,
        slug,
        current_version: 1,
        schema_version: 1,
        author_user_id: user_id,
        author_pseudonym: pseudonym,
        era_first_established: eraAtCreate,
        created_at: now,
        updated_at: now,
      });
      await ctx.db.insert("artifact_versions", {
        world_id: world._id,
        branch_id: world.current_branch_id,
        artifact_entity_id: id,
        version: 1,
        blob_hash: hash,
        content_type: "application/json",
        author_user_id: user_id,
        author_pseudonym: pseudonym,
        edit_kind: "create_via_push",
        reason: reason ?? "cli push create",
        era: eraAtCreate,
        created_at: now,
      });
      return { created: true, entity_id: id, version: 1 };
    }
    const newHash = await writeJSONBlob(ctx, payload);
    const newVersion = entity.current_version + 1;
    const pseudonym = user.display_name ?? "claude-cli";
    await ctx.db.insert("artifact_versions", {
      world_id: world._id,
      branch_id: world.current_branch_id,
      artifact_entity_id: entity._id,
      version: newVersion,
      blob_hash: newHash,
      content_type: "application/json",
      author_user_id: user_id,
      author_pseudonym: pseudonym,
      era: eraAtCreate,
      edit_kind: "replace_via_push",
      reason: reason ?? "cli push",
      created_at: Date.now(),
    });
    await ctx.db.patch(entity._id, {
      current_version: newVersion,
      updated_at: Date.now(),
    });
    return {
      updated: true,
      entity_id: entity._id,
      version: newVersion,
      previous_version: entity.current_version,
    };
  },
});

// --------------------------------------------------------------------
// Utilities

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "world";
}
