// Effect router — Convex side.
//
// The single dispatcher for every effect kind. Called from applyOption,
// biome hooks, module step handlers, etc. Synchronous effects mutate
// directly; async effects (narrate, flow_start) schedule work on the
// runtime and leave a placeholder in says[].
//
// Flag-gated: effects in the Wave-2 set silently no-op when their flag
// is off, so a location authored with give_item remains playable on a
// world with flag.item_taxonomy=off.

import { v } from "convex/values";
import { internalMutation, internalAction } from "./_generated/server.js";
import { readJSONBlob, writeJSONBlob } from "./blobs.js";
import { advanceWorldTime } from "@weaver/engine/clock";
import {
  inventoryAdd,
  inventoryRemove,
  type Effect,
  type Inventory,
  type InventoryEntry,
} from "@weaver/engine/effects";
import { isFeatureEnabled } from "./flags.js";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";

// --------------------------------------------------------------------
// Execution context — passed through the dispatch chain. Mutated in
// place for simplicity; applyOption reads it back at the end to build
// the return value.

export type EffectExecCtx = {
  world_id: Id<"worlds">;
  branch_id: Id<"branches">;
  user_id: Id<"users">;
  character_id: Id<"characters">;
  // The character's mutable state. Starts as a shallow clone of
  // character.state so applyOption can write it back in one patch.
  state: Record<string, any>;
  // The per-location "this" scope: character.state.this[loc_slug].
  thisScope: Record<string, any>;
  location_slug: string;
  // Collected outputs.
  says: string[];
  // Set when a goto effect fires. applyOption resolves this to an
  // entity after dispatch.
  gotoSlug: string | null;
  // Extra time to add to the clock (e.g. from advance_time effects),
  // on top of the normal 1-tick-per-option.
  extra_minutes: number;
  // Pending async work to schedule after the mutation commits.
  pending: Array<{
    kind: "narrate" | "flow_start";
    payload: any;
  }>;
  // Flag states resolved once at dispatcher entry to save repeated reads.
  flags: {
    item_taxonomy: boolean;
    biome_rules: boolean;
    flows: boolean;
    world_clock: boolean;
  };
};

/** Apply a list of effects in order. Mutates execCtx in place. */
export async function applyEffects(
  ctx: any,
  effects: Effect[] | undefined,
  exec: EffectExecCtx,
): Promise<void> {
  if (!effects || effects.length === 0) return;
  for (const eff of effects) {
    await applyOneEffect(ctx, eff, exec);
  }
}

