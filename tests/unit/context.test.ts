// Pure-logic tests for the tiered prompt assembler. No Convex, no
// network — just the budgeting + policy + assembly shape.

import { describe, expect, it } from "vitest";
import {
	CALL_SITE_POLICY,
	MODEL_IDS,
	MODEL_INPUT_BUDGET,
	assemblePrompt,
	estimateTokens,
	fitVerbatim,
	tierFor,
	type ContextEvent,
} from "@weaver/engine/context";

describe("tierFor", () => {
	it("maps standard call sites to expected tiers", () => {
		expect(tierFor("narrate")).toBe("sonnet");
		expect(tierFor("dialogue")).toBe("sonnet");
		expect(tierFor("expansion")).toBe("opus");
		expect(tierFor("intent")).toBe("haiku");
	});

	it("'fast' bumps narrative call sites down", () => {
		expect(tierFor("narrate", "fast")).toBe("haiku");
		expect(tierFor("dialogue", "fast")).toBe("haiku");
		expect(tierFor("expansion", "fast")).toBe("sonnet");
		// classification stays cheap regardless
		expect(tierFor("intent", "fast")).toBe("haiku");
	});

	it("'best' bumps narrative call sites up", () => {
		expect(tierFor("narrate", "best")).toBe("opus");
		expect(tierFor("dialogue", "best")).toBe("opus");
		expect(tierFor("intent", "best")).toBe("sonnet");
	});
});

describe("estimateTokens / fitVerbatim", () => {
	it("estimates tokens at ~4 chars/token", () => {
		expect(estimateTokens("hello")).toBe(2);
		expect(estimateTokens("a".repeat(100))).toBe(25);
	});

	it("fits as many events as the budget allows, newest-first", () => {
		const events: ContextEvent[] = Array.from({ length: 10 }, (_, i) => ({
			kind: "narrate",
			body: "a".repeat(40), // ~10 tokens + 8 framing = 18 each
			salience: "medium",
			turn: 100 - i,
			at: 1000 - i,
		}));
		const fit = fitVerbatim(events, 60); // ≈3 fit
		expect(fit.kept.length).toBeGreaterThanOrEqual(2);
		expect(fit.kept.length).toBeLessThanOrEqual(4);
		expect(fit.dropped).toBe(events.length - fit.kept.length);
	});
});

describe("assemblePrompt", () => {
	const baseArgs = {
		pinned: "World: Quiet Vale. Tone: cozy.",
		task: "Reply as Mara in one sentence.",
	};

	it("emits cache_control on pinned system block", () => {
		const r = assemblePrompt({
			...baseArgs,
			call_site: "narrate",
		});
		expect(r.system[0].cache_control).toEqual({ type: "ephemeral" });
		expect(r.system[0].text).toContain("Quiet Vale");
	});

	it("uses the right model for the call site", () => {
		const narrate = assemblePrompt({ ...baseArgs, call_site: "narrate" });
		expect(narrate.model).toBe(MODEL_IDS.sonnet);
		expect(narrate.debug.tier).toBe("sonnet");
		const expansion = assemblePrompt({ ...baseArgs, call_site: "expansion" });
		expect(expansion.model).toBe(MODEL_IDS.opus);
	});

	it("respects the ai_quality toggle", () => {
		const fast = assemblePrompt({
			...baseArgs,
			call_site: "narrate",
			ai_quality: "fast",
		});
		expect(fast.model).toBe(MODEL_IDS.haiku);
		const best = assemblePrompt({
			...baseArgs,
			call_site: "narrate",
			ai_quality: "best",
		});
		expect(best.model).toBe(MODEL_IDS.opus);
	});

	it("includes summary block when policy + arg present, with cache marker", () => {
		const r = assemblePrompt({
			...baseArgs,
			call_site: "narrate",
			summary: "Earlier: the player saved the cat from the well.",
		});
		const summaryBlock = r.messages[0].content.find((b) =>
			b.text.includes("<summary>"),
		);
		expect(summaryBlock).toBeDefined();
		expect(summaryBlock!.cache_control).toEqual({ type: "ephemeral" });
	});

	it("renders verbatim events oldest-first within the slab", () => {
		const verbatim: ContextEvent[] = [
			{
				kind: "dialogue",
				body: "newest line",
				salience: "high",
				turn: 10,
				at: 100,
				npc_slug: "mara",
			},
			{
				kind: "narrate",
				body: "older line",
				salience: "medium",
				turn: 9,
				at: 99,
			},
		];
		const r = assemblePrompt({
			...baseArgs,
			call_site: "narrate",
			verbatim,
		});
		const recent = r.messages[0].content.find((b) =>
			b.text.includes("<recent_events>"),
		);
		expect(recent).toBeDefined();
		const olderIdx = recent!.text.indexOf("older line");
		const newerIdx = recent!.text.indexOf("newest line");
		expect(olderIdx).toBeGreaterThan(-1);
		expect(newerIdx).toBeGreaterThan(olderIdx);
	});

	it("respects policy.verbatim_count cap", () => {
		const verbatim: ContextEvent[] = Array.from({ length: 30 }, (_, i) => ({
			kind: "narrate",
			body: `line ${i}`,
			salience: "low",
			turn: 100 - i,
			at: 1000 - i,
		}));
		const r = assemblePrompt({
			...baseArgs,
			call_site: "narrate", // verbatim_count = 6
			verbatim,
		});
		expect(r.debug.verbatim_count).toBe(CALL_SITE_POLICY.narrate.verbatim_count);
	});

	it("skips verbatim+summary for icon_prompt", () => {
		const r = assemblePrompt({
			...baseArgs,
			call_site: "icon_prompt",
			verbatim: [
				{
					kind: "narrate",
					body: "shouldn't appear",
					salience: "high",
					turn: 1,
					at: 1,
				},
			],
			summary: "shouldn't appear either",
		});
		expect(
			r.messages[0].content.find((b) => b.text.includes("recent_events")),
		).toBeUndefined();
		expect(
			r.messages[0].content.find((b) => b.text.includes("summary")),
		).toBeUndefined();
	});

	it("throws when total tokens exceed model budget", () => {
		const huge = "x".repeat(900_000); // ~225K tokens
		expect(() =>
			assemblePrompt({
				pinned: huge,
				task: "x",
				call_site: "narrate", // Sonnet, 800k budget
			}),
		).not.toThrow(); // 225K fits in Sonnet
		expect(() =>
			assemblePrompt({
				pinned: huge,
				task: "x",
				call_site: "intent", // Haiku, 160k budget
			}),
		).toThrow(/budget/);
	});
});

describe("MODEL_INPUT_BUDGET", () => {
	it("haiku budget is well below 200K", () => {
		expect(MODEL_INPUT_BUDGET.haiku).toBeLessThanOrEqual(200_000);
	});
	it("sonnet + opus budgets are below 1M", () => {
		expect(MODEL_INPUT_BUDGET.sonnet).toBeLessThanOrEqual(1_000_000);
		expect(MODEL_INPUT_BUDGET.opus).toBeLessThanOrEqual(1_000_000);
	});
});
