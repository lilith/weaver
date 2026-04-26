// Tiered prompt assembler — the single shape every Opus/Sonnet/Haiku
// call goes through. Three layers:
//
//   pinned     bible facts + character bio + hard taboos. Same on
//              every turn. Behind anthropic.cache_control so the
//              first prompt is the only one paying for these tokens.
//
//   verbatim   the K most recent reading-log entries the player saw
//              (filtered to whatever shape the call needs — events
//              at this location, with this NPC, etc.). Tail of the
//              prompt; invalidates the cache from the last verbatim
//              boundary onward.
//
//   summary    everything older than verbatim, folded into a running
//              salience-weighted summary by Haiku at quiet moments.
//              Per-thread for timeline sims; globally per-character
//              otherwise. Cheap to recompute, stable across turns
//              between compactions.
//
// This file is pure logic — no Convex, no network. It defines the
// shapes + the budgeting + the per-call-site presets. Convex code
// (in convex/context.ts) reads slabs from the events table and feeds
// them in. Anthropic action code calls assemblePrompt(...) and pipes
// the result into anthropic.messages.create.

// Models we know about. Mirrors convex/cost.ts MODEL_RATES + the
// tiered toggle (fast / standard / best).
export type ModelTier = "haiku" | "sonnet" | "opus";

export const MODEL_IDS: Record<ModelTier, string> = {
	haiku: "claude-haiku-4-5-20251001",
	sonnet: "claude-sonnet-4-6",
	opus: "claude-opus-4-7",
};

/** Hard input-token caps for each model — assembler refuses to assemble
 *  a prompt larger than this. Numbers are conservative leave-room-for-
 *  output: actual context is 200K (haiku) / 1M (sonnet+opus) but we
 *  budget 80% of it to leave space for max_output. */
export const MODEL_INPUT_BUDGET: Record<ModelTier, number> = {
	haiku: 160_000, // of 200k
	sonnet: 800_000, // of 1M
	opus: 800_000, // of 1M
};

/** Cost-per-million input tokens. For budget warnings only. */
export const MODEL_INPUT_PRICE: Record<ModelTier, number> = {
	haiku: 1,
	sonnet: 3,
	opus: 5,
};

// --------------------------------------------------------------------
// Prompt building blocks

/** A single event in the reading log — the shape the assembler reads.
 *  Mirrors convex/events row but UI-side. */
export type ContextEvent = {
	kind: string;
	body: string;
	salience: "low" | "medium" | "high";
	turn: number;
	at: number;
	location_slug?: string | null;
	npc_slug?: string | null;
	item_slug?: string | null;
	thread_id?: string | null;
};

/** What the assembler returns — the caller passes `system` and
 *  `messages` straight to anthropic.messages.create. Cache breakpoints
 *  live INSIDE the system+user blocks via anthropic's content-array
 *  cache_control marker. */
export type AssembledPrompt = {
	model: string;
	max_tokens: number;
	temperature: number;
	system: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }>;
	messages: Array<{
		role: "user" | "assistant";
		content: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }>;
	}>;
	// Diagnostic: what the assembler put where, so logs make sense.
	debug: {
		tier: ModelTier;
		pinned_chars: number;
		verbatim_count: number;
		summary_chars: number;
		estimated_tokens: number;
	};
};

// --------------------------------------------------------------------
// Voice / style prelude — the anti-business-doc lever.
//
// Default bans: phrases that pattern-match AI-summary voice. Specific
// bans beat abstract "tone descriptors" — "no 'a sense of unease'"
// works; "be more vivid" doesn't. Worlds extend with their own bans
// via bible.voice_avoid.

export const DEFAULT_VOICE_BANS: readonly string[] = [
	"no bullet lists",
	"no headers",
	"no markdown",
	'no "meanwhile"',
	'no "as you contemplate" or similar self-aware narrator phrasing',
	'no "a sense of unease" or other AI-summary mood phrases',
	"no parenthetical exposition (... ) — let the world speak",
	"no closing summaries",
	"no second-person therapy-speak (\"you feel...\", \"a part of you...\")",
] as const;

export const POSITIVE_VOICE_FRAME = `Write as someone who lives in this world. Describe what hands and eyes do, not what feelings exist. Specific objects beat abstract atmosphere. Trust silence — short sentences when the moment calls for it.`;

