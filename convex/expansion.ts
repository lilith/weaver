// Expansion loop — minimal Wave 0 version. Free-text input → Opus 4.7 →
// new Location JSON → blob-backed entity → move character → redirect.
//
// This skips the Haiku intent classifier and 8-atom dispatcher from
// spec/04_EXPANSION_LOOP.md and treats every free-text as
// "create_location OR narrate." Good enough to prove the magic. Full
// pipeline lands in Wave 1.

import { action, internalAction, internalMutation, internalQuery } from "./_generated/server.js";
import { v } from "convex/values";
import { internal, api } from "./_generated/api.js";
import Anthropic from "@anthropic-ai/sdk";
import type { Id } from "./_generated/dataModel.js";
import { resolveSession, resolveMember } from "./sessions.js";
import { writeJSONBlob, readJSONBlob } from "./blobs.js";
import { recordJourneyTransition } from "./journeys.js";
import { scheduleArtForEntity } from "./art.js";
import { isFeatureEnabled } from "./flags.js";
import { logBugs } from "./diagnostics.js";
import { sanitizeLocationPayload } from "@weaver/engine/diagnostics";

const MODEL = "claude-opus-4-7";
const MAX_TOKENS = 2048;

type Location = {
  slug: string;
  name: string;
  biome: string;
  description_template: string;
  options: Array<{ label: string; target?: string; effect?: any[] }>;
  state_keys: string[];
  tags: string[];
  safe_anchor: boolean;
  author_pseudonym?: string;
};

export const expandFromFreeText = action({
  args: {
    session_token: v.string(),
    world_id: v.id("worlds"),
    location_slug: v.string(),
    input: v.string(),
  },
  handler: async (
    ctx,
    { session_token, world_id, location_slug, input },
  ): Promise<{ kind: "goto"; new_location_slug: string } | { kind: "narrate"; text: string }> => {
    const trimmed = input.trim();
    if (!trimmed) throw new Error("empty input");
    if (trimmed.length > 500) throw new Error("input too long (max 500 chars)");

    // Load world bible + parent location via internal queries so this action
    // doesn't need to duplicate the isolation plumbing.
    const ctxData = await ctx.runQuery(internal.expansion.loadExpansionContext, {
      session_token,
      world_id,
      location_slug,
    });

    // Build the shared narrative-prompt shell (world bible + biome +
    // style anchor, all cacheable). The expansion-specific tail — the
    // LocationSchema schema + parent location + free-text input — lives
    // in the extension we append below.
    const assembled = await ctx.runQuery(internal.narrative.buildPrompt, {
      world_id,
      purpose: "expansion",
      location_entity_id: ctxData.parentEntityId,
    });

    const expansionInstructions = buildExpansionInstructions();
    const userPrompt = buildUserPrompt(ctxData.parent, trimmed, ctxData.characterName);

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature: 1.0,
      system: [
        ...assembled.system,
        { type: "text", text: expansionInstructions },
      ],
      messages: [{ role: "user", content: userPrompt }],
    });

    const text = response.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("")
      .trim();

    const parsed = parseLocationOrNarrate(text, location_slug, ctxData.authorPseudonym);
    if (parsed.kind === "narrate") return parsed;

    // Insert the location + redirect.
    const result = await ctx.runMutation(internal.expansion.insertExpandedLocation, {
      session_token,
      world_id,
      parent_location_slug: location_slug,
      location: parsed.location,
    });
    return { kind: "goto", new_location_slug: result.new_location_slug };
  },
});

