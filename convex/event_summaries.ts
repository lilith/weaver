// Event-summary builder — Sonnet 1M lossless rebuilds + Haiku in-voice
// deltas. Spec: spec/CONTEXT_AND_RECALL.md.
//
// Two operations the assembler reads from:
//   - rebuildSummary  internalAction  Sonnet 1M reads ALL raw events
//                     for (character?, thread?) plus bible+voice
//                     samples and writes one in-voice memory-book
//                     entry. Triggered infrequently — era advance,
//                     session boundary, every ~50 turns. The fresh
//                     rebuild replaces the rolling-summary tier.
//   - extendDelta     internalAction  Haiku summarizes events SINCE
//                     the most recent rebuild into a short in-voice
//                     paragraph. Cheap, frequent. Concatenated with
//                     the rebuild as the "summary" tier.
//
// Both write event_summaries rows; readers use the latest by kind via
// the existing index. Never delete — the audit trail is the rollback
// surface.

import { v } from "convex/values";
import Anthropic from "@anthropic-ai/sdk";
import {
	internalAction,
	internalMutation,
	internalQuery,
	mutation,
	query,
} from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { resolveMember } from "./sessions.js";
import { readJSONBlob } from "./blobs.js";
import { anthropicCostUsd } from "./cost.js";
import {
	renderBibleAsProse,
	renderStylePrelude,
	type BibleShape,
} from "@weaver/engine/context";
import type { Doc, Id } from "./_generated/dataModel.js";

const REBUILD_MODEL = "claude-sonnet-4-6"; // 1M context, $3/$15 per MTok
const DELTA_MODEL = "claude-haiku-4-5-20251001";

const REBUILD_SYSTEM = `You are condensing a player's experience into a short memory-book entry — a single passage written in the world's voice that another instance of you (the in-game AI) will read at the top of every future prompt.

You are NOT writing a summary or a list of plot points. You are writing how this character would remember what's happened, if pressed — sensory, emotional, with specific objects and gestures. Aim for 200-400 words.

Hard rules:
- The voice samples in <voice_samples> are not optional reference — write IN that register, not about it.
- No bullet lists. No headers. No "meanwhile" or "in conclusion." No parenthetical exposition.
- No second-person therapy-speak ("you feel a part of you wonders…").
- No closing summary. End on an image, not a thesis.
- Names appear once, naturally. Don't list characters; let them appear in the action.

Output a single passage — plain text, no JSON, no markdown.`;

const DELTA_SYSTEM = `You are extending a memory-book with what's happened since the last entry. Write in the world's voice — short, sensory, in-character. The result should read like a continuation of <prior_summary>, picking up where it left off.

Hard rules:
- The voice samples in <voice_samples> set the register. Write IN that register.
- 80-160 words. Compact, not lossy.
- No bullets. No "meanwhile." No closing summary line.
- End on an image.

Output a single passage — plain text only.`;

// --------------------------------------------------------------------
// Public read

/** Latest rebuild + latest delta for a (character, thread). The
 *  assembler concatenates these as the "summary" tier. Either may be
 *  null when the world is fresh. */
export const latestSummariesFor = query({
	args: {
		session_token: v.string(),
		world_slug: v.string(),
		character_id: v.id("characters"),
		thread_id: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const world = await ctx.db
			.query("worlds")
			.withIndex("by_slug", (q: any) => q.eq("slug", args.world_slug))
			.first();
		if (!world) return null;
		await resolveMember(ctx as any, args.session_token, world._id);
		if (!world.current_branch_id) return null;
		return loadLatestSummaries(ctx, {
			branch_id: world.current_branch_id,
			character_id: args.character_id,
			thread_id: args.thread_id,
		});
	},
});

