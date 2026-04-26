// Flow runtime — step-keyed state machines.
//
// Handlers live in convex/modules/*.ts and are registered below. The
// runtime exposes:
//   startFlow(session_token, world_slug, module, initial_state)
//     → creates a flows row, invokes entry step; action wrapper.
//   stepFlow(session_token, flow_id, input?)
//     → invokes current_step_id's handler; action wrapper.
//   getFlow(session_token, flow_id) — query.
//   listMyFlows(session_token, world_slug) — query.
//
// A step handler receives ModuleCtx with a seeded RNG + ctx.narrate()
// that calls Sonnet through assembleNarrativePrompt. Persisted state
// is shallow-merged; effects returned by the handler flow through the
// central effects router.

import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
  mutation,
} from "./_generated/server.js";
import { internal, api } from "./_generated/api.js";
import { resolveMember } from "./sessions.js";
import { isFeatureEnabled } from "./flags.js";
import { anthropicCostUsd } from "./cost.js";
import Anthropic from "@anthropic-ai/sdk";
import {
  isTerminal,
  makeOverrideAccessors,
  makeSeededRng,
  type ModuleCtx,
  type ModuleDef,
  type StepInput,
  type StepResult,
} from "@weaver/engine/flows";
import type { Doc, Id } from "./_generated/dataModel.js";

// Module registry. Add new modules here.
import { counterModule } from "./modules/counter.js";
import { dialogueModule } from "./modules/dialogue.js";
import { combatModule } from "./modules/combat.js";

const MODULES: Record<string, ModuleDef> = {
  counter: counterModule,
  dialogue: dialogueModule,
  combat: combatModule,
};

// --------------------------------------------------------------------
// Queries

export const listMyFlows = query({
  args: { session_token: v.string(), world_slug: v.string() },
  handler: async (ctx, { session_token, world_slug }) => {
    const world = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q) => q.eq("slug", world_slug))
      .first();
    if (!world) throw new Error(`world not found: ${world_slug}`);
    const { user_id } = await resolveMember(ctx, session_token, world._id);
    if (!world.current_branch_id) return [];
    const character = await ctx.db
      .query("characters")
      .withIndex("by_world_user", (q) =>
        q.eq("world_id", world._id).eq("user_id", user_id),
      )
      .first();
    if (!character) return [];
    const rows = await ctx.db
      .query("flows")
      .withIndex("by_branch_character", (q: any) =>
        q.eq("branch_id", world.current_branch_id!).eq("character_id", character._id),
      )
      .collect();
    return rows.map((r: any) => ({
      id: r._id,
      module_name: r.module_name,
      current_step_id: r.current_step_id,
      status: r.status,
      stack_depth: r.stack_depth,
      state: r.state_json,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
  },
});

export const getFlow = query({
  args: { session_token: v.string(), flow_id: v.id("flows") },
  handler: async (ctx, { session_token, flow_id }) => {
    const flow = await ctx.db.get(flow_id);
    if (!flow) return null;
    // Soft-404 for non-owners — user_id is under character_id.
    const character = await ctx.db.get(flow.character_id);
    if (!character) return null;
    const { user_id } = await resolveMember(ctx, session_token, flow.world_id);
    if (character.user_id !== user_id) return null;
    return {
      id: flow._id,
      module_name: flow.module_name,
      current_step_id: flow.current_step_id,
      status: flow.status,
      state: flow.state_json,
      character_id: flow.character_id,
    };
  },
});

// --------------------------------------------------------------------
// Start

/** Create a new flow and run its entry step. Returns the step result
 *  + flow_id so the caller can address it for subsequent stepFlow calls. */
export const startFlow = action({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    module: v.string(),
    initial_state: v.optional(v.any()),
  },
  handler: async (
    ctx,
    { session_token, world_slug, module: module_name, initial_state },
  ): Promise<StepRunReturn> => {
    const mod = MODULES[module_name];
    if (!mod) throw new Error(`unknown module: ${module_name}`);
    const info = await ctx.runQuery(internal.flows.startFlowContext, {
      session_token,
      world_slug,
    });
    // Gate behind flag.flows.
    if (!info.flow_flag_on) throw new Error("flag.flows is off for this world");
    const { flow_id } = await ctx.runMutation(internal.flows.createFlowRow, {
      world_id: info.world_id,
      branch_id: info.branch_id,
      character_id: info.character_id,
      module_name,
      initial_state: initial_state ?? {},
      entry_step: mod.entry ?? "open",
    });
    // Run the entry step immediately.
    return await runStep(ctx, flow_id, undefined, mod);
  },
});

