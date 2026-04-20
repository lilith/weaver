// Location reads + applyOption mutation. Every call is world-scoped; the
// client addresses by slug; the server resolves entity ids from the
// caller's branch.

import { query, mutation } from "./_generated/server.js";
import { v } from "convex/values";
import { readJSONBlob, writeJSONBlob } from "./blobs.js";
import { resolveMember } from "./sessions.js";
import { recordJourneyTransition } from "./journeys.js";
import { advanceWorldTime, evalCondition, type ExprBug } from "@weaver/engine/clock";
import type { Effect } from "@weaver/engine/effects";
import {
  applyEffects,
  resolveEffectFlags,
  type EffectExecCtx,
} from "./effects.js";
import { logBugs } from "./diagnostics.js";
import { sanitizeCharacterState } from "@weaver/engine/diagnostics";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";

/** Canonical shape of a location's authored payload. Uses an index
 *  signature for forward-compat with fields the runtime hasn't typed
 *  yet (e.g. rules, chat_thread_id, content_rating overrides). */
export type LocationPayload = {
  slug: string;
  name: string;
  biome: string;
  description_template: string;
  prose?: string;
  tags?: string[];
  safe_anchor?: boolean;
  options: Array<{
    label: string;
    condition?: string;
    target?: string;
    effect?: Array<{ kind: string; [k: string]: unknown }>;
  }>;
  neighbors?: Record<string, string>;
  on_enter?: Array<{ kind: string; [k: string]: unknown }>;
  on_leave?: Array<{ kind: string; [k: string]: unknown }>;
  state_keys?: string[];
  author_pseudonym?: string;
  [k: string]: unknown;
};

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

/** Load a biome's rules block by slug. Returns null if the biome entity
 *  isn't found or has no rules (that's the common case for imported
 *  worlds whose biomes haven't been upgraded yet). */
