// Module proposals — admin surface for prompting changes to flow
// module behavior (combat/dialogue/counter) without a code deploy.
//
// Flow (mirrors the bible-editor pattern in worlds.ts):
//   1. suggestModuleEdit   — Opus drafts override JSON + rationale
//   2. applyModuleEdit     — version-check, write module_overrides row
//   3. dismissModuleProposal — mark dismissed; row stays for audit
//
// Runtime pickup lives in convex/flows.ts `runStep` — it reads the
// latest module_overrides row for (world, module) and wires the
// values into ModuleCtx.tune / ModuleCtx.template. Off-path when
// flag.module_overrides is off.
//
// Isolation: every mutation/query resolves world_slug → world and
// checks owner_user_id === user_id. Non-owners get "forbidden"; URGENT
// rule 7 adversarial Playwright tests in apps/play/tests/isolation.spec.ts.

import { v } from "convex/values";
import Anthropic from "@anthropic-ai/sdk";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { resolveMember, resolveSession } from "./sessions.js";
import { isFeatureEnabled } from "./flags.js";
import { anthropicCostUsd } from "./cost.js";
import { appendMentorship } from "./mentorship.js";
import { validateOverride, type OverridableSlot } from "@weaver/engine/flows";
import { counterModule } from "./modules/counter.js";
import { dialogueModule } from "./modules/dialogue.js";
import { combatModule } from "./modules/combat.js";
import type { Doc, Id } from "./_generated/dataModel.js";

// Kept in sync with convex/flows.ts MODULES. Imported directly so the
// proposal surface can list override schemas without a runtime flow.
const MODULES_FOR_PROPOSALS = {
  counter: counterModule,
  dialogue: dialogueModule,
  combat: combatModule,
} as const;

const MODULE_PROPOSAL_MODEL = "claude-opus-4-7";

const MODULE_PROPOSAL_SYSTEM_PROMPT = `You help a family tune a Weaver game module by proposing changes to its declared override slots. You are NOT writing code — you are only choosing new values for declared tunables.

Respond with strict JSON only:

{
  "suggested_overrides": { "<slot_key>": <new_value>, ... },
  "rationale": "<one short paragraph explaining what you changed and why>"
}

Rules:
- Only include slots you actually want to change. Unchanged slots MUST be omitted.
- Each value must match the slot's declared kind:
    * number  → a number within any declared [min, max]
    * string  → a plain string (respecting max_len if set)
    * template → a string using only the declared {{placeholders}}
    * boolean → true or false
- For template slots, reuse existing {{placeholders}} exactly; don't invent new ones.
- Keep the family's voice; err on the side of small, tasteful changes.
- If the feedback asks for something impossible with the declared slots (e.g. new step logic), put that in rationale and return suggested_overrides: {}.
- Do not respond with code, markdown, or commentary — JSON only.`;

function slotsForModule(module_name: string): Record<string, OverridableSlot> {
  const mod = (MODULES_FOR_PROPOSALS as any)[module_name];
  if (!mod) throw new Error(`unknown module: ${module_name}`);
  return (mod.overridable as Record<string, OverridableSlot>) ?? {};
}

async function loadWorldAsOwner(
  ctx: any,
  session_token: string,
  world_slug: string,
): Promise<{ world: Doc<"worlds">; user: Doc<"users">; user_id: Id<"users"> }> {
  const world = (await ctx.db
    .query("worlds")
    .withIndex("by_slug", (q: any) => q.eq("slug", world_slug))
    .first()) as Doc<"worlds"> | null;
  if (!world) throw new Error(`world not found: ${world_slug}`);
  const { user_id, user } = await resolveMember(ctx, session_token, world._id);
  if (world.owner_user_id !== user_id)
    throw new Error("forbidden: module proposals are owner-only");
  return { world, user, user_id };
}

// --------------------------------------------------------------------
// Queries

/** List every module's declared overridable slots + the current
 *  overrides for this world (if any). The admin UI renders this
 *  directly; no second round-trip needed. */
