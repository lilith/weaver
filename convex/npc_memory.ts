// NPC memory — spec 24 Ask 4.
//
// Each row is (npc_entity, world, branch, about_character?, event_type,
// summary, salience, turn). Narrative prompt assembler pulls memories
// into <speaker_memory> when flag.npc_memory is on. Auto-writes fire
// from:
//   - narrate effects carrying `memory_event_type` (e.g. "dialogue_turn")
//   - location entry where the NPC is at the location (event type:
//     "the_player_visited") — lightweight, one row per visit
//
// Decay + compaction are Wave 2.5 — a cron that folds the oldest
// low-salience rows into weekly summaries. For now we just let the
// table grow; the assembler caps at N most-recent + high-salience.

import { internalMutation, query, mutation } from "./_generated/server.js";
import { v } from "convex/values";
import { resolveSession, resolveMember } from "./sessions.js";
import type { Doc, Id } from "./_generated/dataModel.js";

const MAX_MEMORIES_PER_PROMPT = 12;

export type NpcMemoryRow = {
  world_id: Id<"worlds">;
  branch_id: Id<"branches">;
  npc_entity_id: Id<"entities">;
  about_character_id?: Id<"characters">;
  event_type: string;
  summary: string;
  salience: "low" | "medium" | "high";
  turn: number;
  created_at: number;
  is_compacted?: boolean;
};

/** Read recent + high-salience memories for a given NPC. Cap at
 *  MAX_MEMORIES_PER_PROMPT to keep prompts sane. */
export async function loadNpcMemory(
  ctx: any,
  branch_id: Id<"branches">,
  npc_entity_id: Id<"entities">,
): Promise<{
  high: NpcMemoryRow[];
  recent: NpcMemoryRow[];
  total: number;
}> {
  const all = await ctx.db
    .query("npc_memory")
    .withIndex("by_branch_npc_turn", (q: any) =>
      q.eq("branch_id", branch_id).eq("npc_entity_id", npc_entity_id),
    )
    .collect();
  const high = all.filter((r: any) => r.salience === "high").slice(-MAX_MEMORIES_PER_PROMPT);
  const recentByTurn = [...all]
    .sort((a: any, b: any) => b.turn - a.turn)
    .slice(0, MAX_MEMORIES_PER_PROMPT);
  return { high, recent: recentByTurn, total: all.length };
}

/** Write a memory row. Idempotence is not required — dialogue turns
 *  legitimately repeat — but trivial spam is filtered by checking if
 *  the latest row for this NPC has the exact same summary at the
 *  current turn. */
export async function writeNpcMemory(
  ctx: any,
  args: {
    world_id: Id<"worlds">;
    branch_id: Id<"branches">;
    npc_entity_id: Id<"entities">;
    about_character_id?: Id<"characters">;
    event_type: string;
    summary: string;
    salience?: "low" | "medium" | "high";
    turn?: number;
  },
): Promise<Id<"npc_memory">> {
  const turn = args.turn ?? (await resolveCurrentTurn(ctx, args.branch_id));
  // De-dup spam: if the last row has the same summary at the same turn,
  // don't write a new one.
  const last = await ctx.db
    .query("npc_memory")
    .withIndex("by_branch_npc_turn", (q: any) =>
      q.eq("branch_id", args.branch_id).eq("npc_entity_id", args.npc_entity_id),
    )
    .order("desc")
    .first();
  if (
    last &&
    last.turn === turn &&
    last.summary === args.summary &&
    last.event_type === args.event_type
  ) {
    return last._id;
  }
  return await ctx.db.insert("npc_memory", {
    world_id: args.world_id,
    branch_id: args.branch_id,
    npc_entity_id: args.npc_entity_id,
    about_character_id: args.about_character_id,
    event_type: args.event_type,
    summary: args.summary,
    salience: args.salience ?? "medium",
    turn,
    created_at: Date.now(),
  });
}

async function resolveCurrentTurn(
  ctx: any,
  branch_id: Id<"branches">,
): Promise<number> {
  const b = await ctx.db.get(branch_id);
  return ((b?.state as any)?.turn ?? 0) as number;
}

// --------------------------------------------------------------------
// Public API — list / show / add (for CLI)

export const listForNpc = query({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    npc_slug: v.string(),
  },
  handler: async (ctx, { session_token, world_slug, npc_slug }) => {
    const world = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q) => q.eq("slug", world_slug))
      .first();
    if (!world) throw new Error(`world not found: ${world_slug}`);
    await resolveMember(ctx, session_token, world._id);
    if (!world.current_branch_id) return [];
    const npc = await ctx.db
      .query("entities")
      .withIndex("by_branch_type_slug", (q) =>
        q
          .eq("branch_id", world.current_branch_id!)
          .eq("type", "npc")
          .eq("slug", npc_slug),
      )
      .first();
    if (!npc) {
      // Try as character too — memories can be on any entity role.
      const alt = await ctx.db
        .query("entities")
        .withIndex("by_branch_type_slug", (q) =>
          q
            .eq("branch_id", world.current_branch_id!)
            .eq("type", "character")
            .eq("slug", npc_slug),
        )
        .first();
      if (!alt) return [];
      return (await loadAllRaw(ctx, world.current_branch_id!, alt._id));
    }
    return (await loadAllRaw(ctx, world.current_branch_id!, npc._id));
  },
});