async function loadLatestSummaries(
	ctx: any,
	args: {
		branch_id: Id<"branches">;
		character_id: Id<"characters">;
		thread_id: string | undefined;
	},
) {
	const rebuild = (await ctx.db
		.query("event_summaries")
		.withIndex("by_branch_character_thread_kind_time", (q: any) =>
			q
				.eq("branch_id", args.branch_id)
				.eq("character_id", args.character_id)
				.eq("thread_id", args.thread_id ?? undefined)
				.eq("kind", "rebuild"),
		)
		.order("desc")
		.first()) as Doc<"event_summaries"> | null;
	const delta = (await ctx.db
		.query("event_summaries")
		.withIndex("by_branch_character_thread_kind_time", (q: any) =>
			q
				.eq("branch_id", args.branch_id)
				.eq("character_id", args.character_id)
				.eq("thread_id", args.thread_id ?? undefined)
				.eq("kind", "delta"),
		)
		.order("desc")
		.first()) as Doc<"event_summaries"> | null;
	return {
		rebuild: rebuild
			? {
					_id: rebuild._id,
					body: rebuild.body,
					covers_until_turn: rebuild.covers_until_turn,
					model: rebuild.model,
					created_at: rebuild.created_at,
				}
			: null,
		delta:
			delta && (!rebuild || delta.created_at > rebuild.created_at)
				? {
						_id: delta._id,
						body: delta.body,
						covers_until_turn: delta.covers_until_turn,
						model: delta.model,
						created_at: delta.created_at,
					}
				: null,
	};
}

// --------------------------------------------------------------------
// Triggers — owner-callable mutations that schedule the rebuild action.
//
// Owner triggers manually for now (admin button, era advance hook); a
// scheduled cron for "every N turns" is a follow-up. Mutations are
// owner-only because they spend Sonnet tokens.

export const triggerRebuild = mutation({
	args: {
		session_token: v.string(),
		world_slug: v.string(),
		character_id: v.id("characters"),
		thread_id: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const world = await ctx.db
			.query("worlds")
			.withIndex("by_slug", (q: any) => q.eq("slug", args.world_slug))
			.first();
		if (!world) throw new Error("world not found");
		const { user_id } = await resolveMember(ctx, args.session_token, world._id);
		if (world.owner_user_id !== user_id)
			throw new Error("forbidden: rebuild is owner-only");
		if (!world.current_branch_id) throw new Error("world has no branch");
		await ctx.scheduler.runAfter(0, internal.event_summaries.runRebuild, {
			world_id: world._id,
			branch_id: world.current_branch_id,
			character_id: args.character_id,
			thread_id: args.thread_id,
		});
		return { queued: true };
	},
});

export const triggerDelta = mutation({
	args: {
		session_token: v.string(),
		world_slug: v.string(),
		character_id: v.id("characters"),
		thread_id: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const world = await ctx.db
			.query("worlds")
			.withIndex("by_slug", (q: any) => q.eq("slug", args.world_slug))
			.first();
		if (!world) throw new Error("world not found");
		const { user_id } = await resolveMember(ctx, args.session_token, world._id);
		if (world.owner_user_id !== user_id)
			throw new Error("forbidden: delta is owner-only");
		if (!world.current_branch_id) throw new Error("world has no branch");
		await ctx.scheduler.runAfter(0, internal.event_summaries.runDelta, {
			world_id: world._id,
			branch_id: world.current_branch_id,
			character_id: args.character_id,
			thread_id: args.thread_id,
		});
		return { queued: true };
	},
});

// --------------------------------------------------------------------
// Internals — the actual Sonnet/Haiku calls

export const runRebuild = internalAction({
	args: {
		world_id: v.id("worlds"),
		branch_id: v.id("branches"),
		character_id: v.id("characters"),
		thread_id: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const info = await ctx.runQuery(
			internal.event_summaries.loadRebuildContext,
			args,
		);
		if (!info) return;
		if (info.events.length === 0) return; // nothing to summarize yet

		const stylePrelude = renderStylePrelude({
			voice_samples: info.voice_samples,
			voice_avoid: info.voice_avoid,
		});
		const bibleProse = renderBibleAsProse(info.bible);

		const userParts: string[] = [];
		userParts.push(`<bible>\n${bibleProse}\n</bible>`);
		if (info.voice_samples.length > 0) {
			userParts.push(
				`<voice_samples>\n${info.voice_samples.map((s) => `«${s.trim()}»`).join("\n\n")}\n</voice_samples>`,
			);
		}
		userParts.push(`<character>${info.character_name}</character>`);
		userParts.push(
			`<events>\n${info.events
				.map(
					(e) =>
						`[t${e.turn} ${e.kind}${e.location_slug ? ` @${e.location_slug}` : ""}${e.npc_slug ? ` with:${e.npc_slug}` : ""}] ${e.body}`,
				)
				.join("\n")}\n</events>`,
		);
		userParts.push(
			`Write the memory-book entry now. ${info.events.length} events covering up to turn ${info.last_turn}. Plain text only.`,
		);

		const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
		const response = await anthropic.messages.create({
			model: REBUILD_MODEL,
			max_tokens: 800,
			temperature: 0.7,
			system: [
				{
					type: "text",
					text: `${stylePrelude}\n\n${REBUILD_SYSTEM}`,
				},
			],
			messages: [{ role: "user", content: userParts.join("\n\n") }],
		});

		const text = response.content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("")
			.trim();
		if (text.length < 20) return; // too short — likely an error response

		await ctx.runMutation(internal.cost.logCostUsd, {
			world_id: args.world_id,
			kind: `anthropic:sonnet:summary_rebuild`,
			cost_usd: anthropicCostUsd(REBUILD_MODEL, response.usage as any),
			reason: `summary rebuild for character ${args.character_id} thread ${args.thread_id ?? "main"}`,
		});

		await ctx.runMutation(internal.event_summaries.writeSummary, {
			world_id: args.world_id,
			branch_id: args.branch_id,
			character_id: args.character_id,
			thread_id: args.thread_id,
			kind: "rebuild",
			body: text,
			covers_until_turn: info.last_turn,
			model: REBUILD_MODEL,
			source_signature: info.source_signature,
		});
	},
});