/** Start a flow from an option-effect (applyOption → pending → scheduler).
 *  Skips the session-token auth path since the caller already resolved the
 *  character; flag-gate is also already applied upstream in the effect
 *  dispatcher. Silently drops unknown modules (logs a warning). */
export const startFlowFromEffect = internalAction({
  args: {
    world_id: v.id("worlds"),
    branch_id: v.id("branches"),
    character_id: v.id("characters"),
    module: v.string(),
    initial_state: v.any(),
  },
  handler: async (
    ctx,
    { world_id, branch_id, character_id, module: module_name, initial_state },
  ): Promise<void> => {
    const mod = MODULES[module_name];
    if (!mod) {
      console.warn(
        `startFlowFromEffect: unknown module "${module_name}" — dropping`,
      );
      return;
    }
    const { flow_id } = await ctx.runMutation(internal.flows.createFlowRow, {
      world_id,
      branch_id,
      character_id,
      module_name,
      initial_state: initial_state ?? {},
      entry_step: mod.entry ?? "open",
    });
    await runStep(ctx, flow_id, undefined, mod);
  },
});

/** Advance an existing flow. */
export const stepFlow = action({
  args: {
    session_token: v.string(),
    flow_id: v.id("flows"),
    input: v.optional(v.any()),
  },
  handler: async (
    ctx,
    { session_token, flow_id, input },
  ): Promise<StepRunReturn> => {
    const flow = await ctx.runQuery(internal.flows.readFlow, {
      session_token,
      flow_id,
    });
    if (!flow) throw new Error("flow not found or not owned by you");
    if (flow.status === "completed")
      throw new Error(`flow already completed`);
    const mod = MODULES[flow.module_name];
    if (!mod) throw new Error(`unknown module: ${flow.module_name}`);
    return await runStep(ctx, flow_id, input, mod);
  },
});

// Shared step runner used by both start + step.
type StepRunReturn = {
  flow_id: Id<"flows">;
  module_name: string;
  status: "running" | "waiting" | "completed";
  current_step_id: string | null;
  says: string[];
  ui: StepResult["ui"] | null;
  state: unknown;
};