/** Internal query: load the bits the action needs without duplicating isolation. */
export const loadExpansionContext = internalQuery({
  args: {
    session_token: v.string(),
    world_id: v.id("worlds"),
    location_slug: v.string(),
  },
  handler: async (ctx, { session_token, world_id, location_slug }) => {
    const { user_id } = await resolveMember(ctx as any, session_token, world_id);
    const world = await ctx.db.get(world_id);
    if (!world?.current_branch_id) throw new Error("world has no current branch");
    const branch_id = world.current_branch_id;

    const bibleEntity = await ctx.db
      .query("entities")
      .withIndex("by_branch_type_slug", (q) =>
        q.eq("branch_id", branch_id).eq("type", "bible").eq("slug", "bible"),
      )
      .first();
    const parentEntity = await ctx.db
      .query("entities")
      .withIndex("by_branch_type_slug", (q) =>
        q
          .eq("branch_id", branch_id)
          .eq("type", "location")
          .eq("slug", location_slug),
      )
      .first();
    if (!parentEntity) throw new Error("parent location not found");

    const [bibleV, parentV] = await Promise.all([
      bibleEntity
        ? ctx.db
            .query("artifact_versions")
            .withIndex("by_artifact_version", (q) =>
              q
                .eq("artifact_entity_id", bibleEntity._id)
                .eq("version", bibleEntity.current_version),
            )
            .first()
        : null,
      ctx.db
        .query("artifact_versions")
        .withIndex("by_artifact_version", (q) =>
          q
            .eq("artifact_entity_id", parentEntity._id)
            .eq("version", parentEntity.current_version),
        )
        .first(),
    ]);

    const bible = bibleV
      ? await readJSONBlob<Record<string, unknown>>(ctx as any, bibleV.blob_hash)
      : null;
    const parent = parentV
      ? await readJSONBlob<Record<string, unknown>>(ctx as any, parentV.blob_hash)
      : null;

    const character = await ctx.db
      .query("characters")
      .withIndex("by_world_user", (q) =>
        q.eq("world_id", world_id).eq("user_id", user_id),
      )
      .first();

    return {
      bible,
      parent,
      parentEntityId: parentEntity._id,
      branch_id,
      characterName: character?.pseudonym ?? "the traveler",
      authorPseudonym: character?.pseudonym ?? "the traveler",
    };
  },
});

/** Internal mutation: writes the new location + version + (unless prefetch
 *  mode) moves the character. In prefetch mode we insert the draft and
 *  stamp `prefetched_from_*` so applyOption can find it later, but the
 *  character stays where they are and no journey row is touched. */