export const listModules = query({
  args: { session_token: v.string(), world_slug: v.string() },
  handler: async (ctx, { session_token, world_slug }) => {
    const { world } = await loadWorldAsOwner(ctx, session_token, world_slug);
    const currentByModule: Record<
      string,
      { overrides: Record<string, unknown>; version: number }
    > = {};
    for (const module_name of Object.keys(MODULES_FOR_PROPOSALS)) {
      const row = await ctx.db
        .query("module_overrides")
        .withIndex("by_world_module", (q: any) =>
          q.eq("world_id", world._id).eq("module_name", module_name),
        )
        .first();
      currentByModule[module_name] = {
        overrides: (row?.overrides_json as Record<string, unknown>) ?? {},
        version: row?.version ?? 0,
      };
    }
    const modules = Object.entries(MODULES_FOR_PROPOSALS).map(
      ([name, mod]) => ({
        name,
        schema_version: mod.schema_version,
        slots: mod.overridable ?? {},
        current: currentByModule[name].overrides,
        version: currentByModule[name].version,
      }),
    );
    return { world_id: world._id, modules };
  },
});

/** List proposals for a world (optionally filtered to one module).
 *  Ordered newest-first. */
export const listProposals = query({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    module_name: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { session_token, world_slug, module_name, limit },
  ) => {
    const { world } = await loadWorldAsOwner(ctx, session_token, world_slug);
    const rows = module_name
      ? await ctx.db
          .query("module_proposals")
          .withIndex("by_world_module_time", (q: any) =>
            q.eq("world_id", world._id).eq("module_name", module_name),
          )
          .collect()
      : await ctx.db
          .query("module_proposals")
          .withIndex("by_world_status", (q: any) => q.eq("world_id", world._id))
          .collect();
    rows.sort((a: any, b: any) => b.created_at - a.created_at);
    return rows.slice(0, limit ?? 50).map((r: any) => ({
      _id: r._id,
      module_name: r.module_name,
      feedback_text: r.feedback_text,
      current_overrides_snapshot: r.current_overrides_snapshot,
      suggested_overrides: r.suggested_overrides,
      rationale: r.rationale,
      expected_version: r.expected_version,
      status: r.status,
      applied_at: r.applied_at ?? null,
      applied_version: r.applied_version ?? null,
      created_at: r.created_at,
    }));
  },
});

// --------------------------------------------------------------------
// Suggest (action — calls Opus)

