// Expansion loop — minimal Wave 0 version. Free-text input → Opus 4.7 →
// new Location JSON → blob-backed entity → move character → redirect.
//
// This skips the Haiku intent classifier and 8-atom dispatcher from
// spec/04_EXPANSION_LOOP.md and treats every free-text as
// "create_location OR narrate." Good enough to prove the magic. Full
// pipeline lands in Wave 1.

import { action, internalMutation, internalQuery } from "./_generated/server.js";
import { v } from "convex/values";
import { internal, api } from "./_generated/api.js";
import Anthropic from "@anthropic-ai/sdk";
import type { Id } from "./_generated/dataModel.js";
import { resolveSession, resolveMember } from "./sessions.js";
import { writeJSONBlob, readJSONBlob } from "./blobs.js";
import { recordJourneyTransition } from "./journeys.js";
import { scheduleArtForEntity } from "./art.js";

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
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
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

/** Internal mutation: writes the new location + version + character move. */
export const insertExpandedLocation = internalMutation({
  args: {
    session_token: v.string(),
    world_id: v.id("worlds"),
    parent_location_slug: v.string(),
    location: v.any(),
  },
  handler: async (ctx, { session_token, world_id, parent_location_slug, location }) => {
    const { user, user_id } = await resolveMember(ctx as any, session_token, world_id);
    const world = await ctx.db.get(world_id);
    if (!world?.current_branch_id) throw new Error("no current branch");
    const branch_id = world.current_branch_id;

    const loc = location as Location;

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
      reason: "expansion",
      created_at: now,
    });

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
    // appears on next visit (or refresh) when FLUX finishes.
    await scheduleArtForEntity(ctx, entityId);

    return { new_location_slug: finalSlug };
  },
});

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