export const insertExpandedLocation = internalMutation({
  args: {
    session_token: v.string(),
    world_id: v.id("worlds"),
    parent_location_slug: v.string(),
    location: v.any(),
    // "expand" (default) = create draft + move character.
    // "prefetch" = create draft pre-attached to (parent, option_label), no move.
    mode: v.optional(v.union(v.literal("expand"), v.literal("prefetch"))),
    prefetched_from_option_label: v.optional(v.string()),
  },
  handler: async (
    ctx,
    {
      session_token,
      world_id,
      parent_location_slug,
      location,
      mode,
      prefetched_from_option_label,
    },
  ) => {
    const { user, user_id } = await resolveMember(ctx as any, session_token, world_id);
    const world = await ctx.db.get(world_id);
    if (!world?.current_branch_id) throw new Error("no current branch");
    const branch_id = world.current_branch_id;
    const effectiveMode = mode ?? "expand";

    // Sanitize the Opus-generated payload before it goes to disk. Any
    // malformed field (empty slug, missing biome, bad effect shape) is
    // healed + logged as a runtime_bug rather than propagating.
    const { payload: sanitized, fixes } = sanitizeLocationPayload(location);
    if (fixes.length > 0) {
      await logBugs(ctx, fixes, { world_id, branch_id });
    }
    const loc = sanitized as Location;

    // Avoid slug collision — if the slug already exists, suffix with timestamp.
    let finalSlug = loc.slug;
    const existing = await ctx.db
      .query("entities")
      .withIndex("by_branch_type_slug", (q) =>
        q
          .eq("branch_id", branch_id)
          .eq("type", "location")
          .eq("slug", finalSlug),
      )
      .first();
    if (existing) {
      finalSlug = `${loc.slug}-${Date.now().toString(36).slice(-4)}`;
      loc.slug = finalSlug;
    }

    const now = Date.now();
    const hash = await writeJSONBlob(ctx as any, loc);
    // Look up the parent so saveToMap can extend its options later.
    const parentEntity = await ctx.db
      .query("entities")
      .withIndex("by_branch_type_slug", (q) =>
        q
          .eq("branch_id", branch_id)
          .eq("type", "location")
          .eq("slug", parent_location_slug),
      )
      .first();

    const entityId = await ctx.db.insert("entities", {
      world_id,
      branch_id,
      type: "location",
      slug: finalSlug,
      current_version: 1,
      schema_version: 1,
      author_user_id: user_id,
      author_pseudonym: user.display_name ?? user.email,
      draft: true,
      expanded_from_entity_id: parentEntity?._id,
      // Prefetch-specific stamps so applyOption can discover this draft.
      prefetched_from_entity_id:
        effectiveMode === "prefetch" ? parentEntity?._id : undefined,
      prefetched_from_option_label:
        effectiveMode === "prefetch" ? prefetched_from_option_label : undefined,
      visited_at: effectiveMode === "prefetch" ? undefined : now,
      created_at: now,
      updated_at: now,
    });
    await ctx.db.insert("artifact_versions", {
      world_id,
      branch_id,
      artifact_entity_id: entityId,
      version: 1,
      blob_hash: hash,
      content_type: "application/json",
      author_user_id: user_id,
      author_pseudonym: user.display_name ?? user.email,
      edit_kind: "create",
      reason: effectiveMode === "prefetch" ? "prefetch" : "expansion",
      created_at: now,
    });

    // Auto-art gated by flag.art_curation. When curation is on, art is
    // user-click only via art_curation.conjureForEntity.
    const curationOn = await isFeatureEnabled(ctx, "flag.art_curation", {
      world_id,
      user_id,
    });

    if (effectiveMode === "prefetch") {
      if (!curationOn) await scheduleArtForEntity(ctx, entityId);
      return { new_location_slug: finalSlug, mode: "prefetch" as const };
    }

    // Move the caller's character to the new location.
    const character = await ctx.db
      .query("characters")
      .withIndex("by_world_user", (q) =>
        q.eq("world_id", world_id).eq("user_id", user_id),
      )
      .first();
    if (!character) throw new Error("no character");

    const entityRow = (await ctx.db.get(entityId))!;
    await recordJourneyTransition(ctx, {
      world_id,
      branch_id,
      user_id,
      character_id: character._id,
      new_location: entityRow,
    });

    await ctx.db.patch(character._id, {
      current_location_id: entityId,
      updated_at: now,
    });

    // Kick off scene art — async; page renders text instantly, image
    // appears on next visit (or refresh) when FLUX finishes. Skipped
    // when flag.art_curation is on (resolved above as `curationOn`).
    if (!curationOn) await scheduleArtForEntity(ctx, entityId);

    return { new_location_slug: finalSlug, mode: "expand" as const };
  },
});

// ---------------------------------------------------------------
// Prefetch — speculative expansion (feature #14, spec 04 §Predictive
// text prefetch). Flag-gated (`flag.text_prefetch`). Idempotent per
// (parent, option label). Hard caps: max 3 prefetches per call,
// max 20 unvisited prefetched drafts per world.

const PREFETCH_MAX_PER_CALL = 3;
const PREFETCH_MAX_UNVISITED_PER_WORLD = 20;