export type BibleShape = {
	name?: string;
	tagline?: string;
	tone?: { descriptors?: string[]; avoid?: string[] };
	established_facts?: string[];
	prose_sample?: string;
	voice_samples?: string[]; // hand-written in-voice paragraphs
	voice_avoid?: string[]; // world-specific bans (extends DEFAULT_VOICE_BANS)
	[k: string]: unknown;
};

/** Render the world bible as flowing prose for the prompt — strips
 *  JSON shape so the model doesn't mirror business-document structure
 *  in its output. Storage stays JSON; this is a presentation
 *  transformer, like stat_schema.
 *
 *  Order: identity sentence → tone sentence → established facts as a
 *  short paragraph → prose_sample if present (verbatim, the world's
 *  own voice). Established facts join with "; " into one paragraph
 *  rather than a list, deliberately. */
export function renderBibleAsProse(bible: BibleShape | null | undefined): string {
	if (!bible) return "";
	const parts: string[] = [];
	if (bible.name) {
		const id = bible.tagline
			? `${bible.name}. ${bible.tagline}.`
			: `${bible.name}.`;
		parts.push(id);
	}
	const tone = bible.tone;
	if (tone?.descriptors?.length) {
		parts.push(`Tone: ${tone.descriptors.join(", ")}.`);
	}
	if (bible.established_facts?.length) {
		parts.push(bible.established_facts.join("; ") + ".");
	}
	if (typeof bible.prose_sample === "string" && bible.prose_sample.trim()) {
		parts.push(bible.prose_sample.trim());
	}
	return parts.join("\n\n").trim();
}

/** Build the style prelude — anti-summary frame + voice samples + the
 *  world's "avoid" list. Returns one block for the system prompt;
 *  returns "" when style would just be noise (intent classification,
 *  icon prompt, schema design — see CALL_SITE_USES_STYLE). */
export function renderStylePrelude(opts: {
	voice_samples?: string[];
	voice_avoid?: string[];
}): string {
	const lines: string[] = [];
	lines.push(POSITIVE_VOICE_FRAME);
	const bans = [...DEFAULT_VOICE_BANS, ...(opts.voice_avoid ?? [])];
	if (bans.length > 0) {
		lines.push("Banned, always:");
		for (const b of bans) lines.push(`  - ${b}`);
	}
	if (opts.voice_samples?.length) {
		lines.push("Voice samples — write in this register, not summaries of it:");
		for (const s of opts.voice_samples) {
			const t = s.trim();
			if (t.length > 0) lines.push(`  «${t}»`);
		}
	}
	return lines.join("\n");
}

/** Which call sites benefit from the voice prelude. Intent / icon /
 *  schema_design are all "give me JSON" tasks where the prelude would
 *  hurt by suggesting prose output. haiku_summarize gets it because
 *  the WHOLE point of in-voice compaction is to write in the world's
 *  register, not extract bullet points. */
export const CALL_SITE_USES_STYLE: Record<PromptCallSite, boolean> = {
	narrate: true,
	dialogue: true,
	expansion: true,
	intent: false,
	icon_prompt: false,
	schema_design: false,
	narrate_effect: true,
	haiku_summarize: true,
};

// --------------------------------------------------------------------
// Per-call-site presets

export type PromptCallSite =
	| "narrate" // module step ctx.narrate — NPC voice
	| "dialogue" // long-form NPC conversation
	| "expansion" // free-text "weave" → new location
	| "intent" // classify a player input
	| "icon_prompt" // atlas landmark icon prompt
	| "schema_design" // bible / stat-schema / module proposals
	| "narrate_effect" // narrate effect from option-pick
	| "haiku_summarize"; // events → running summary

/** Tier mapping per (call_site, ai_quality). The toggle is small: we
 *  bump narrative call sites up; classification stays cheap regardless. */
export function tierFor(
	call_site: PromptCallSite,
	ai_quality: "fast" | "standard" | "best" = "standard",
): ModelTier {
	const base: Record<PromptCallSite, ModelTier> = {
		narrate: "sonnet",
		dialogue: "sonnet",
		expansion: "opus",
		intent: "haiku",
		icon_prompt: "haiku",
		schema_design: "opus",
		narrate_effect: "sonnet",
		haiku_summarize: "haiku",
	};
	const quality_shift: Record<
		"fast" | "standard" | "best",
		Partial<Record<PromptCallSite, ModelTier>>
	> = {
		fast: {
			narrate: "haiku",
			dialogue: "haiku",
			narrate_effect: "haiku",
			expansion: "sonnet",
			schema_design: "sonnet",
		},
		standard: {},
		best: {
			narrate: "opus",
			dialogue: "opus",
			intent: "sonnet",
			icon_prompt: "sonnet",
			narrate_effect: "opus",
		},
	};
	return quality_shift[ai_quality][call_site] ?? base[call_site];
}

