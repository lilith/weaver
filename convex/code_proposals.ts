// Code-change proposals — owner writes feedback, Opus drafts a plan,
// owner opens a GitHub issue assigned to lilith. No runtime code exec;
// the issue is the hand-off. See spec/MODULE_AND_CODE_PROPOSALS.md.
//
// Env (Convex deployment env, not .env):
//   GITHUB_REPO      default "lilith/weaver"
//   GITHUB_REPO_PAT  fine-grained PAT with `issues: write` on the repo
//
// Flag: flag.code_proposals — default off. Actions throw when off.

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
import { resolveMember } from "./sessions.js";
import { isFeatureEnabled } from "./flags.js";
import { anthropicCostUsd } from "./cost.js";
import { appendMentorship } from "./mentorship.js";
import type { Doc, Id } from "./_generated/dataModel.js";

const CODE_PROPOSAL_MODEL = "claude-opus-4-7";

const CODE_PROPOSAL_SYSTEM_PROMPT = `You help a family plan a code change to Weaver (a browser-based AI-assisted world-building game). You are drafting a PLAN, not code. A human (or a code-writing agent) will implement the plan later via a normal GitHub PR.

Respond with strict JSON only, matching this exact shape:

{
  "title": "<short imperative PR-style title, ≤ 72 chars>",
  "summary": "<2-4 sentences: what + why, in the family's voice>",
  "rationale": "<1 paragraph: what user experience this enables; any trade-offs; what to watch for>",
  "suggested_changes": [
    { "file": "<path like convex/modules/combat.ts>", "what": "<one-line description of the edit>" },
    ...
  ],
  "new_tests": [ "<short test name>", ... ],
  "open_questions": [ "<questions for the human implementer>", ... ],
  "estimated_size": "small" | "medium" | "large"
}

Rules:
- Only touch files you're confident exist. If uncertain, say so in open_questions.
- Keep the plan minimal — one coherent change, not a grab-bag.
- Prefer module overrides over code changes when the feedback is purely tuning; note this in rationale and return suggested_changes: [] if so.
- For new step logic / new effect kinds / new admin surfaces, code changes ARE needed — plan them.
- No code blocks. No markdown. Just JSON.`;

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
    throw new Error("forbidden: code proposals are owner-only");
  return { world, user, user_id };
}

// --------------------------------------------------------------------
// Queries