/** Check if a prefetched draft already exists for (parent_entity_id, option_label). */
export const findPrefetchedDraft = internalQuery({
  args: {
    branch_id: v.id("branches"),
    parent_entity_id: v.id("entities"),
    option_label: v.string(),
  },
  handler: async (ctx, { branch_id, parent_entity_id, option_label }) => {
    const row = await ctx.db
      .query("entities")
      .withIndex("by_prefetch_source", (q) =>
        q
          .eq("branch_id", branch_id)
          .eq("prefetched_from_entity_id", parent_entity_id)
          .eq("prefetched_from_option_label", option_label),
      )
      .first();
    return row ? { entity_id: row._id, slug: row.slug, visited_at: row.visited_at ?? null } : null;
  },
});

/** Count unvisited prefetched drafts in a world (for cap enforcement). */
export const countUnvisitedPrefetches = internalQuery({
  args: { world_id: v.id("worlds") },
  handler: async (ctx, { world_id }) => {
    const world = await ctx.db.get(world_id);
    if (!world?.current_branch_id) return 0;
    const rows = await ctx.db
      .query("entities")
      .withIndex("by_prefetch_source", (q) =>
        q.eq("branch_id", world.current_branch_id!),
      )
      .collect();
    return rows.filter(
      (r) => r.draft === true && r.visited_at == null && r.prefetched_from_entity_id,
    ).length;
  },
});

/** Ensure prefetches for unresolved options on a given location. Flag-gated,
 *  idempotent per (parent, option label), capped. Returns the list of
 *  {option_label, status} where status is one of:
 *    - "ready"    : a prefetched draft already existed
 *    - "fetching" : we just enqueued a prefetch
 *    - "skipped"  : capped / flag off / target resolves
 */
export const ensurePrefetched = action({
  args: {
    session_token: v.string(),
    world_id: v.id("worlds"),
    location_slug: v.string(),
  },
  handler: async (
    ctx,
    { session_token, world_id, location_slug },
  ): Promise<{
    flag: boolean;
    options: Array<{ option_label: string; option_index: number; status: string; prefetched_slug?: string }>;
  }> => {
    const info = await ctx.runQuery(internal.expansion.prefetchContext, {
      session_token,
      world_id,
      location_slug,
    });
    if (!info.flag_on)
      return { flag: false, options: info.options.map((o: any) => ({ ...o, status: "skipped" })) };

    const unvisited = await ctx.runQuery(internal.expansion.countUnvisitedPrefetches, {
      world_id,
    });
    if (unvisited >= PREFETCH_MAX_UNVISITED_PER_WORLD) {
      return {
        flag: true,
        options: info.options.map((o: any) => ({ ...o, status: "skipped" })),
      };
    }

    const out: Array<{
      option_label: string;
      option_index: number;
      status: string;
      prefetched_slug?: string;
    }> = [];
    let fetchesStarted = 0;
    for (const opt of info.options) {
      if (fetchesStarted >= PREFETCH_MAX_PER_CALL) {
        out.push({ ...opt, status: "skipped" });
        continue;
      }
      // Already prefetched?
      const existing = await ctx.runQuery(internal.expansion.findPrefetchedDraft, {
        branch_id: info.branch_id,
        parent_entity_id: info.parent_entity_id,
        option_label: opt.option_label,
      });
      if (existing) {
        out.push({ ...opt, status: "ready", prefetched_slug: existing.slug });
        continue;
      }
      // Schedule the actual prefetch fire-and-forget. The scheduler
      // boundary lets the current query return quickly; Opus call + DB
      // writes happen in the background.
      await ctx.scheduler.runAfter(0, internal.expansion.runPrefetch, {
        session_token,
        world_id,
        location_slug,
        option_label: opt.option_label,
      });
      out.push({ ...opt, status: "fetching" });
      fetchesStarted++;
    }
    return { flag: true, options: out };
  },
});