async function runStep(
  ctx: any,
  flow_id: Id<"flows">,
  input: StepInput | undefined,
  mod: ModuleDef,
): Promise<StepRunReturn> {
  // Load flow state + character via query.
  const flow = await ctx.runQuery(internal.flows.readFlowForRun, { flow_id });
  if (!flow) throw new Error("flow disappeared mid-step");
  const stepId = flow.current_step_id ?? mod.entry ?? "open";
  const handler = mod.steps[stepId];
  if (isTerminal(handler)) {
    // Already terminal. Mark the row and exit.
    await ctx.runMutation(internal.flows.markFlowCompleted, { flow_id });
    return {
      flow_id,
      module_name: mod.name,
      status: "completed",
      current_step_id: null,
      says: [],
      ui: null,
      state: flow.state_json,
    };
  }

  // Build the ModuleCtx for this step invocation.
  const rngSeed = `${flow_id}|${stepId}|${flow.updated_at ?? flow.created_at}`;
  const rng = makeSeededRng(rngSeed);
  const says: string[] = [];

  // Per-world module overrides — only load when the flag is on so we
  // don't add a DB round-trip per step for worlds that haven't opted
  // in. When off, ctx.tune / ctx.template fall through to module
  // defaults via mergeOverrides({}).
  let overrides: Record<string, unknown> = {};
  const overridesFlagOn = await isFeatureEnabled(ctx, "flag.module_overrides", {
    world_id: flow.world_id,
  });
  if (overridesFlagOn) {
    const resolved = await ctx.runQuery(internal.flows.activeOverridesForRun, {
      world_id: flow.world_id,
      module_name: mod.name,
    });
    overrides = (resolved?.overrides as Record<string, unknown>) ?? {};
  }
  const { tune, template } = makeOverrideAccessors(mod, overrides);

  const modCtx: ModuleCtx = {
    rng,
    rng_int: (lo, hi) => Math.floor(rng() * (hi - lo + 1)) + lo,
    dice: (n, sides) => {
      let s = 0;
      for (let i = 0; i < n; i++) s += Math.floor(rng() * sides) + 1;
      return s;
    },
    pick: (items) => items[Math.floor(rng() * items.length)],
    turn: flow.turn ?? 0,
    now: Date.now(),
    state: flow.state_json ?? {},
    character: {
      id: flow.character_id,
      name: flow.character_name,
      pseudonym: flow.character_pseudonym,
      state: flow.character_state ?? {},
    },
    speaker_slug: (flow.state_json as any)?.speaker_slug,
    narrate: async (prompt: string, extra?: any) => {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      // Look up speaker entity id if slug provided.
      let speaker_entity_id: Id<"entities"> | undefined;
      const slug = extra?.speaker ?? (flow.state_json as any)?.speaker_slug;
      if (slug) {
        speaker_entity_id = await ctx.runQuery(internal.flows.resolveSpeaker, {
          branch_id: flow.branch_id,
          slug,
        });
      }
      const assembled = await ctx.runQuery(internal.narrative.buildPrompt, {
        world_id: flow.world_id,
        purpose: "dialogue",
        character_id: flow.character_id,
        speaker_entity_id,
      });
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: extra?.max_tokens ?? 256,
        temperature: 0.9,
        system: assembled.system,
        messages: [
          {
            role: "user",
            content: `${assembled.user ?? ""}\n\n${prompt}`,
          },
        ],
      });
      await ctx.runMutation(internal.cost.logCostUsd, {
        world_id: flow.world_id,
        branch_id: flow.branch_id,
        kind: `anthropic:sonnet:flow:${flow.module_name}`,
        cost_usd: anthropicCostUsd("claude-sonnet-4-6", response.usage as any),
        reason: `flow ${flow.module_name} narrate`,
      });
      const text = response.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("")
        .trim();
      // Auto-write NPC memory if the speaker is an NPC/character entity.
      if (speaker_entity_id) {
        await ctx.runMutation(internal.effects.writeNpcMemoryFromAction, {
          world_id: flow.world_id,
          branch_id: flow.branch_id,
          npc_entity_id: speaker_entity_id,
          about_character_id: flow.character_id,
          event_type: "dialogue_turn",
          summary: text.slice(0, 120),
          salience: "medium",
        });
      }
      // Append-only events log — what the player just read. The
      // tiered context assembler reads from this for future prompts.
      await ctx.runMutation(internal.events.writeEvent, {
        world_id: flow.world_id,
        branch_id: flow.branch_id,
        character_id: flow.character_id,
        npc_entity_id: speaker_entity_id,
        kind: speaker_entity_id ? "dialogue" : "narrate",
        body: text,
        salience: "medium",
      });
      return text;
    },
    say: (text: string) => {
      says.push(text);
    },
    tune,
    template,
  };

  const result: StepResult = await (handler as any)(
    modCtx,
    flow.state_json ?? {},
    input,
  );

  // Persist the step's outputs.
  const terminal = result.next === "done" || result.next === "__done__";
  const mergedState =
    result.state === undefined
      ? flow.state_json
      : { ...(flow.state_json ?? {}), ...(result.state as any) };
  const allSays = [...says, ...(result.says ?? [])];
  const status: "running" | "waiting" | "completed" = terminal
    ? "completed"
    : result.ui
      ? "waiting"
      : "running";
  await ctx.runMutation(internal.flows.advanceFlowRow, {
    flow_id,
    current_step_id: terminal ? null : result.next,
    state_json: mergedState,
    status,
    append_says: allSays,
    effect_kinds: (result.effects ?? []).map((e: any) => String(e?.kind ?? "unknown")),
  });
  // Route step-returned effects through the central effect router —
  // so combat damage actually hits character.hp, give_item populates
  // inventory, advance_time pushes the world clock, etc.
  if (result.effects && result.effects.length > 0) {
    await ctx.runMutation(internal.effects.applyFlowEffects, {
      flow_id,
      effects: result.effects,
    });
  }

  return {
    flow_id,
    module_name: mod.name,
    status,
    current_step_id: terminal ? null : result.next,
    says: allSays,
    ui: result.ui ?? null,
    state: mergedState,
  };
}