export const listProposals = query({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { session_token, world_slug, limit }) => {
    const { world } = await loadWorldAsOwner(ctx, session_token, world_slug);
    const rows = await ctx.db
      .query("code_proposals")
      .withIndex("by_world_time", (q: any) => q.eq("world_id", world._id))
      .collect();
    rows.sort((a: any, b: any) => b.created_at - a.created_at);
    return rows.slice(0, limit ?? 30).map((r: any) => ({
      _id: r._id,
      feedback_text: r.feedback_text,
      plan_json: r.plan_json,
      status: r.status,
      github_issue_number: r.github_issue_number ?? null,
      github_issue_url: r.github_issue_url ?? null,
      github_issue_created_at: r.github_issue_created_at ?? null,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
  },
});

// --------------------------------------------------------------------
// Suggest — Opus drafts a plan

export const suggestCodeChange = action({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    feedback: v.string(),
  },
  handler: async (
    ctx,
    { session_token, world_slug, feedback },
  ): Promise<{
    proposal_id: Id<"code_proposals">;
    plan: any;
  }> => {
    const trimmed = feedback.trim();
    if (trimmed.length < 4) throw new Error("feedback too short");
    if (trimmed.length > 2500) throw new Error("feedback too long");

    const info = await ctx.runQuery(
      internal.code_proposals.loadCodeProposalContext,
      { session_token, world_slug },
    );

    if (!info.flag_on)
      throw new Error(
        "flag.code_proposals is off for this world; ask the owner to enable it",
      );

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: CODE_PROPOSAL_MODEL,
      max_tokens: 3000,
      system: [{ type: "text", text: CODE_PROPOSAL_SYSTEM_PROMPT }],
      messages: [
        {
          role: "user",
          content: `<feedback>${trimmed}</feedback>\n\nRespond with strict JSON only.`,
        },
      ],
    });

    await ctx.runMutation(internal.cost.logCostUsd, {
      world_id: info.world_id,
      kind: `anthropic:opus:code_proposal`,
      cost_usd: anthropicCostUsd(CODE_PROPOSAL_MODEL, response.usage as any),
      reason: `code proposal draft`,
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
      throw new Error(`code proposal JSON parse failed: ${e?.message ?? e}`);
    }
    if (typeof parsed?.title !== "string" || parsed.title.length < 2)
      throw new Error("plan missing title");
    if (typeof parsed?.summary !== "string")
      throw new Error("plan missing summary");
    if (!Array.isArray(parsed?.suggested_changes))
      throw new Error("plan missing suggested_changes array");

    const plan = {
      title: String(parsed.title).slice(0, 140),
      summary: String(parsed.summary),
      rationale: String(parsed.rationale ?? ""),
      suggested_changes: (parsed.suggested_changes as any[]).map((c) => ({
        file: String(c?.file ?? "").slice(0, 200),
        what: String(c?.what ?? "").slice(0, 400),
      })),
      new_tests: Array.isArray(parsed.new_tests)
        ? (parsed.new_tests as any[]).map((t) => String(t).slice(0, 140))
        : [],
      open_questions: Array.isArray(parsed.open_questions)
        ? (parsed.open_questions as any[]).map((q) => String(q).slice(0, 300))
        : [],
      estimated_size: ["small", "medium", "large"].includes(
        parsed.estimated_size,
      )
        ? parsed.estimated_size
        : "medium",
    };

    const proposal_id = await ctx.runMutation(
      internal.code_proposals.writeCodeProposal,
      {
        world_id: info.world_id,
        feedback_text: trimmed,
        plan_json: plan,
        author_user_id: info.user_id,
      },
    );

    return { proposal_id, plan };
  },
});

export const loadCodeProposalContext = internalQuery({
  args: { session_token: v.string(), world_slug: v.string() },
  handler: async (ctx, { session_token, world_slug }) => {
    const { world, user_id } = await loadWorldAsOwner(
      ctx,
      session_token,
      world_slug,
    );
    const flag_on = await isFeatureEnabled(ctx, "flag.code_proposals", {
      world_id: world._id,
      user_id,
    });
    return { world_id: world._id, user_id, flag_on };
  },
});

export const writeCodeProposal = internalMutation({
  args: {
    world_id: v.id("worlds"),
    feedback_text: v.string(),
    plan_json: v.any(),
    author_user_id: v.id("users"),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.db.insert("code_proposals", {
      world_id: args.world_id,
      feedback_text: args.feedback_text,
      plan_json: args.plan_json,
      status: "draft",
      author_user_id: args.author_user_id,
      created_at: now,
      updated_at: now,
    });
  },
});

// --------------------------------------------------------------------
// Open the GitHub issue

/** Render the proposal plan as a GitHub-issue-flavored markdown body. */
function renderIssueBody(plan: any, feedback: string, worldName: string): string {
  const lines: string[] = [];
  lines.push(`> Proposed from Weaver admin UI in **${worldName}**.`);
  lines.push("");
  lines.push(`## Why`);
  lines.push("");
  lines.push(String(plan.summary ?? ""));
  if (plan.rationale) {
    lines.push("");
    lines.push(String(plan.rationale));
  }
  lines.push("");
  lines.push(`## Originating feedback`);
  lines.push("");
  lines.push(`> ${feedback.replace(/\n/g, "\n> ")}`);
  if (Array.isArray(plan.suggested_changes) && plan.suggested_changes.length > 0) {
    lines.push("");
    lines.push(`## Suggested changes`);
    lines.push("");
    for (const c of plan.suggested_changes) {
      lines.push(`- \`${c.file}\` — ${c.what}`);
    }
  }
  if (Array.isArray(plan.new_tests) && plan.new_tests.length > 0) {
    lines.push("");
    lines.push(`## New tests`);
    lines.push("");
    for (const t of plan.new_tests) {
      lines.push(`- [ ] ${t}`);
    }
  }
  if (Array.isArray(plan.open_questions) && plan.open_questions.length > 0) {
    lines.push("");
    lines.push(`## Open questions`);
    lines.push("");
    for (const q of plan.open_questions) {
      lines.push(`- ${q}`);
    }
  }
  lines.push("");
  lines.push(`_Estimated size: **${plan.estimated_size ?? "medium"}**_`);
  return lines.join("\n");
}

