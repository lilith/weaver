// Events log — single chokepoint for writing narrative-significant
// events, plus the queries the tiered context assembler reads from.
//
// Spec: spec/CONTEXT_AND_RECALL.md.
//
// Two parts:
//   - writeEvent (internal mutation) — every call site that produces
//     player-visible text routes through here, filling whichever
//     foreign-key columns are relevant.
//   - eventsAt* queries — bounded reads (limit + min_salience) the
//     assembler invokes when building a prompt slab.

import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server.js";
import { resolveMember } from "./sessions.js";
import type { Doc, Id } from "./_generated/dataModel.js";

const SALIENCE = v.union(
	v.literal("low"),
	v.literal("medium"),
	v.literal("high"),
);

// Salience -> ordinal for filtering (>= medium etc.).
const SAL_ORDER: Record<"low" | "medium" | "high", number> = {
	low: 0,
	medium: 1,
	high: 2,
};

// --------------------------------------------------------------------
// Writer chokepoint

/** Every call site producing player-visible narrative text routes
 *  through here. Sparse columns: only fill what the event is actually
 *  about. The unique invariant is `branch_id + at + kind + body` —
 *  the assembler dedupes by that tuple, but writes are append-only so
 *  collisions are vanishingly rare. */
export const writeEvent = internalMutation({
	args: {
		world_id: v.id("worlds"),
		branch_id: v.id("branches"),
		character_id: v.optional(v.id("characters")),
		location_id: v.optional(v.id("entities")),
		npc_entity_id: v.optional(v.id("entities")),
		item_slug: v.optional(v.string()),
		thread_id: v.optional(v.string()),
		kind: v.string(),
		body: v.string(),
		payload: v.optional(v.any()),
		salience: v.optional(SALIENCE),
		turn: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		// Pull the world clock turn if caller didn't supply one.
		let turn = args.turn ?? 0;
		if (args.turn == null) {
			const branch = await ctx.db.get(args.branch_id);
			turn = ((branch?.state as any)?.turn as number | undefined) ?? 0;
		}
		const id = await ctx.db.insert("events", {
			world_id: args.world_id,
			branch_id: args.branch_id,
			character_id: args.character_id,
			location_id: args.location_id,
			npc_entity_id: args.npc_entity_id,
			item_slug: args.item_slug,
			thread_id: args.thread_id,
			kind: args.kind,
			body: args.body.slice(0, 8000),
			payload: args.payload,
			salience: args.salience ?? "medium",
			turn,
			at: now,
		});
		return { event_id: id };
	},
});

// --------------------------------------------------------------------
// Read queries — bounded slabs the assembler feeds into the prompt.

const READ_LIMIT_DEFAULT = 30;

function filterSalience<T extends Doc<"events">>(
	rows: T[],
	min: "low" | "medium" | "high" | undefined,
): T[] {
	if (!min || min === "low") return rows;
	const cutoff = SAL_ORDER[min];
	return rows.filter((r) => SAL_ORDER[r.salience] >= cutoff);
}

function shapeForReturn(rows: Doc<"events">[]) {
	return rows.map((r) => ({
		_id: r._id,
		kind: r.kind,
		body: r.body,
		salience: r.salience,
		turn: r.turn,
		at: r.at,
		location_id: r.location_id ?? null,
		npc_entity_id: r.npc_entity_id ?? null,
		item_slug: r.item_slug ?? null,
		thread_id: r.thread_id ?? null,
		character_id: r.character_id ?? null,
		payload: r.payload ?? null,
	}));
}

/** Last N events at a location. Used when the player returns somewhere
 *  to give the assembler "what happened here." */
export const eventsAtLocation = query({
	args: {
		session_token: v.string(),
		world_slug: v.string(),
		location_id: v.id("entities"),
		limit: v.optional(v.number()),
		min_salience: v.optional(SALIENCE),
	},
	handler: async (ctx, args) => {
		const world = await ctx.db
			.query("worlds")
			.withIndex("by_slug", (q: any) => q.eq("slug", args.world_slug))
			.first();
		if (!world) return [];
		await resolveMember(ctx as any, args.session_token, world._id);
		if (!world.current_branch_id) return [];
		const rows = await ctx.db
			.query("events")
			.withIndex("by_branch_location_time", (q: any) =>
				q.eq("branch_id", world.current_branch_id!).eq("location_id", args.location_id),
			)
			.order("desc")
			.take(args.limit ?? READ_LIMIT_DEFAULT);
		return shapeForReturn(filterSalience(rows, args.min_salience));
	},
});

/** Last N events involving an NPC. The assembler uses this for "Mara
 *  remembers …" beats — supplements npc_memory which is per-character
 *  summaries; this is the raw witnessed events. */
export const eventsForNpc = query({
	args: {
		session_token: v.string(),
		world_slug: v.string(),
		npc_entity_id: v.id("entities"),
		limit: v.optional(v.number()),
		min_salience: v.optional(SALIENCE),
	},
	handler: async (ctx, args) => {
		const world = await ctx.db
			.query("worlds")
			.withIndex("by_slug", (q: any) => q.eq("slug", args.world_slug))
			.first();
		if (!world) return [];
		await resolveMember(ctx as any, args.session_token, world._id);
		if (!world.current_branch_id) return [];
		const rows = await ctx.db
			.query("events")
			.withIndex("by_branch_npc_time", (q: any) =>
				q.eq("branch_id", world.current_branch_id!).eq("npc_entity_id", args.npc_entity_id),
			)
			.order("desc")
			.take(args.limit ?? READ_LIMIT_DEFAULT);
		return shapeForReturn(filterSalience(rows, args.min_salience));
	},
});