export const runDelta = internalAction({
	args: {
		world_id: v.id("worlds"),
		branch_id: v.id("branches"),
		character_id: v.id("characters"),
		thread_id: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const info = await ctx.runQuery(
			internal.event_summaries.loadDeltaContext,
			args,
		);
		if (!info) return;
		if (info.events.length === 0) return;

		const stylePrelude = renderStylePrelude({
			voice_samples: info.voice_samples,
			voice_avoid: info.voice_avoid,
		});

		const userParts: string[] = [];
		if (info.voice_samples.length > 0) {
			userParts.push(
				`<voice_samples>\n${info.voice_samples.map((s) => `«${s.trim()}»`).join("\n\n")}\n</voice_samples>`,
			);
		}
		if (info.prior_summary) {
			userParts.push(`<prior_summary>\n${info.prior_summary}\n</prior_summary>`);
		}
		userParts.push(
			`<events_since_last_summary>\n${info.events
				.map(
					(e) =>
						`[t${e.turn} ${e.kind}${e.location_slug ? ` @${e.location_slug}` : ""}${e.npc_slug ? ` with:${e.npc_slug}` : ""}] ${e.body}`,
				)
				.join("\n")}\n</events_since_last_summary>`,
		);
		userParts.push(`Continue the memory-book in the world's voice.`);

		const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
		const response = await anthropic.messages.create({
			model: DELTA_MODEL,
			max_tokens: 350,
			temperature: 0.6,
			system: [
				{
					type: "text",
					text: `${stylePrelude}\n\n${DELTA_SYSTEM}`,
				},
			],
			messages: [{ role: "user", content: userParts.join("\n\n") }],
		});

		const text = response.content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("")
			.trim();
		if (text.length < 20) return;

		await ctx.runMutation(internal.cost.logCostUsd, {
			world_id: args.world_id,
			kind: `anthropic:haiku:summary_delta`,
			cost_usd: anthropicCostUsd(DELTA_MODEL, response.usage as any),
			reason: `summary delta for character ${args.character_id}`,
		});

		await ctx.runMutation(internal.event_summaries.writeSummary, {
			world_id: args.world_id,
			branch_id: args.branch_id,
			character_id: args.character_id,
			thread_id: args.thread_id,
			kind: "delta",
			body: text,
			covers_until_turn: info.last_turn,
			model: DELTA_MODEL,
		});
	},
});

// --------------------------------------------------------------------
// Internal queries / mutation helpers

export const loadRebuildContext = internalQuery({
	args: {
		world_id: v.id("worlds"),
		branch_id: v.id("branches"),
		character_id: v.id("characters"),
		thread_id: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const world = await ctx.db.get(args.world_id);
		if (!world) return null;
		const character = await ctx.db.get(args.character_id);
		if (!character) return null;
		const bibleProse = await loadBible(ctx, args.branch_id);
		const events = (await ctx.db
			.query("events")
			.withIndex("by_branch_character_thread_time", (q: any) =>
				q
					.eq("branch_id", args.branch_id)
					.eq("character_id", args.character_id)
					.eq("thread_id", args.thread_id ?? undefined),
			)
			.order("asc")
			.collect()) as Doc<"events">[];
		const last_turn = events.length > 0 ? events[events.length - 1].turn : 0;
		// Cheap signature so callers can dedupe on retries.
		const source_signature = events.length
			? `${events.length}-${events[0].at}-${events[events.length - 1].at}`
			: "";
		const slim = await Promise.all(
			events.map(async (e) => ({
				kind: e.kind,
				body: e.body,
				turn: e.turn,
				location_slug: e.location_id
					? (await ctx.db.get(e.location_id))?.slug ?? null
					: null,
				npc_slug: e.npc_entity_id
					? (await ctx.db.get(e.npc_entity_id))?.slug ?? null
					: null,
			})),
		);
		return {
			bible: bibleProse.bible,
			voice_samples: bibleProse.voice_samples,
			voice_avoid: bibleProse.voice_avoid,
			character_name: character.pseudonym ?? character.name,
			events: slim,
			last_turn,
			source_signature,
		};
	},
});