export const suggestModuleEdit = action({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    module_name: v.string(),
    feedback: v.string(),
  },
  handler: async (
    ctx,
    { session_token, world_slug, module_name, feedback },
  ): Promise<{
    proposal_id: Id<"module_proposals">;
    module_name: string;
    current_overrides: Record<string, unknown>;
    suggested_overrides: Record<string, unknown>;
    rationale: string;
    current_version: number;
    slots: Record<string, OverridableSlot>;
  }> => {
    const trimmed = feedback.trim();
    if (trimmed.length < 4) throw new Error("feedback too short");
    if (trimmed.length > 1500) throw new Error("feedback too long");
    const slots = slotsForModule(module_name);

    const info = await ctx.runQuery(internal.module_proposals.loadSuggestContext, {
      session_token,
      world_slug,
      module_name,
    });

    if (!info.flag_on)
      throw new Error(
        "flag.module_overrides is off for this world; ask the owner to enable it before proposing",
      );

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: MODULE_PROPOSAL_MODEL,
      max_tokens: 3000,
      system: [{ type: "text", text: MODULE_PROPOSAL_SYSTEM_PROMPT }],
      messages: [
        {
          role: "user",
          content: `<module_name>${module_name}</module_name>\n<declared_slots>\n${JSON.stringify(
            slots,
            null,
            2,
          )}\n</declared_slots>\n\n<current_overrides>\n${JSON.stringify(
            info.current_overrides,
            null,
            2,
          )}\n</current_overrides>\n\n<feedback>${trimmed}</feedback>\n\nRespond with strict JSON only.`,
        },
      ],
    });

    await ctx.runMutation(internal.cost.logCostUsd, {
      world_id: info.world_id,
      kind: `anthropic:opus:module_proposal:${module_name}`,
      cost_usd: anthropicCostUsd(
        MODULE_PROPOSAL_MODEL,
        response.usage as any,
      ),
      reason: `module proposal (${module_name})`,
    });

    const text = response.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("")
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "");
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch (e: any) {
      throw new Error(`module proposal JSON parse failed: ${e?.message ?? e}`);
    }
    const suggested = parsed?.suggested_overrides;
    if (!suggested || typeof suggested !== "object" || Array.isArray(suggested))
      throw new Error("response missing suggested_overrides object");

    // Server-side validation — drop or error on anything that doesn't
    // match a declared slot. Keep the filtered set strict so the admin
    // UI + apply path never sees bogus keys.
    const validated: Record<string, unknown> = {};
    const rejected: Array<{ key: string; reason: string }> = [];
    for (const [k, v] of Object.entries(suggested)) {
      const slot = slots[k];
      if (!slot) {
        rejected.push({ key: k, reason: "not a declared slot" });
        continue;
      }
      const err = validateOverride(slot, v);
      if (err) {
        rejected.push({ key: k, reason: err });
        continue;
      }
      validated[k] = v;
    }

    const proposal_id = await ctx.runMutation(
      internal.module_proposals.writeProposal,
      {
        world_id: info.world_id,
        module_name,
        feedback_text: trimmed,
        current_overrides_snapshot: info.current_overrides,
        suggested_overrides: validated,
        rationale:
          String(parsed?.rationale ?? "") +
          (rejected.length > 0
            ? `\n\n(Dropped ${rejected.length} invalid overrides: ${rejected
                .map((r) => `${r.key} — ${r.reason}`)
                .join("; ")})`
            : ""),
        expected_version: info.current_version,
        author_user_id: info.user_id,
      },
    );

    return {
      proposal_id,
      module_name,
      current_overrides: info.current_overrides,
      suggested_overrides: validated,
      rationale: String(parsed?.rationale ?? ""),
      current_version: info.current_version,
      slots,
    };
  },
});

export const loadSuggestContext = internalQuery({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    module_name: v.string(),
  },
  handler: async (ctx, { session_token, world_slug, module_name }) => {
    const { world, user_id } = await loadWorldAsOwner(
      ctx,
      session_token,
      world_slug,
    );
    const flag_on = await isFeatureEnabled(ctx, "flag.module_overrides", {
      world_id: world._id,
      user_id,
    });
    const row = await ctx.db
      .query("module_overrides")
      .withIndex("by_world_module", (q: any) =>
        q.eq("world_id", world._id).eq("module_name", module_name),
      )
      .first();
    return {
      world_id: world._id,
      user_id,
      flag_on,
      current_overrides:
        (row?.overrides_json as Record<string, unknown>) ?? {},
      current_version: row?.version ?? 0,
    };
  },
});

// --------------------------------------------------------------------
// Write proposal row (internal helper; suggest uses it)

export const writeProposal = internalMutation({
  args: {
    world_id: v.id("worlds"),
    module_name: v.string(),
    feedback_text: v.string(),
    current_overrides_snapshot: v.any(),
    suggested_overrides: v.any(),
    rationale: v.string(),
    expected_version: v.number(),
    author_user_id: v.id("users"),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.db.insert("module_proposals", {
      world_id: args.world_id,
      module_name: args.module_name,
      feedback_text: args.feedback_text,
      current_overrides_snapshot: args.current_overrides_snapshot,
      suggested_overrides: args.suggested_overrides,
      rationale: args.rationale,
      expected_version: args.expected_version,
      status: "draft",
      author_user_id: args.author_user_id,
      created_at: now,
      updated_at: now,
    });
  },
});

// --------------------------------------------------------------------
// Apply