async function loadAllRaw(
  ctx: any,
  branch_id: Id<"branches">,
  npc_entity_id: Id<"entities">,
) {
  const rows = await ctx.db
    .query("npc_memory")
    .withIndex("by_branch_npc_turn", (q: any) =>
      q.eq("branch_id", branch_id).eq("npc_entity_id", npc_entity_id),
    )
    .collect();
  return rows.map((r: any) => ({
    id: r._id,
    event_type: r.event_type,
    summary: r.summary,
    salience: r.salience,
    turn: r.turn,
    created_at: r.created_at,
    is_compacted: r.is_compacted === true,
  }));
}

// --------------------------------------------------------------------
// Weekly decay / compaction cron — keeps prompt signal-to-noise clean
// as worlds age. Per (world, npc): when the NPC has > NPC_MEMORY_CAP
// rows, fold the oldest low-salience batch into one synthesized
// "compacted_summary" row and delete the originals. High-salience
// rows are never compacted — those are the load-bearing memories
// the narrator reaches for first.
//
// Heuristic compaction (no LLM): grouped-by-event-type with example
// summaries. Costs nothing to run weekly. Swap to Opus-written
// one-paragraph synthesis when cost ledger is in place.

const NPC_MEMORY_CAP = 50;
const COMPACT_BATCH = 20;

export const gcNpcMemory = internalMutation({
  args: {},
  handler: async (ctx) => {
    // Collect every NPC with any memory rows, then per-NPC check count.
    // Weekly job; O(all npc_memory rows) is fine.
    const rows = await ctx.db.query("npc_memory").collect();
    const byNpc = new Map<string, any[]>();
    for (const r of rows) {
      const key = `${r.branch_id}|${r.npc_entity_id}`;
      const arr = byNpc.get(key) ?? [];
      arr.push(r);
      byNpc.set(key, arr);
    }
    let npcsCompacted = 0;
    let rowsDeleted = 0;
    let summariesAdded = 0;
    for (const [, npcRows] of byNpc) {
      if (npcRows.length <= NPC_MEMORY_CAP) continue;
      // Sort oldest first; skip already-compacted + high-salience.
      const candidates = npcRows
        .filter((r: any) => !r.is_compacted && r.salience !== "high")
        .sort((a: any, b: any) => a.turn - b.turn || a.created_at - b.created_at);
      const batch = candidates.slice(0, COMPACT_BATCH);
      if (batch.length < 5) continue; // not worth compacting tiny batches
      // Group by event_type for a structured summary.
      const grouped: Record<string, any[]> = {};
      for (const r of batch) {
        (grouped[r.event_type] ??= []).push(r);
      }
      const lines: string[] = [];
      for (const [etype, group] of Object.entries(grouped)) {
        const examples = group.slice(0, 3).map((r) => `"${r.summary}"`).join(", ");
        const more = group.length > 3 ? ` (+${group.length - 3} more)` : "";
        lines.push(`${group.length}× ${etype}: ${examples}${more}`);
      }
      const turnLo = batch[0].turn;
      const turnHi = batch[batch.length - 1].turn;
      const synthesized = `Across turns ${turnLo}–${turnHi}: ${lines.join("; ")}`;
      const first = batch[0];
      await ctx.db.insert("npc_memory", {
        world_id: first.world_id,
        branch_id: first.branch_id,
        npc_entity_id: first.npc_entity_id,
        about_character_id: first.about_character_id,
        event_type: "compacted_summary",
        summary: synthesized.slice(0, 1000),
        salience: "medium",
        turn: turnHi,
        created_at: Date.now(),
        is_compacted: true,
      });
      summariesAdded++;
      for (const r of batch) {
        await ctx.db.delete(r._id);
        rowsDeleted++;
      }
      npcsCompacted++;
    }
    return { npcs_compacted: npcsCompacted, rows_deleted: rowsDeleted, summaries_added: summariesAdded };
  },
});

/** Add a memory manually — useful for seeding + CLI. Owner-only. */
export const addForNpc = mutation({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    npc_slug: v.string(),
    event_type: v.string(),
    summary: v.string(),
    salience: v.optional(
      v.union(v.literal("low"), v.literal("medium"), v.literal("high")),
    ),
  },
  handler: async (
    ctx,
    { session_token, world_slug, npc_slug, event_type, summary, salience },
  ) => {
    const world = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q) => q.eq("slug", world_slug))
      .first();
    if (!world) throw new Error(`world not found: ${world_slug}`);
    const { user_id } = await resolveMember(ctx, session_token, world._id);
    if (world.owner_user_id !== user_id)
      throw new Error("forbidden: add-npc-memory is owner-only");
    if (!world.current_branch_id) throw new Error("world has no branch");
    const npc = await ctx.db
      .query("entities")
      .withIndex("by_branch_type_slug", (q) =>
        q
          .eq("branch_id", world.current_branch_id!)
          .eq("type", "npc")
          .eq("slug", npc_slug),
      )
      .first();
    const character = await ctx.db
      .query("entities")
      .withIndex("by_branch_type_slug", (q) =>
        q
          .eq("branch_id", world.current_branch_id!)
          .eq("type", "character")
          .eq("slug", npc_slug),
      )
      .first();
    const entity = npc ?? character;
    if (!entity) throw new Error(`npc/character not found: ${npc_slug}`);
    const id = await writeNpcMemory(ctx, {
      world_id: world._id,
      branch_id: world.current_branch_id,
      npc_entity_id: entity._id,
      event_type,
      summary,
      salience,
    });
    return { id };
  },
});