/** How much verbatim history each call site actually wants. Larger
 *  isn't always better — narrate calls care about the last 6 lines;
 *  expansion cares about the parent location's prior visits. */
export type CallSitePolicy = {
	verbatim_count: number;
	include_npc_memory: boolean;
	include_summary: boolean;
	temperature: number;
	max_output_tokens: number;
};

export const CALL_SITE_POLICY: Record<PromptCallSite, CallSitePolicy> = {
	narrate: {
		verbatim_count: 6,
		include_npc_memory: true,
		include_summary: true,
		temperature: 0.9,
		max_output_tokens: 256,
	},
	dialogue: {
		verbatim_count: 12,
		include_npc_memory: true,
		include_summary: true,
		temperature: 0.85,
		max_output_tokens: 400,
	},
	expansion: {
		verbatim_count: 3,
		include_npc_memory: false,
		include_summary: true,
		temperature: 0.95,
		max_output_tokens: 1500,
	},
	intent: {
		verbatim_count: 2,
		include_npc_memory: false,
		include_summary: false,
		temperature: 0.2,
		max_output_tokens: 200,
	},
	icon_prompt: {
		verbatim_count: 0,
		include_npc_memory: false,
		include_summary: false,
		temperature: 0.7,
		max_output_tokens: 400,
	},
	schema_design: {
		verbatim_count: 0,
		include_npc_memory: false,
		include_summary: false,
		temperature: 0.4,
		max_output_tokens: 3000,
	},
	narrate_effect: {
		verbatim_count: 4,
		include_npc_memory: false,
		include_summary: true,
		temperature: 0.85,
		max_output_tokens: 200,
	},
	haiku_summarize: {
		verbatim_count: 30, // the assembler feeds 30 raw events to fold
		include_npc_memory: false,
		include_summary: true, // prior summary is the seed for the new one
		temperature: 0.3,
		max_output_tokens: 800,
	},
};

// --------------------------------------------------------------------
// Token estimation — rough char-based budget. Real tokenizers vary; we
// just need a guard rail that prevents 200K input on Haiku.

/** ~4 chars per token is a reliable pessimistic estimate for English
 *  prose; Anthropic's tokenizers vary by model but this stays safe. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** Pack verbatim events into a budget. Returns the slice that fits +
 *  how many were dropped. Most-recent kept first; older ones drop
 *  before high-salience nearer ones. */
export function fitVerbatim(
	events: ContextEvent[],
	budget_tokens: number,
): { kept: ContextEvent[]; dropped: number } {
	const kept: ContextEvent[] = [];
	let used = 0;
	// events are already in newest-first order; iterate that way.
	for (const e of events) {
		const cost = estimateTokens(e.body) + 8; // 8 toks of framing
		if (used + cost > budget_tokens) break;
		kept.push(e);
		used += cost;
	}
	return { kept, dropped: events.length - kept.length };
}

// --------------------------------------------------------------------
// Assembler

export type AssembleArgs = {
	call_site: PromptCallSite;
	ai_quality?: "fast" | "standard" | "best";

	// Pinned (cache-stable). Kept as opaque strings so the engine doesn't
	// dictate format — caller composes from bible / character / taboos.
	pinned: string;

	// Per-call task — what the model is actually being asked to do.
	task: string;

	// Verbatim event log (newest-first ideally). Optional.
	verbatim?: ContextEvent[];

	// Compressed running summary (newest-thread-first ok). Optional.
	summary?: string;

	// NPC memory excerpt — already-assembled bullet list or paragraph.
	// Optional; only used when policy.include_npc_memory is true.
	npc_memory?: string;

	// In-voice paragraphs the model imitates. Pinned (cache-stable)
	// alongside the bible. The single biggest lever against AI-summary
	// voice; ignored on intent/icon/schema_design call sites where
	// prose output would be wrong.
	voice_samples?: string[];

	// World-specific banned phrases, extending DEFAULT_VOICE_BANS.
	voice_avoid?: string[];
};