async function applyOneEffect(
  ctx: any,
  eff: Effect,
  exec: EffectExecCtx,
): Promise<void> {
  switch (eff.kind) {
    case "say":
      exec.says.push(String(eff.text));
      return;
    case "goto":
      exec.gotoSlug = String(eff.target);
      return;
    case "inc":
      applyNumericMutation(exec.state, exec.thisScope, eff.path, (n) => n + eff.by);
      return;
    case "set":
      applyScalarMutation(exec.state, exec.thisScope, eff.path, eff.value);
      return;
    case "heal":
      applyNumericMutation(
        exec.state,
        exec.thisScope,
        "character.hp",
        (n) => n + eff.amount,
      );
      exec.says.push(`(heal +${eff.amount})`);
      return;
    case "damage":
      if (!exec.flags.biome_rules && !exec.flags.item_taxonomy) {
        // Damage is allowed without flags too — combat isn't gated;
        // only the automated biome-rules-driven damage is.
      }
      applyNumericMutation(
        exec.state,
        exec.thisScope,
        "character.hp",
        (n) => n - eff.amount,
      );
      exec.says.push(
        `(-${eff.amount}${eff.damage_kind ? ` ${eff.damage_kind}` : ""} damage)`,
      );
      return;
    case "give_item":
      if (!exec.flags.item_taxonomy) {
        exec.says.push(`(gained ${eff.qty ?? 1}× ${eff.slug} — item system not yet enabled)`);
        return;
      }
      await applyGiveItem(ctx, eff, exec);
      return;
    case "take_item":
      if (!exec.flags.item_taxonomy) return;
      await applyTakeItem(ctx, eff, exec);
      return;
    case "use_item":
      if (!exec.flags.item_taxonomy) return;
      await applyUseItem(ctx, eff, exec);
      return;
    case "crack_orb":
      if (!exec.flags.item_taxonomy) return;
      await applyCrackOrb(ctx, eff, exec);
      return;
    case "narrate":
      // Queue; the action-tier call site (applyOption's wrapper) will
      // flush these after the mutation commits.
      exec.pending.push({ kind: "narrate", payload: eff });
      exec.says.push(`…`); // placeholder until Sonnet returns
      return;
    case "add_predicate": {
      // Resolve subject/object slugs to entities; lazy — skip if either
      // doesn't exist. Non-fatal.
      const subj = await resolveEntityBySlug(ctx, exec.branch_id, eff.subject);
      const obj = await resolveEntityBySlug(ctx, exec.branch_id, eff.object);
      if (subj && obj) {
        await ctx.db.insert("relations", {
          world_id: exec.world_id,
          branch_id: exec.branch_id,
          subject_id: subj._id,
          predicate: eff.predicate,
          object_id: obj._id,
          payload: eff.payload,
          version: 1,
        });
      }
      return;
    }
    case "advance_time":
      if (!exec.flags.world_clock) return;
      exec.extra_minutes += Math.max(0, Math.round(eff.delta_minutes ?? 0));
      return;
    case "emit":
      // Event log is a Wave-2 flow thing; no-op until flows land.
      return;
    case "flow_start":
    case "flow_send":
      if (!exec.flags.flows) return;
      exec.pending.push({ kind: "flow_start", payload: eff });
      return;
    case "spawn_from_biome":
      // Wave-2 biome_rules. No-op until wired.
      if (!exec.flags.biome_rules) return;
      return;
    default: {
      const _exhaustive: never = eff;
      return;
    }
  }
}

// --------------------------------------------------------------------
// Path mutations (shared with legacy locations.ts helpers)

function applyNumericMutation(
  state: Record<string, any>,
  thisScope: Record<string, any>,
  path: string,
  f: (n: number) => number,
) {
  if (path.startsWith("this.")) {
    const key = path.slice(5);
    const prev = Number(thisScope[key] ?? 0);
    thisScope[key] = f(prev);
  } else if (path.startsWith("character.")) {
    const key = path.slice(10);
    const prev = Number(state[key] ?? 0);
    state[key] = f(prev);
  }
}

function applyScalarMutation(
  state: Record<string, any>,
  thisScope: Record<string, any>,
  path: string,
  value: unknown,
) {
  if (path.startsWith("this.")) thisScope[path.slice(5)] = value;
  else if (path.startsWith("character.")) state[path.slice(10)] = value;
}

// --------------------------------------------------------------------
// Inventory effect handlers

async function applyGiveItem(
  ctx: any,
  eff: Extract<Effect, { kind: "give_item" }>,
  exec: EffectExecCtx,
) {
  const qty = eff.qty ?? 1;
  // Snapshot core metadata from the item entity if it exists — lets
  // condition evaluation read kind/color/size/slot/charges without a
  // DB roundtrip at check time.
  const itemEntity = await resolveEntityBySlug(ctx, exec.branch_id, eff.slug, "item");
  let extra: Partial<InventoryEntry> = {};
  if (itemEntity) {
    try {
      const payload = await readAuthoredPayload<Record<string, any>>(
        ctx,
        itemEntity,
      );
      extra = {
        kind: payload.kind,
        color: (payload.orb as any)?.color ?? payload.color,
        size: (payload.orb as any)?.size ?? payload.size,
        slot: (payload.gear as any)?.slot ?? payload.slot,
        charges: (payload.consumable as any)?.charges ?? payload.charges,
      };
    } catch {
      // fall through — inventory entry without metadata is still valid
    }
  }
  // Allow eff.payload to override (useful for authored loot variants).
  extra = { ...extra, ...(eff.payload ?? {}) };
  const inv = (exec.state.inventory as Inventory | undefined) ?? {};
  exec.state.inventory = inventoryAdd(inv, eff.slug, qty, extra);
  exec.says.push(`(+${qty}× ${eff.slug}${extra.kind ? ` [${extra.kind}]` : ""})`);
}