// --------------------------------------------------------------------
// Internal helpers

export const startFlowContext = internalQuery({
  args: { session_token: v.string(), world_slug: v.string() },
  handler: async (ctx, { session_token, world_slug }) => {
    const world = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q: any) => q.eq("slug", world_slug))
      .first();
    if (!world) throw new Error(`world not found: ${world_slug}`);
    const { user_id } = await resolveMember(ctx as any, session_token, world._id);
    if (!world.current_branch_id) throw new Error("world has no branch");
    const character = await ctx.db
      .query("characters")
      .withIndex("by_world_user", (q: any) =>
        q.eq("world_id", world._id).eq("user_id", user_id),
      )
      .first();
    if (!character) throw new Error("no character in this world for you");
    const flow_flag_on = await isFeatureEnabled(ctx, "flag.flows", {
      world_id: world._id,
      user_id,
    });
    return {
      world_id: world._id,
      branch_id: world.current_branch_id,
      character_id: character._id,
      flow_flag_on,
    };
  },
});

export const readFlow = internalQuery({
  args: { session_token: v.string(), flow_id: v.id("flows") },
  handler: async (ctx, { session_token, flow_id }) => {
    const flow = await ctx.db.get(flow_id);
    if (!flow) return null;
    const character = await ctx.db.get(flow.character_id);
    if (!character) return null;
    const { user_id } = await resolveMember(ctx as any, session_token, flow.world_id);
    if (character.user_id !== user_id) return null;
    return flow;
  },
});

export const readFlowForRun = internalQuery({
  args: { flow_id: v.id("flows") },
  handler: async (ctx, { flow_id }) => {
    const flow = await ctx.db.get(flow_id);
    if (!flow) return null;
    const character = await ctx.db.get(flow.character_id);
    const branch = await ctx.db.get(flow.branch_id);
    return {
      ...flow,
      character_name: character?.name ?? "traveler",
      character_pseudonym: character?.pseudonym ?? "traveler",
      character_state: character?.state ?? {},
      turn: (branch?.state as any)?.turn ?? 0,
    };
  },
});

/** Look up active module overrides for (world, module). Returns an
 *  empty object when no row exists. The caller should have already
 *  checked flag.module_overrides — we don't gate here because this
 *  helper is also callable from admin flows that need to display the
 *  current state regardless of whether the flag is live. */
export const activeOverridesForRun = internalQuery({
  args: {
    world_id: v.id("worlds"),
    module_name: v.string(),
  },
  handler: async (ctx, { world_id, module_name }) => {
    const row = await ctx.db
      .query("module_overrides")
      .withIndex("by_world_module", (q: any) =>
        q.eq("world_id", world_id).eq("module_name", module_name),
      )
      .first();
    return {
      overrides: (row?.overrides_json as Record<string, unknown>) ?? {},
      version: row?.version ?? 0,
    };
  },
});

export const resolveSpeaker = internalQuery({
  args: { branch_id: v.id("branches"), slug: v.string() },
  handler: async (ctx, { branch_id, slug }) => {
    for (const t of ["npc", "character"] as const) {
      const e = await ctx.db
        .query("entities")
        .withIndex("by_branch_type_slug", (q: any) =>
          q.eq("branch_id", branch_id).eq("type", t).eq("slug", slug),
        )
        .first();
      if (e) return e._id;
    }
    return null;
  },
});