export const loadDeltaContext = internalQuery({
	args: {
		world_id: v.id("worlds"),
		branch_id: v.id("branches"),
		character_id: v.id("characters"),
		thread_id: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const summaries = await loadLatestSummaries(ctx, {
			branch_id: args.branch_id,
			character_id: args.character_id,
			thread_id: args.thread_id,
		});
		const sinceTurn = summaries?.rebuild?.covers_until_turn ?? -1;
		const all = (await ctx.db
			.query("events")
			.withIndex("by_branch_character_thread_time", (q: any) =>
				q
					.eq("branch_id", args.branch_id)
					.eq("character_id", args.character_id)
					.eq("thread_id", args.thread_id ?? undefined),
			)
			.order("asc")
			.collect()) as Doc<"events">[];
		const events = all.filter((e) => e.turn > sinceTurn);
		const last_turn = events.length > 0 ? events[events.length - 1].turn : 0;
		const bibleProse = await loadBible(ctx, args.branch_id);
		const slim = await Promise.all(
			events.map(async (e) => ({
				kind: e.kind,
				body: e.body,
				turn: e.turn,
				location_slug: e.location_id
					? (await ctx.db.get(e.location_id))?.slug ?? null
					: null,
				npc_slug: e.npc_entity_id
					? (await ctx.db.get(e.npc_entity_id))?.slug ?? null
					: null,
			})),
		);
		return {
			voice_samples: bibleProse.voice_samples,
			voice_avoid: bibleProse.voice_avoid,
			prior_summary: summaries?.rebuild?.body ?? null,
			events: slim,
			last_turn,
		};
	},
});

async function loadBible(
	ctx: any,
	branch_id: Id<"branches">,
): Promise<{
	bible: BibleShape;
	voice_samples: string[];
	voice_avoid: string[];
}> {
	const fallback = { bible: {}, voice_samples: [], voice_avoid: [] };
	const bibleEntity = await ctx.db
		.query("entities")
		.withIndex("by_branch_type_slug", (q: any) =>
			q.eq("branch_id", branch_id).eq("type", "bible").eq("slug", "bible"),
		)
		.first();
	if (!bibleEntity) return fallback;
	const vrow = await ctx.db
		.query("artifact_versions")
		.withIndex("by_artifact_version", (q: any) =>
			q
				.eq("artifact_entity_id", bibleEntity._id)
				.eq("version", bibleEntity.current_version),
		)
		.first();
	if (!vrow) return fallback;
	let payload: BibleShape = {};
	try {
		payload = (await readJSONBlob<BibleShape>(ctx, vrow.blob_hash)) ?? {};
	} catch {
		return fallback;
	}
	return {
		bible: payload,
		voice_samples: Array.isArray(payload.voice_samples)
			? (payload.voice_samples as string[])
			: [],
		voice_avoid: Array.isArray(payload.voice_avoid)
			? (payload.voice_avoid as string[])
			: [],
	};
}

export const writeSummary = internalMutation({
	args: {
		world_id: v.id("worlds"),
		branch_id: v.id("branches"),
		character_id: v.id("characters"),
		thread_id: v.optional(v.string()),
		kind: v.union(v.literal("rebuild"), v.literal("delta")),
		body: v.string(),
		covers_until_turn: v.number(),
		model: v.string(),
		source_signature: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const id = await ctx.db.insert("event_summaries", {
			world_id: args.world_id,
			branch_id: args.branch_id,
			character_id: args.character_id,
			thread_id: args.thread_id,
			kind: args.kind,
			body: args.body,
			covers_until_turn: args.covers_until_turn,
			model: args.model,
			source_signature: args.source_signature,
			created_at: Date.now(),
		});
		return { _id: id };
	},
});