async function applyTakeItem(
  ctx: any,
  eff: Extract<Effect, { kind: "take_item" }>,
  exec: EffectExecCtx,
) {
  const qty = eff.qty ?? 1;
  const inv = (exec.state.inventory as Inventory | undefined) ?? {};
  const { inv: next, removed } = inventoryRemove(inv, eff.slug, qty);
  exec.state.inventory = next;
  if (removed > 0) exec.says.push(`(-${removed}× ${eff.slug})`);
}

async function applyUseItem(
  ctx: any,
  eff: Extract<Effect, { kind: "use_item" }>,
  exec: EffectExecCtx,
) {
  const inv = (exec.state.inventory as Inventory | undefined) ?? {};
  const entry = inv[eff.slug];
  if (!entry || (entry.qty ?? 0) <= 0) {
    exec.says.push(`(tried to use ${eff.slug} — not in inventory)`);
    return;
  }
  const itemEntity = await resolveEntityBySlug(
    ctx,
    exec.branch_id,
    eff.slug,
    "item",
  );
  if (!itemEntity) {
    exec.says.push(`(${eff.slug}: unknown item definition)`);
    return;
  }
  const payload = await readAuthoredPayload<Record<string, any>>(
    ctx,
    itemEntity,
  );
  if (payload.kind === "orb") {
    // Orbs use crack_orb; use_item is a no-op for them.
    exec.says.push(`(${eff.slug}: orbs are cracked, not used — try crack_orb)`);
    return;
  }
  const onUse = (payload.consumable?.on_use ?? payload.on_use ?? []) as Effect[];
  // Consume a charge.
  const charges = entry.charges ?? payload.consumable?.charges ?? 1;
  if (charges <= 1) {
    const { inv: next } = inventoryRemove(inv, eff.slug, 1);
    exec.state.inventory = next;
  } else {
    exec.state.inventory = {
      ...inv,
      [eff.slug]: { ...entry, charges: charges - 1 },
    };
  }
  exec.says.push(`(used ${eff.slug})`);
  await applyEffects(ctx, onUse, exec);
}

async function applyCrackOrb(
  ctx: any,
  eff: Extract<Effect, { kind: "crack_orb" }>,
  exec: EffectExecCtx,
) {
  const inv = (exec.state.inventory as Inventory | undefined) ?? {};
  const entry = inv[eff.slug];
  if (!entry || (entry.qty ?? 0) <= 0) {
    exec.says.push(`(no ${eff.slug} to crack)`);
    return;
  }
  const itemEntity = await resolveEntityBySlug(
    ctx,
    exec.branch_id,
    eff.slug,
    "item",
  );
  if (!itemEntity) return;
  const payload = await readAuthoredPayload<Record<string, any>>(
    ctx,
    itemEntity,
  );
  if (payload.kind !== "orb") {
    exec.says.push(`(${eff.slug} is not an orb)`);
    return;
  }
  // Fire on_crack, then on_absorb (orbs are consumed either way).
  const onCrack = (payload.orb?.on_crack ?? payload.on_crack ?? []) as Effect[];
  const onAbsorb = (payload.orb?.on_absorb ?? payload.on_absorb ?? []) as Effect[];
  // Remove orb from inventory first so downstream effects see the new shape.
  const { inv: next } = inventoryRemove(inv, eff.slug, 1);
  exec.state.inventory = next;
  exec.says.push(`(cracked ${eff.slug})`);
  await applyEffects(ctx, onCrack, exec);
  await applyEffects(ctx, onAbsorb, exec);
}

// --------------------------------------------------------------------
// Shared helpers

async function resolveEntityBySlug(
  ctx: any,
  branch_id: Id<"branches">,
  slug: string,
  type?: string,
): Promise<Doc<"entities"> | null> {
  if (type) {
    return (await ctx.db
      .query("entities")
      .withIndex("by_branch_type_slug", (q: any) =>
        q.eq("branch_id", branch_id).eq("type", type).eq("slug", slug),
      )
      .first()) as Doc<"entities"> | null;
  }
  // Walk common types — this is only for add_predicate, which is rare.
  for (const t of ["location", "character", "npc", "item", "biome"]) {
    const hit = await ctx.db
      .query("entities")
      .withIndex("by_branch_type_slug", (q: any) =>
        q.eq("branch_id", branch_id).eq("type", t).eq("slug", slug),
      )
      .first();
    if (hit) return hit as Doc<"entities">;
  }
  return null;
}

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