async function loadBiomeRules(
  ctx: any,
  branch_id: Id<"branches">,
  slug: string,
): Promise<{
  time_dilation?: number;
  on_enter_biome?: any[];
  on_leave_biome?: any[];
  on_turn_in_biome?: any[];
  ambient_effects?: any[];
  spawn_tables?: Record<string, string[]>;
} | null> {
  const biome = await ctx.db
    .query("entities")
    .withIndex("by_branch_type_slug", (q: any) =>
      q.eq("branch_id", branch_id).eq("type", "biome").eq("slug", slug),
    )
    .first();
  if (!biome) return null;
  try {
    const payload = await readAuthoredPayload<any>(ctx, biome);
    return (payload?.rules ?? null) as any;
  } catch {
    return null;
  }
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
    const payload = await readAuthoredPayload<LocationPayload>(ctx, entity);

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
    const runtimeBugs: ExprBug[] = [];
    if ((option as any).condition) {
      const scope = {
        world: worldState,
        character: (character.state ?? {}) as Record<string, unknown>,
        this:
          ((character.state as any)?.this?.[payload.slug] as Record<string, unknown>) ?? {},
        location: {},
      };
      if (!evalCondition((option as any).condition as string, scope, undefined, runtimeBugs)) {
        // Parse error on the condition: log the bug + refuse softly
        // (don't throw, so the logBugs insert survives Convex's
        // transactional rollback). Well-formed-but-false conditions
        // still throw — that's the "option legitimately unavailable"
        // signal callers expect.
        if (runtimeBugs.length > 0) {
          await logBugs(ctx, runtimeBugs, {
            world_id,
            branch_id,
            character_id: character._id,
          });
          return {
            says: ["(authoring error on this option — logged to runtime_bugs)"],
            new_location_slug: null,
            needs_expansion: null,
            closed_journey_id: null,
            prefetched_hit: false,
          };
        }
        throw new Error("this option is not available right now");
      }
    }

    const state = { ...(character.state ?? {}) };
    state.this ??= {};
    state.this[payload.slug] ??= {};
    const thisScope = state.this[payload.slug] as Record<string, unknown>;
    const flags = await resolveEffectFlags(ctx, world_id, user_id);
    const exec: EffectExecCtx = {
      world_id,
      branch_id,
      user_id,
      character_id: character._id,
      state,
      thisScope,
      location_slug: payload.slug,
      says: [],
      gotoSlug: option.target ?? null,
      extra_minutes: 0,
      pending: [],
      flags,
      depth: 0,
      bugs: runtimeBugs,
    };
    // Also flush any pending_says from prior async narrate effects. These
    // were stamped onto character.state.pending_says by effects.runNarrate.
    const pending = (state.pending_says as string[] | undefined) ?? [];
    if (pending.length > 0) {
      exec.says.push(...pending);
      state.pending_says = [];
    }
    await applyEffects(ctx, (option.effect ?? []) as Effect[], exec);
    const says = exec.says;
    const gotoSlug = exec.gotoSlug;

    let newLocationSlug: string | null = null;
    let newLocationEntity: Doc<"entities"> | null = null;
    let needsExpansion: { hint: string } | null = null;
    let prefetchedHit = false;
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
        // Unresolved target — check if a prefetched draft is waiting for this
        // exact (parent, option label). If so, use it. Otherwise signal
        // the client to chain into expansion.
        const prefetched = await ctx.db
          .query("entities")
          .withIndex("by_prefetch_source", (q) =>
            q
              .eq("branch_id", branch_id)
              .eq("prefetched_from_entity_id", entity._id)
              .eq("prefetched_from_option_label", option.label),
          )
          .first();
        if (prefetched) {
          newLocationEntity = prefetched as Doc<"entities">;
          newLocationSlug = prefetched.slug;
          prefetchedHit = true;
        } else {
          needsExpansion = { hint: option.label };
        }
      }
    }

    let closedJourneyId: Id<"journeys"> | null = null;
    if (newLocationEntity) {
      // First-visit stamp: if this is a draft that nobody has landed on
      // yet (e.g., a prefetched draft just got picked), record the visit
      // time. Canonical entities also get it on first visit — drafts
      // cross the prefetch → visited threshold here.
      if (newLocationEntity.visited_at == null) {
        await ctx.db.patch(newLocationEntity._id, { visited_at: Date.now() });
      }
      const j = await recordJourneyTransition(ctx, {
        world_id,
        branch_id,
        user_id,
        character_id: character._id,
        new_location: newLocationEntity,
      });
      closedJourneyId = j.closed_journey_id;
    }

    // --- Location on_leave (current location) — spec 02. Always on;
    //     authored effects run regardless of flag.biome_rules. Only
    //     fires when we're ACTUALLY leaving (new location resolved). ---
    const onLeave = Array.isArray((payload as any).on_leave)
      ? ((payload as any).on_leave as any[])
      : null;
    if (onLeave && onLeave.length > 0 && newLocationEntity) {
      await applyEffects(ctx, onLeave, exec);
    }

    // --- Biome rules (Ask 1, spec 21, flag.biome_rules) ---
    // Must run BEFORE the character.state patch so hook-driven mutations
    // to state + thisScope land in the same patch as option effects.
    // Fire lifecycle hooks on biome transitions + each-turn hooks +
    // ambient effects. Dilation from the effective (new if changed else
    // current) biome drives clock advance.
    let dilation = 1;
    if (flags.biome_rules) {
      const originBiome = (payload as any).biome as string | undefined;
      let effectiveBiomeSlug = originBiome;
      let biomeChanged = false;
      if (newLocationEntity) {
        try {
          const newPayload = await readAuthoredPayload<any>(ctx, newLocationEntity);
          const newBiome = newPayload?.biome as string | undefined;
          if (newBiome && newBiome !== originBiome) {
            biomeChanged = true;
            // on_leave_biome (origin)
            if (originBiome) {
              const originRules = await loadBiomeRules(ctx, branch_id, originBiome);
              if (originRules?.on_leave_biome)
                await applyEffects(ctx, originRules.on_leave_biome, exec);
            }
            // on_enter_biome (new)
            const newRules = await loadBiomeRules(ctx, branch_id, newBiome);
            if (newRules?.on_enter_biome)
              await applyEffects(ctx, newRules.on_enter_biome, exec);
            effectiveBiomeSlug = newBiome;
          }
        } catch {
          /* unreadable new payload — skip biome hooks */
        }
      }
      // on_turn_in_biome + ambient on the effective biome
      if (effectiveBiomeSlug) {
        const rules = await loadBiomeRules(ctx, branch_id, effectiveBiomeSlug);
        if (rules) {
          if (rules.on_turn_in_biome)
            await applyEffects(ctx, rules.on_turn_in_biome, exec);
          if (Array.isArray(rules.ambient_effects)) {
            const nextTurn = ((branchRow?.state as any)?.turn ?? 0) + 1;
            // Seed a per-turn RNG so same turn + same world = same roll;
            // makes ambient firing deterministic across re-reads / tests.
            const rngSeed = `ambient|${branch_id}|${nextTurn}`;
            // Small deterministic RNG (mulberry32-ish; identical shape to
            // flows.makeSeededRng but inlined to avoid a cross-package import).
            let h = 1779033703 ^ rngSeed.length;
            for (let i = 0; i < rngSeed.length; i++) {
              h = Math.imul(h ^ rngSeed.charCodeAt(i), 3432918353);
              h = (h << 13) | (h >>> 19);
            }
            let rngA = h >>> 0;
            const rng = () => {
              rngA |= 0;
              rngA = (rngA + 0x6d2b79f5) | 0;
              let t = Math.imul(rngA ^ (rngA >>> 15), 1 | rngA);
              t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
              return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
            };
            for (const amb of rules.ambient_effects) {
              const every = Number((amb as any).every_n_turns ?? 0);
              if (every <= 0 || nextTurn % every !== 0) continue;
              // Per-effect chance gate (UX-06). `chance` omitted =
              // deterministic 1.0 — backwards-compatible.
              const chance = (amb as any).chance;
              if (chance !== undefined && chance !== null) {
                if (rng() >= Number(chance)) continue;
              }
              await applyEffects(ctx, [amb as any], exec);
            }
          }
          if (typeof rules.time_dilation === "number" && rules.time_dilation > 0) {
            dilation = rules.time_dilation;
          }

          // noise_decay — per-turn decrement of `this.<biome>.noise_level`.
          // Numeric (0-1) preferred; authors can `inc` it via effects
          // (e.g. combat += 0.3) and the decay walks it back down so
          // spawn tables don't stick on the loudest bucket forever.
          const decay = Number((rules as any).noise_decay ?? 0);
          if (decay > 0) {
            state.this ??= {};
            (state.this as any)[effectiveBiomeSlug!] ??= {};
            const bscope = (state.this as any)[effectiveBiomeSlug!];
            const cur = Number(bscope.noise_level ?? 0);
            if (Number.isFinite(cur) && cur > 0) {
              bscope.noise_level = Math.max(0, cur - decay);
            }
          }

          // spawn_tables — pick from the noise bucket matching
          // this.<biome>.noise_level (if tracked) or default to
          // low_noise. Numeric noise thresholds: <0.33 low, <0.66 mid,
          // else high. Strings stay literal for backward-compat.
          // Roll a seeded dice against spawn_chance; tier-2 combat
          // hostile flags wire in below.
          if (rules.spawn_tables && typeof rules.spawn_tables === "object") {
            const rawNoise =
              (state.this as any)?.[effectiveBiomeSlug]?.noise_level ?? "low";
            const noise =
              typeof rawNoise === "number"
                ? rawNoise < 0.33
                  ? "low"
                  : rawNoise < 0.66
                    ? "mid"
                    : "high"
                : String(rawNoise);
            const bucket =
              (rules.spawn_tables as any)[`${noise}_noise`] ??
              (rules.spawn_tables as any).low_noise ??
              [];
            if (Array.isArray(bucket) && bucket.length > 0) {
              const nextTurn2 = ((branchRow?.state as any)?.turn ?? 0) + 1;
              const spawnSeed = `spawn|${branch_id}|${nextTurn2}`;
              let h2 = 1779033703 ^ spawnSeed.length;
              for (let i = 0; i < spawnSeed.length; i++) {
                h2 = Math.imul(h2 ^ spawnSeed.charCodeAt(i), 3432918353);
                h2 = (h2 << 13) | (h2 >>> 19);
              }
              let rA = h2 >>> 0;
              const srng = () => {
                rA |= 0;
                rA = (rA + 0x6d2b79f5) | 0;
                let t = Math.imul(rA ^ (rA >>> 15), 1 | rA);
                t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
                return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
              };
              const chance = Number(
                (rules as any).spawn_chance_per_turn ?? 0.1,
              );
              if (srng() < chance) {
                const pick = bucket[Math.floor(srng() * bucket.length)];
                if (pick && pick !== "none") {
                  // If the picked slug resolves to an NPC with a
                  // combat_profile, flag it as a hostile nearby so
                  // authored "Square up to the X" options light up.
                  // Otherwise fall back to atmospheric flavor.
                  let isHostile = false;
                  const npcEntity = await ctx.db
                    .query("entities")
                    .withIndex("by_branch_type_slug", (q: any) =>
                      q.eq("branch_id", branch_id).eq("type", "npc").eq("slug", pick),
                    )
                    .first();
                  if (npcEntity) {
                    try {
                      const npcPayload = await readAuthoredPayload<any>(
                        ctx,
                        npcEntity,
                      );
                      if (
                        npcPayload?.combat_profile &&
                        typeof npcPayload.combat_profile === "object"
                      ) {
                        isHostile = true;
                        // Flag the hostile on the current location's
                        // this-scope. Authored options gate with
                        // `condition: this.hostile_nearby`. Leaving
                        // the location clears the flag (new this scope).
                        const thisKey = newLocationEntity?.slug ?? payload.slug;
                        state.this ??= {};
                        (state.this as any)[thisKey] ??= {};
                        (state.this as any)[thisKey].hostile_nearby = pick;
                        exec.says.push(
                          `(${npcPayload.name ?? pick} appears and looks... confrontational)`,
                        );
                      }
                    } catch {
                      /* unreadable npc payload — fall through */
                    }
                  }
                  if (!isHostile) {
                    exec.says.push(`(a ${pick} passes nearby)`);
                  }
                }
              }
            }
          }
        }
      }
    }

    // --- Location on_enter (new location) — spec 02. Pivot exec.thisScope
    //     to the new location's `this` bucket so `this.visited++` lands
    //     under the right key (not the origin's). ---
    if (newLocationEntity) {
      try {
        const newPayload = await readAuthoredPayload<any>(ctx, newLocationEntity);
        const onEnter = Array.isArray(newPayload?.on_enter)
          ? (newPayload.on_enter as any[])
          : null;
        if (onEnter && onEnter.length > 0) {
          const newLocSlug = newLocationEntity.slug;
          state.this ??= {};
          (state.this as any)[newLocSlug] ??= {};
          const prevScope = exec.thisScope;
          const prevSlug = exec.location_slug;
          exec.thisScope = (state.this as any)[newLocSlug];
          exec.location_slug = newLocSlug;
          await applyEffects(ctx, onEnter, exec);
          // Restore for any downstream code that might read these;
          // in practice nothing does after this point.
          exec.thisScope = prevScope;
          exec.location_slug = prevSlug;
        }
      } catch {
        /* can't read new payload — skip on_enter */
      }
    }

    // Sanitize the character state before we compute clock + newday so
    // both mutations can fold into a single character patch below.
    const { state: sanitized, fixes } = sanitizeCharacterState(state);
    // Fold sanitize fixes + expression/effect-runtime bugs into the
    // same rate-limited logBugs call.
    const allBugs = [...fixes, ...runtimeBugs];
    if (allBugs.length > 0) {
      await logBugs(ctx, allBugs, {
        world_id,
        branch_id,
        character_id: character._id,
      });
    }

    // Compute the new clock (if the world has a clock at all) so we
    // can apply the newday hook into the same character patch.
    let nextClock: any = null;
    let newDays = 0;
    if (branchRow?.state?.time) {
      const prev = branchRow.state.time as any;
      nextClock = advanceWorldTime(prev, 1, dilation);
      if (exec.extra_minutes > 0) {
        const tmp = { ...nextClock, tick_minutes: 1 };
        nextClock = advanceWorldTime(tmp, exec.extra_minutes, 1);
        nextClock.tick_minutes = prev.tick_minutes;
      }
      newDays = (nextClock.day_counter ?? 0) - (prev.day_counter ?? 0);
    }

    // New-day hook — day_counter rolled forward. Clear ephemeral
    // spawn flags across every this-scope so spawn_tables don't
    // persist overnight at locations the player never revisited;
    // emit a dawn say. Keep minimal — any deeper "new-day cycle"
    // (Opus morning chronicle, NPC memory decay, authored
    // on_newday effects) can land in a follow-up.
    if (newDays > 0) {
      const thisMap = (sanitized.this as any) ?? {};
      for (const key of Object.keys(thisMap)) {
        const scope = thisMap[key];
        if (scope && typeof scope === "object" && scope.hostile_nearby !== undefined) {
          delete scope.hostile_nearby;
        }
      }
      const dawnSay =
        newDays === 1
          ? `(dawn rolls in — day ${nextClock.day_counter})`
          : `(${newDays} days pass — day ${nextClock.day_counter})`;
      sanitized.pending_says = [
        ...((sanitized.pending_says as string[]) ?? []),
        dawnSay,
      ];
    }

    await ctx.db.patch(character._id, {
      state: sanitized,
      current_location_id:
        newLocationEntity?._id ?? character.current_location_id,
      updated_at: Date.now(),
    });

    if (nextClock) {
      await ctx.db.patch(branch_id, {
        state: {
          ...branchRow!.state,
          time: nextClock,
          turn: ((branchRow!.state as any)?.turn ?? 0) + 1,
        },
      });
    }

    // Schedule pending async effects (narrate, flow_start). These run
    // after the mutation commits; their text lands on the next look.
    for (const p of exec.pending) {
      if (p.kind === "narrate") {
        // Resolve speaker slug → entity id for NPC-memory auto-write.
        let speakerEntityId: Id<"entities"> | undefined;
        if (p.payload.speaker) {
          for (const t of ["npc", "character"] as const) {
            const hit = await ctx.db
              .query("entities")
              .withIndex("by_branch_type_slug", (q: any) =>
                q.eq("branch_id", branch_id).eq("type", t).eq("slug", p.payload.speaker),
              )
              .first();
            if (hit) {
              speakerEntityId = hit._id;
              break;
            }
          }
        }
        await ctx.scheduler.runAfter(0, internal.effects.runNarrate, {
          world_id,
          branch_id,
          character_id: character._id,
          speaker_entity_id: speakerEntityId,
          prompt: p.payload.prompt,
          salience: p.payload.salience,
          memory_event_type: p.payload.memory_event_type,
        });
      }
      if (p.kind === "flow_start") {
        await ctx.scheduler.runAfter(0, internal.flows.startFlowFromEffect, {
          world_id,
          branch_id,
          character_id: character._id,
          module: String(p.payload.module ?? ""),
          initial_state: p.payload.initial_state ?? {},
        });
      }
    }

    return {
      says,
      new_location_slug: newLocationSlug,
      needs_expansion: needsExpansion,
      closed_journey_id: closedJourneyId,
      prefetched_hit: prefetchedHit,
    };
  },
});

// (state mutation helpers moved to convex/effects.ts)

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