/** Internal query: load everything ensurePrefetched needs. */
export const prefetchContext = internalQuery({
  args: {
    session_token: v.string(),
    world_id: v.id("worlds"),
    location_slug: v.string(),
  },
  handler: async (ctx, { session_token, world_id, location_slug }) => {
    const { user_id } = await resolveMember(ctx as any, session_token, world_id);
    const world = await ctx.db.get(world_id);
    if (!world?.current_branch_id) throw new Error("world has no current branch");
    const branch_id = world.current_branch_id;
    const parent = await ctx.db
      .query("entities")
      .withIndex("by_branch_type_slug", (q) =>
        q
          .eq("branch_id", branch_id)
          .eq("type", "location")
          .eq("slug", location_slug),
      )
      .first();
    if (!parent) throw new Error("parent not found");
    const payload = await readAuthoredPayload<Record<string, unknown>>(
      ctx as any,
      parent as any,
    );
    const rawOpts = Array.isArray((payload as any).options)
      ? ((payload as any).options as Array<{ label: string; target?: string }>)
      : [];
    // Find unresolved-target options.
    const options: Array<{ option_label: string; option_index: number }> = [];
    for (let i = 0; i < rawOpts.length; i++) {
      const o = rawOpts[i];
      if (!o.target) continue; // no target = say-only; nothing to prefetch
      const exists = await ctx.db
        .query("entities")
        .withIndex("by_branch_type_slug", (q) =>
          q
            .eq("branch_id", branch_id)
            .eq("type", "location")
            .eq("slug", o.target!),
        )
        .first();
      if (!exists) {
        options.push({ option_label: o.label, option_index: i });
      }
    }
    // Flag check for this (world, user) combination.
    const flag_on = await isFeatureEnabled(ctx, "flag.text_prefetch", {
      user_id,
      world_id,
    });
    return {
      flag_on,
      branch_id,
      parent_entity_id: parent._id,
      options,
    };
  },
});

/** The actual Opus call — scheduled from ensurePrefetched. */
export const runPrefetch = internalAction({
  args: {
    session_token: v.string(),
    world_id: v.id("worlds"),
    location_slug: v.string(),
    option_label: v.string(),
  },
  handler: async (
    ctx,
    { session_token, world_id, location_slug, option_label },
  ): Promise<void> => {
    // Re-check: might already be prefetched by the time this runs.
    const info = await ctx.runQuery(internal.expansion.prefetchContext, {
      session_token,
      world_id,
      location_slug,
    });
    if (!info.flag_on) return;
    const existing = await ctx.runQuery(internal.expansion.findPrefetchedDraft, {
      branch_id: info.branch_id,
      parent_entity_id: info.parent_entity_id,
      option_label,
    });
    if (existing) return;

    // Build the same prompt expandFromFreeText would, using the option
    // label as the free-text input hint.
    const ctxData = await ctx.runQuery(internal.expansion.loadExpansionContext, {
      session_token,
      world_id,
      location_slug,
    });
    const assembled = await ctx.runQuery(internal.narrative.buildPrompt, {
      world_id,
      purpose: "expansion",
      location_entity_id: ctxData.parentEntityId,
    });
    const expansionInstructions = buildExpansionInstructions();
    const userPrompt = buildUserPrompt(ctxData.parent, option_label, ctxData.characterName);

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature: 1.0,
      system: [
        ...assembled.system,
        { type: "text", text: expansionInstructions },
      ],
      messages: [{ role: "user", content: userPrompt }],
    });

    const text = response.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("")
      .trim();

    const parsed = parseLocationOrNarrate(text, location_slug, ctxData.authorPseudonym);
    if (parsed.kind === "narrate") return; // nothing to pre-warm

    await ctx.runMutation(internal.expansion.insertExpandedLocation, {
      session_token,
      world_id,
      parent_location_slug: location_slug,
      location: parsed.location,
      mode: "prefetch",
      prefetched_from_option_label: option_label,
    });
  },
});