/** The single seam every AI call goes through. Returns an
 *  AssembledPrompt that's pipeable straight into anthropic.messages.
 *
 *  Cache_control breakpoints:
 *    - end of system text  (pinned facts)
 *    - end of summary block (stable across turns between compactions)
 *  Verbatim + task always invalidate per call. */
export function assemblePrompt(args: AssembleArgs): AssembledPrompt {
	const ai_quality = args.ai_quality ?? "standard";
	const tier = tierFor(args.call_site, ai_quality);
	const policy = CALL_SITE_POLICY[args.call_site];
	const model = MODEL_IDS[tier];
	const budget = MODEL_INPUT_BUDGET[tier];

	// System text = style prelude + pinned. Both cache-stable so the
	// first call pays for them and every subsequent call rides the
	// 5-minute Anthropic prompt cache.
	const useStyle = CALL_SITE_USES_STYLE[args.call_site];
	const stylePrelude = useStyle
		? renderStylePrelude({
				voice_samples: args.voice_samples,
				voice_avoid: args.voice_avoid,
			})
		: "";
	const systemText = [stylePrelude, args.pinned.trim()]
		.filter((s) => s.length > 0)
		.join("\n\n");

	// User content composed in tiers. Each tier is its own content
	// block so the cache_control marker lands cleanly.
	const userBlocks: Array<{
		type: "text";
		text: string;
		cache_control?: { type: "ephemeral" };
	}> = [];

	let summaryUsed = 0;
	if (policy.include_summary && args.summary && args.summary.trim()) {
		const text = `<summary>\n${args.summary.trim()}\n</summary>`;
		userBlocks.push({
			type: "text",
			text,
			cache_control: { type: "ephemeral" },
		});
		summaryUsed = estimateTokens(text);
	}

	let verbatimKept: ContextEvent[] = [];
	if (policy.verbatim_count > 0 && args.verbatim && args.verbatim.length > 0) {
		// Trim to the policy count first, then to the budget.
		const slice = args.verbatim.slice(0, policy.verbatim_count);
		const remaining = budget - estimateTokens(systemText) - summaryUsed - 2000;
		const fit = fitVerbatim(slice, Math.max(2000, remaining));
		verbatimKept = fit.kept;
		if (verbatimKept.length > 0) {
			const lines = verbatimKept
				.slice()
				.reverse() // oldest-first within the kept slab reads more naturally
				.map((e) => {
					const tags: string[] = [];
					if (e.location_slug) tags.push(`@${e.location_slug}`);
					if (e.npc_slug) tags.push(`with:${e.npc_slug}`);
					if (e.item_slug) tags.push(`item:${e.item_slug}`);
					if (e.thread_id) tags.push(`thread:${e.thread_id}`);
					const tagstr = tags.length > 0 ? ` (${tags.join(", ")})` : "";
					return `[t${e.turn} ${e.kind}${tagstr}] ${e.body}`;
				})
				.join("\n");
			userBlocks.push({
				type: "text",
				text: `<recent_events>\n${lines}\n</recent_events>`,
			});
		}
	}

	if (policy.include_npc_memory && args.npc_memory && args.npc_memory.trim()) {
		userBlocks.push({
			type: "text",
			text: `<npc_memory>\n${args.npc_memory.trim()}\n</npc_memory>`,
		});
	}

	// Task — always last, never cached.
	userBlocks.push({
		type: "text",
		text: args.task.trim(),
	});

	// Estimate.
	const estimated_tokens =
		estimateTokens(systemText) +
		userBlocks.reduce((s, b) => s + estimateTokens(b.text), 0);

	if (estimated_tokens > budget) {
		throw new Error(
			`assemblePrompt: estimated ${estimated_tokens} tokens > budget ${budget} for ${tier}; tighten verbatim or summary`,
		);
	}

	return {
		model,
		max_tokens: policy.max_output_tokens,
		temperature: policy.temperature,
		system: [
			{
				type: "text",
				text: systemText,
				cache_control: { type: "ephemeral" },
			},
		],
		messages: [{ role: "user", content: userBlocks }],
		debug: {
			tier,
			pinned_chars: systemText.length,
			verbatim_count: verbatimKept.length,
			summary_chars: args.summary?.length ?? 0,
			estimated_tokens,
		},
	};
}