/** Last N events involving an item. Long-arc continuity for the orb /
 *  the lamp / etc. */
export const eventsForItem = query({
	args: {
		session_token: v.string(),
		world_slug: v.string(),
		item_slug: v.string(),
		limit: v.optional(v.number()),
		min_salience: v.optional(SALIENCE),
	},
	handler: async (ctx, args) => {
		const world = await ctx.db
			.query("worlds")
			.withIndex("by_slug", (q: any) => q.eq("slug", args.world_slug))
			.first();
		if (!world) return [];
		await resolveMember(ctx as any, args.session_token, world._id);
		if (!world.current_branch_id) return [];
		const rows = await ctx.db
			.query("events")
			.withIndex("by_branch_item_time", (q: any) =>
				q.eq("branch_id", world.current_branch_id!).eq("item_slug", args.item_slug),
			)
			.order("desc")
			.take(args.limit ?? READ_LIMIT_DEFAULT);
		return shapeForReturn(filterSalience(rows, args.min_salience));
	},
});

/** Last N events shared between this character and an NPC. Powers the
 *  "Mara remembers your last conversation" beat — most relevant slab
 *  for dialogue prompts. */
export const eventsForCharacterNpc = query({
	args: {
		session_token: v.string(),
		world_slug: v.string(),
		character_id: v.id("characters"),
		npc_entity_id: v.id("entities"),
		limit: v.optional(v.number()),
		min_salience: v.optional(SALIENCE),
	},
	handler: async (ctx, args) => {
		const world = await ctx.db
			.query("worlds")
			.withIndex("by_slug", (q: any) => q.eq("slug", args.world_slug))
			.first();
		if (!world) return [];
		await resolveMember(ctx as any, args.session_token, world._id);
		if (!world.current_branch_id) return [];
		const rows = await ctx.db
			.query("events")
			.withIndex("by_branch_character_npc_time", (q: any) =>
				q
					.eq("branch_id", world.current_branch_id!)
					.eq("character_id", args.character_id)
					.eq("npc_entity_id", args.npc_entity_id),
			)
			.order("desc")
			.take(args.limit ?? READ_LIMIT_DEFAULT);
		return shapeForReturn(filterSalience(rows, args.min_salience));
	},
});

/** Last N events this character witnessed in a thread. The default
 *  call shape for the assembler's "recent verbatim" tier. */
export const eventsForCharacterThread = query({
	args: {
		session_token: v.string(),
		world_slug: v.string(),
		character_id: v.id("characters"),
		thread_id: v.optional(v.string()),
		limit: v.optional(v.number()),
		min_salience: v.optional(SALIENCE),
	},
	handler: async (ctx, args) => {
		const world = await ctx.db
			.query("worlds")
			.withIndex("by_slug", (q: any) => q.eq("slug", args.world_slug))
			.first();
		if (!world) return [];
		await resolveMember(ctx as any, args.session_token, world._id);
		if (!world.current_branch_id) return [];
		const rows = await ctx.db
			.query("events")
			.withIndex("by_branch_character_thread_time", (q: any) =>
				q
					.eq("branch_id", world.current_branch_id!)
					.eq("character_id", args.character_id)
					.eq("thread_id", args.thread_id ?? undefined),
			)
			.order("desc")
			.take(args.limit ?? READ_LIMIT_DEFAULT);
		return shapeForReturn(filterSalience(rows, args.min_salience));
	},
});

// --------------------------------------------------------------------
// Internal-flavored variants (callable from actions like the tiered
// assembler without taking a session token). The action that wraps
// the AI call has already resolved permissions upstream.

export const internalEventsForCharacterThread = internalQuery({
	args: {
		branch_id: v.id("branches"),
		character_id: v.id("characters"),
		thread_id: v.optional(v.string()),
		limit: v.optional(v.number()),
		min_salience: v.optional(SALIENCE),
	},
	handler: async (ctx, args) => {
		const rows = await ctx.db
			.query("events")
			.withIndex("by_branch_character_thread_time", (q: any) =>
				q
					.eq("branch_id", args.branch_id)
					.eq("character_id", args.character_id)
					.eq("thread_id", args.thread_id ?? undefined),
			)
			.order("desc")
			.take(args.limit ?? READ_LIMIT_DEFAULT);
		return shapeForReturn(filterSalience(rows, args.min_salience));
	},
});

export const internalEventsAtLocation = internalQuery({
	args: {
		branch_id: v.id("branches"),
		location_id: v.id("entities"),
		limit: v.optional(v.number()),
		min_salience: v.optional(SALIENCE),
	},
	handler: async (ctx, args) => {
		const rows = await ctx.db
			.query("events")
			.withIndex("by_branch_location_time", (q: any) =>
				q.eq("branch_id", args.branch_id).eq("location_id", args.location_id),
			)
			.order("desc")
			.take(args.limit ?? READ_LIMIT_DEFAULT);
		return shapeForReturn(filterSalience(rows, args.min_salience));
	},
});

export const internalEventsForCharacterNpc = internalQuery({
	args: {
		branch_id: v.id("branches"),
		character_id: v.id("characters"),
		npc_entity_id: v.id("entities"),
		limit: v.optional(v.number()),
		min_salience: v.optional(SALIENCE),
	},
	handler: async (ctx, args) => {
		const rows = await ctx.db
			.query("events")
			.withIndex("by_branch_character_npc_time", (q: any) =>
				q
					.eq("branch_id", args.branch_id)
					.eq("character_id", args.character_id)
					.eq("npc_entity_id", args.npc_entity_id),
			)
			.order("desc")
			.take(args.limit ?? READ_LIMIT_DEFAULT);
		return shapeForReturn(filterSalience(rows, args.min_salience));
	},
});