// Helper — read authored payload of an entity. Inlined since expansion.ts
// doesn't already import the one from locations.ts.
async function readAuthoredPayload<T>(ctx: any, entity: any): Promise<T> {
  const v = await ctx.db
    .query("artifact_versions")
    .withIndex("by_artifact_version", (q: any) =>
      q.eq("artifact_entity_id", entity._id).eq("version", entity.current_version),
    )
    .first();
  if (!v) throw new Error(`no version for entity ${entity._id}`);
  return readJSONBlob<T>(ctx, v.blob_hash);
}

// -----------------------------------------------------------------------
// Prompts + parsing

function buildExpansionInstructions(): string {
  return `A player just typed a free-text action. Respond with a new location (spatial action) OR a narration (non-spatial). When in doubt, prefer location — the player wants to go somewhere new.

Return strict JSON. No commentary, no markdown fences. Top-level shape is one of:

{"kind":"location","location":{
  "slug":"kebab-case-unique",
  "name":"A short name",
  "biome":"<MUST be one of the biome slugs below — pick the closest mood>",
  "description_template":"<one or two paragraphs of prose, no template vars unless they're declared in state_keys>",
  "options":[
    {"label":"A choice","target":"<slug of some known location OR a new slug that you'd generate next visit>"},
    ...
  ],
  "state_keys":[],
  "tags":[],
  "safe_anchor":false
}}

OR for purely non-spatial actions (sighing, remembering, feeling):

{"kind":"narrate","text":"<1-3 sentences of flavor text>"}

BIOME SLUG RULE: pick exactly one biome slug. Prefer any slug listed in the world bible's \`biomes[]\` array; that keeps the visual palette coherent. Only invent a new biome slug if the world's set genuinely doesn't cover the requested place — and if you do, keep it kebab-case.

HARD RULES:
- Include at least one option whose target is the parent location's slug (the way home).
- Match the world bible's tone + content_rating. Never introduce characters, items, or facts that contradict established facts or taboos.
- "slug" must be kebab-case-ascii-only, unique-ish.
- 2–5 options per location.
- Description: 1–2 short paragraphs, mobile-readable.
- Climb / descend / open / step through / walk to / enter — all strongly imply "location", not "narrate".`;
}

function buildUserPrompt(
  parent: Record<string, unknown> | null,
  input: string,
  characterName: string,
): string {
  const parentText = parent ? JSON.stringify(parent, null, 2) : "(no parent context)";
  return `<parent_location>
${parentText}
</parent_location>

<character_name>${characterName}</character_name>

<free_text_input>${input}</free_text_input>

Respond with strict JSON only.`;
}

function parseLocationOrNarrate(
  text: string,
  parentSlug: string,
  author: string,
):
  | { kind: "narrate"; text: string }
  | { kind: "location"; location: Location } {
  // Strip ```json fences if present even though we said not to use them.
  const clean = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  let parsed: any;
  try {
    parsed = JSON.parse(clean);
  } catch (e) {
    throw new Error(`Opus response not JSON: ${(e as Error).message}\n---\n${clean.slice(0, 400)}`);
  }
  if (parsed.kind === "narrate") {
    return { kind: "narrate", text: String(parsed.text ?? "") };
  }
  if (parsed.kind !== "location" || !parsed.location) {
    throw new Error(`Opus returned unexpected shape: ${JSON.stringify(parsed).slice(0, 300)}`);
  }
  const loc = parsed.location as Location;
  // Sanitize: ensure a back-link exists.
  const hasBackLink = (loc.options ?? []).some(
    (o) => o.target === parentSlug,
  );
  if (!hasBackLink) {
    loc.options = [
      ...(loc.options ?? []),
      { label: "Turn back the way you came", target: parentSlug },
    ];
  }
  loc.slug ||= `expansion-${Date.now().toString(36).slice(-6)}`;
  loc.biome ||= "unknown";
  loc.state_keys ||= [];
  loc.tags ||= [];
  loc.safe_anchor ??= false;
  loc.author_pseudonym = author;
  return { kind: "location", location: loc };
}