export const openCodeIssue = action({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    proposal_id: v.id("code_proposals"),
  },
  handler: async (
    ctx,
    { session_token, world_slug, proposal_id },
  ): Promise<{
    github_issue_number: number;
    github_issue_url: string;
  }> => {
    const info = await ctx.runQuery(
      internal.code_proposals.loadProposalForOpen,
      { session_token, world_slug, proposal_id },
    );
    if (!info) throw new Error("proposal not found or forbidden");
    if (info.proposal.status !== "draft")
      throw new Error(`proposal is already ${info.proposal.status}`);

    const pat = process.env.GITHUB_REPO_PAT;
    const repo = process.env.GITHUB_REPO ?? "lilith/weaver";
    if (!pat) {
      throw new Error(
        "GITHUB_REPO_PAT is not set in Convex env; run `npx convex env set GITHUB_REPO_PAT <token>` with a fine-grained PAT that has Issues: write on " +
          repo,
      );
    }

    const plan = info.proposal.plan_json;
    const body = renderIssueBody(
      plan,
      info.proposal.feedback_text,
      info.world.name,
    );
    const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pat}`,
        "User-Agent": "weaver-admin",
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: String(plan?.title ?? info.proposal.feedback_text.slice(0, 72)),
        body,
        assignees: ["lilith"],
        labels: ["weaver-proposal"],
      }),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(
        `github POST /issues failed: ${res.status} ${res.statusText} — ${txt.slice(0, 500)}`,
      );
    }
    const issue = (await res.json()) as {
      number: number;
      html_url: string;
    };

    await ctx.runMutation(internal.code_proposals.markOpened, {
      proposal_id,
      github_issue_number: issue.number,
      github_issue_url: issue.html_url,
    });

    return {
      github_issue_number: issue.number,
      github_issue_url: issue.html_url,
    };
  },
});

export const loadProposalForOpen = internalQuery({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    proposal_id: v.id("code_proposals"),
  },
  handler: async (ctx, { session_token, world_slug, proposal_id }) => {
    const { world } = await loadWorldAsOwner(ctx, session_token, world_slug);
    const proposal = await ctx.db.get(proposal_id);
    if (!proposal) return null;
    if (proposal.world_id !== world._id) return null;
    return { world, proposal };
  },
});

export const markOpened = internalMutation({
  args: {
    proposal_id: v.id("code_proposals"),
    github_issue_number: v.number(),
    github_issue_url: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.patch(args.proposal_id, {
      status: "opened",
      github_issue_number: args.github_issue_number,
      github_issue_url: args.github_issue_url,
      github_issue_created_at: now,
      updated_at: now,
    });
    const proposal = await ctx.db.get(args.proposal_id);
    if (proposal) {
      await appendMentorship(ctx, {
        world_id: proposal.world_id,
        user_id: proposal.author_user_id,
        scope: "code.issue.opened",
        context: {
          proposal_id: args.proposal_id,
          issue_number: args.github_issue_number,
          issue_url: args.github_issue_url,
        },
        human_action: { opened: true },
      });
    }
  },
});

// --------------------------------------------------------------------
// Dismiss

export const dismissCodeProposal = mutation({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    proposal_id: v.id("code_proposals"),
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
      dismissed_at: Date.now(),
      updated_at: Date.now(),
    });
    return { ok: true };
  },
});