export const applyModuleEdit = mutation({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    proposal_id: v.id("module_proposals"),
  },
  handler: async (ctx, { session_token, world_slug, proposal_id }) => {
    const { world, user, user_id } = await loadWorldAsOwner(
      ctx,
      session_token,
      world_slug,
    );

    // Require the flag to stay on at apply time — owner may have turned
    // it off between suggest and apply, and we want a single seam.
    const flag_on = await isFeatureEnabled(ctx, "flag.module_overrides", {
      world_id: world._id,
      user_id,
    });
    if (!flag_on)
      throw new Error(
        "flag.module_overrides is off for this world; enable it before applying",
      );

    const proposal = await ctx.db.get(proposal_id);
    if (!proposal) throw new Error("proposal not found");
    if (proposal.world_id !== world._id)
      throw new Error("forbidden: proposal belongs to another world");
    if (proposal.status !== "draft")
      throw new Error(`proposal is already ${proposal.status}`);

    const slots = slotsForModule(proposal.module_name);
    const suggested = proposal.suggested_overrides as Record<string, unknown>;

    // Re-validate at apply time. suggested_overrides went through
    // validation at suggest time, but a schema evolution or a hand-
    // edited row could drift — belt-and-braces.
    for (const [k, val] of Object.entries(suggested)) {
      const slot = slots[k];
      if (!slot) throw new Error(`apply rejected: "${k}" not a declared slot`);
      const err = validateOverride(slot, val);
      if (err) throw new Error(`apply rejected: "${k}" — ${err}`);
    }

    // Version check (optimistic concurrency). Current version beats
    // the proposal's expected only when someone else applied a
    // proposal in between.
    const existing = await ctx.db
      .query("module_overrides")
      .withIndex("by_world_module", (q: any) =>
        q.eq("world_id", world._id).eq("module_name", proposal.module_name),
      )
      .first();
    const currentVersion = existing?.version ?? 0;
    if (currentVersion !== proposal.expected_version) {
      throw new Error(
        `module_overrides version changed (saw v${currentVersion}, expected v${proposal.expected_version}); re-suggest against the latest state`,
      );
    }

    const priorOverrides =
      (existing?.overrides_json as Record<string, unknown>) ?? {};
    const merged = { ...priorOverrides };
    for (const [k, val] of Object.entries(suggested)) {
      merged[k] = val;
    }
    const nextVersion = currentVersion + 1;
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        overrides_json: merged,
        version: nextVersion,
        updated_by_user_id: user_id,
        updated_at: now,
      });
    } else {
      await ctx.db.insert("module_overrides", {
        world_id: world._id,
        module_name: proposal.module_name,
        overrides_json: merged,
        version: nextVersion,
        updated_by_user_id: user_id,
        updated_at: now,
      });
    }
    await ctx.db.patch(proposal_id, {
      status: "applied",
      applied_at: now,
      applied_version: nextVersion,
      applied_by_user_id: user_id,
      updated_at: now,
    });

    await appendMentorship(ctx, {
      world_id: world._id,
      user_id,
      scope: `module.apply.${proposal.module_name}`,
      context: {
        proposal_id,
        expected_version: proposal.expected_version,
        module_name: proposal.module_name,
      },
      human_action: {
        accepted: true,
        new_version: nextVersion,
        feedback: proposal.feedback_text,
      },
      before: priorOverrides,
      after: merged,
    });

    return { version: nextVersion, module_name: proposal.module_name };
  },
});

// --------------------------------------------------------------------
// Dismiss

export const dismissModuleProposal = mutation({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    proposal_id: v.id("module_proposals"),
  },
  handler: async (ctx, { session_token, world_slug, proposal_id }) => {
    const { world } = await loadWorldAsOwner(ctx, session_token, world_slug);
    const proposal = await ctx.db.get(proposal_id);
    if (!proposal) throw new Error("proposal not found");
    if (proposal.world_id !== world._id)
      throw new Error("forbidden: proposal belongs to another world");
    if (proposal.status !== "draft")
      throw new Error(`cannot dismiss: proposal is ${proposal.status}`);
    await ctx.db.patch(proposal_id, {
      status: "dismissed",
      updated_at: Date.now(),
    });
    return { ok: true };
  },
});