export const createFlowRow = internalMutation({
  args: {
    world_id: v.id("worlds"),
    branch_id: v.id("branches"),
    character_id: v.id("characters"),
    module_name: v.string(),
    initial_state: v.any(),
    entry_step: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const flow_id = await ctx.db.insert("flows", {
      world_id: args.world_id,
      branch_id: args.branch_id,
      character_id: args.character_id,
      module_name: args.module_name,
      schema_version: 1,
      current_step_id: args.entry_step,
      state_json: args.initial_state,
      status: "running",
      stack_depth: 0,
      throwaway: false,
      created_at: now,
      updated_at: now,
    });
    return { flow_id };
  },
});

export const advanceFlowRow = internalMutation({
  args: {
    flow_id: v.id("flows"),
    current_step_id: v.union(v.string(), v.null()),
    state_json: v.any(),
    status: v.union(
      v.literal("running"),
      v.literal("waiting"),
      v.literal("completed"),
      v.literal("escaped"),
    ),
    append_says: v.array(v.string()),
    effect_kinds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const priorFlow = await ctx.db.get(args.flow_id);
    await ctx.db.patch(args.flow_id, {
      current_step_id: args.current_step_id ?? undefined,
      state_json: args.state_json,
      status: args.status,
      updated_at: Date.now(),
    });
    // Append a flow_transitions row capturing the step advance. Gives
    // a replayable trail when a flow misbehaves without turning every
    // hiccup into a runtime_bug.
    if (priorFlow) {
      const branch = await ctx.db.get(priorFlow.branch_id);
      await ctx.db.insert("flow_transitions", {
        world_id: priorFlow.world_id,
        branch_id: priorFlow.branch_id,
        flow_id: args.flow_id,
        turn: ((branch?.state as any)?.turn ?? 0) as number,
        from_step_id: priorFlow.current_step_id ?? null,
        to_step_id: args.current_step_id,
        status: args.status,
        says_count: args.append_says.length,
        effect_kinds: args.effect_kinds ?? [],
        at: Date.now(),
      });
    }
    // Also append flow says onto the character's pending_says so the
    // next location render shows them.
    if (args.append_says.length > 0) {
      const flow = await ctx.db.get(args.flow_id);
      if (flow) {
        const c = await ctx.db.get(flow.character_id);
        if (c) {
          const state = { ...(c.state ?? {}) };
          state.pending_says = [
            ...((state.pending_says as string[]) ?? []),
            ...args.append_says,
          ];
          await ctx.db.patch(flow.character_id, { state, updated_at: Date.now() });
        }
      }
    }
  },
});

/** Weekly GC — prune flow_transitions older than 14 days. Kept short
 *  because these rows are diagnostic-only; runtime code doesn't read
 *  them. Sweep horizon mirrors runtime_bugs (warn/error) policy. */
export const gcFlowTransitions = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const rows = await ctx.db.query("flow_transitions").collect();
    let deleted = 0;
    for (const r of rows) {
      if (r.at < cutoff) {
        await ctx.db.delete(r._id);
        deleted++;
      }
    }
    return { deleted, kept: rows.length - deleted };
  },
});

/** List transitions for a flow — CLI-surface for debugging. */
export const listFlowTransitions = query({
  args: {
    session_token: v.string(),
    flow_id: v.id("flows"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { session_token, flow_id, limit }) => {
    const flow = await ctx.db.get(flow_id);
    if (!flow) return [];
    // Soft-404 for non-owners.
    const character = await ctx.db.get(flow.character_id);
    if (!character) return [];
    const { user_id } = await resolveMember(ctx as any, session_token, flow.world_id);
    if (character.user_id !== user_id) return [];
    const rows = await ctx.db
      .query("flow_transitions")
      .withIndex("by_flow_time", (q: any) => q.eq("flow_id", flow_id))
      .collect();
    rows.sort((a: any, b: any) => a.at - b.at);
    return rows.slice(-(limit ?? 100)).map((r: any) => ({
      turn: r.turn,
      from: r.from_step_id,
      to: r.to_step_id,
      status: r.status,
      says: r.says_count,
      effects: r.effect_kinds,
      at: r.at,
    }));
  },
});

export const markFlowCompleted = internalMutation({
  args: { flow_id: v.id("flows") },
  handler: async (ctx, { flow_id }) => {
    await ctx.db.patch(flow_id, {
      status: "completed",
      updated_at: Date.now(),
    });
  },
});
