// Cost ledger (spec 14). Every paid call — Anthropic, fal.ai — logs
// a cost_ledger row so owners can see spend per world per day via a
// query. Caps/enforcement are a follow-up; logging-first lets us
// measure before we decide the cap.
//
// Rates are current as of Claude 4.7 / Sonnet 4.6 / Haiku 4.5
// (April 2026). Update MODEL_RATES when Anthropic ships new pricing.

import { internalMutation, query } from "./_generated/server.js";
import { v } from "convex/values";
import { resolveMember } from "./sessions.js";
import type { Id } from "./_generated/dataModel.js";

type ModelRate = { input_per_m: number; output_per_m: number };

const MODEL_RATES: Record<string, ModelRate> = {
  // Anthropic (USD per million tokens).
  "claude-opus-4-7": { input_per_m: 15, output_per_m: 75 },
  "claude-sonnet-4-6": { input_per_m: 3, output_per_m: 15 },
  "claude-haiku-4-5-20251001": { input_per_m: 0.25, output_per_m: 1.25 },
};

// fal.ai — flat per-image estimates. Update if rates shift.
const FAL_RATES: Record<string, number> = {
  "fal-ai/flux/schnell": 0.003,
  "fal-ai/flux-pro/kontext": 0.04,
};

export type AnthropicUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

/** Turn an Anthropic response.usage into USD. Cache-read tokens are
 *  billed at 10% of input; cache-creation at 1.25× input. */
export function anthropicCostUsd(
  model: string,
  usage: AnthropicUsage | undefined | null,
): number {
  if (!usage) return 0;
  const rate = MODEL_RATES[model] ?? { input_per_m: 3, output_per_m: 15 };
  const inp = Number(usage.input_tokens ?? 0);
  const out = Number(usage.output_tokens ?? 0);
  const cacheRead = Number(usage.cache_read_input_tokens ?? 0);
  const cacheWrite = Number(usage.cache_creation_input_tokens ?? 0);
  const cost =
    (inp * rate.input_per_m +
      out * rate.output_per_m +
      cacheRead * rate.input_per_m * 0.1 +
      cacheWrite * rate.input_per_m * 1.25) /
    1_000_000;
  return Math.max(0, cost);
}

export function falCostUsd(model: string): number {
  return FAL_RATES[model] ?? 0;
}

/** Internal mutation that writes a cost_ledger row. Safe to call from
 *  actions via ctx.runMutation. Silently swallows errors (a logging
 *  failure must never block the underlying AI call). */
export const logCostUsd = internalMutation({
  args: {
    world_id: v.id("worlds"),
    branch_id: v.optional(v.id("branches")),
    user_id: v.optional(v.id("users")),
    kind: v.string(), // e.g. "anthropic:opus:expand" or "fal:schnell:scene_art"
    cost_usd: v.number(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    try {
      await ctx.db.insert("cost_ledger", {
        world_id: args.world_id,
        branch_id: args.branch_id,
        user_id: args.user_id,
        kind: args.kind,
        cost_usd: Math.max(0, Number(args.cost_usd) || 0),
        reason: args.reason,
        created_at: Date.now(),
      });
    } catch {
      /* best-effort */
    }
  },
});

/** Owner-only query — returns spend totals for the calling user's
 *  worlds over a time window. Used by the `weaver cost` CLI command
 *  and a future admin dashboard. */
export const spendSummary = query({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    since_ms: v.optional(v.number()),
  },
  handler: async (ctx, { session_token, world_slug, since_ms }) => {
    const world = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q) => q.eq("slug", world_slug))
      .first();
    if (!world) return null;
    await resolveMember(ctx, session_token, world._id);
    const cutoff = since_ms ?? Date.now() - 24 * 60 * 60 * 1000;
    const rows = await ctx.db
      .query("cost_ledger")
      .withIndex("by_world_day", (q: any) =>
        q.eq("world_id", world._id).gte("created_at", cutoff),
      )
      .collect();
    const byKind = new Map<string, { count: number; usd: number }>();
    let total = 0;
    for (const r of rows) {
      total += r.cost_usd;
      const cur = byKind.get(r.kind) ?? { count: 0, usd: 0 };
      cur.count++;
      cur.usd += r.cost_usd;
      byKind.set(r.kind, cur);
    }
    return {
      window_ms: Date.now() - cutoff,
      total_usd: total,
      total_calls: rows.length,
      by_kind: Array.from(byKind.entries())
        .map(([kind, v]) => ({ kind, count: v.count, usd_total: v.usd }))
        .sort((a, b) => b.usd_total - a.usd_total),
    };
  },
});