/** Resolve the four effect-relevant flags for a (world, user) combo.
 *  Called once per applyOption so effects don't re-query. */
export async function resolveEffectFlags(
  ctx: any,
  world_id: Id<"worlds">,
  user_id: Id<"users">,
): Promise<EffectExecCtx["flags"]> {
  const scope = { world_id, user_id };
  const [item_taxonomy, biome_rules, flows, world_clock] = await Promise.all([
    isFeatureEnabled(ctx, "flag.item_taxonomy", scope),
    isFeatureEnabled(ctx, "flag.biome_rules", scope),
    isFeatureEnabled(ctx, "flag.flows", scope),
    isFeatureEnabled(ctx, "flag.world_clock", scope),
  ]);
  return { item_taxonomy, biome_rules, flows, world_clock };
}

// --------------------------------------------------------------------
// Narrate — async effect (runs in an action so it can call Sonnet).

export const runNarrate = internalAction({
  args: {
    world_id: v.id("worlds"),
    branch_id: v.id("branches"),
    character_id: v.id("characters"),
    speaker_entity_id: v.optional(v.id("entities")),
    prompt: v.string(),
    salience: v.optional(v.string()),
    memory_event_type: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { world_id, branch_id, character_id, speaker_entity_id, prompt, salience, memory_event_type },
  ) => {
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const assembled = await ctx.runQuery(internal.narrative.buildPrompt, {
      world_id,
      purpose: "narrate",
      character_id,
      speaker_entity_id,
    });
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 256,
      temperature: 0.9,
      system: assembled.system,
      messages: [
        {
          role: "user",
          content: `${assembled.user ?? ""}\n\n${prompt}\n\nRespond with 1–3 sentences of flavor prose, in character with the world bible tone. No meta-commentary, no markdown.`,
        },
      ],
    });
    const text = response.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("")
      .trim();
    await ctx.runMutation(internal.effects.appendPendingSay, {
      character_id,
      text,
    });

    // Auto-write NPC memory if the effect carried memory_event_type + a
    // speaker. Flag-gated — writeNpcMemoryFromAction no-ops when off.
    if (speaker_entity_id && memory_event_type) {
      await ctx.runMutation(internal.effects.writeNpcMemoryFromAction, {
        world_id,
        branch_id,
        npc_entity_id: speaker_entity_id,
        about_character_id: character_id,
        event_type: memory_event_type,
        summary: text.slice(0, 120),
        salience: (salience as any) ?? "medium",
      });
    }
  },
});

/** Internal-mutation wrapper around writeNpcMemory — runNarrate (an
 *  action) needs a mutation to persist. Respects flag.npc_memory. */
export const writeNpcMemoryFromAction = internalMutation({
  args: {
    world_id: v.id("worlds"),
    branch_id: v.id("branches"),
    npc_entity_id: v.id("entities"),
    about_character_id: v.optional(v.id("characters")),
    event_type: v.string(),
    summary: v.string(),
    salience: v.optional(
      v.union(v.literal("low"), v.literal("medium"), v.literal("high")),
    ),
  },
  handler: async (ctx, args) => {
    const on = await isFeatureEnabled(ctx, "flag.npc_memory", {
      world_id: args.world_id,
    });
    if (!on) return { written: false };
    const { writeNpcMemory } = await import("./npc_memory.js");
    const id = await writeNpcMemory(ctx, args);
    return { written: true, id };
  },
});

export const appendPendingSay = internalMutation({
  args: { character_id: v.id("characters"), text: v.string() },
  handler: async (ctx, { character_id, text }) => {
    const c = await ctx.db.get(character_id);
    if (!c) return;
    const state = { ...(c.state ?? {}) };
    state.pending_says = [...((state.pending_says as string[]) ?? []), text];
    await ctx.db.patch(character_id, { state, updated_at: Date.now() });
  },
});
