// World + membership reads — every call resolves the session to a user
// and restricts results to worlds the user is a member of.

import { action, mutation, internalMutation, internalQuery, query } from "./_generated/server.js";
import { v } from "convex/values";
import { internal, api } from "./_generated/api.js";
import { resolveSession, resolveMember } from "./sessions.js";
import { readJSONBlob, writeJSONBlob } from "./blobs.js";
import { initWorldTime } from "@weaver/engine/clock";
import Anthropic from "@anthropic-ai/sdk";
import type { Id } from "./_generated/dataModel.js";

export const listMine = query({
  args: { session_token: v.string() },
  handler: async (ctx, { session_token }) => {
    const { user_id } = await resolveSession(ctx, session_token);
    const memberships = await ctx.db
      .query("world_memberships")
      .withIndex("by_user", (q) => q.eq("user_id", user_id))
      .collect();
    const worlds = [];
    for (const m of memberships) {
      const w = await ctx.db.get(m.world_id);
      if (!w || !w.current_branch_id) continue;

      // Count canonical (non-draft) locations in this world's current branch.
      const locations = await ctx.db
        .query("entities")
        .withIndex("by_branch_type", (q) =>
          q.eq("branch_id", w.current_branch_id!).eq("type", "location"),
        )
        .collect();
      const canonicalLocations = locations.filter(
        (e) => (e as any).draft !== true,
      );
      const location_count = canonicalLocations.length;

      // Count how many of those this user has stepped into. We live-store
      // per-visit counters under character.state.this[slug].visited, so
      // this is a sum over the character's state.
      const character = await ctx.db
        .query("characters")
        .withIndex("by_world_user", (q) =>
          q.eq("world_id", w._id).eq("user_id", user_id),
        )
        .first();
      let visited_count = 0;
      if (character?.state && typeof character.state === "object") {
        const thisScope = (character.state as any).this ?? {};
        for (const slug of Object.keys(thisScope)) {
          const visitEntry = thisScope[slug];
          if (
            visitEntry &&
            typeof visitEntry === "object" &&
            typeof visitEntry.visited === "number" &&
            visitEntry.visited > 0
          ) {
            visited_count++;
          }
        }
      }

      worlds.push({
        _id: w._id,
        name: w.name,
        slug: w.slug,
        current_branch_id: w.current_branch_id,
        role: m.role,
        location_count,
        visited_count,
      });
    }
    worlds.sort((a, b) => a.name.localeCompare(b.name));
    return worlds;
  },
});

export const getBySlugForMe = query({
  args: { session_token: v.string(), slug: v.string() },
  handler: async (ctx, { session_token, slug }) => {
    const { user_id } = await resolveSession(ctx, session_token);
    const world = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();
    if (!world) return null;
    const member = await ctx.db
      .query("world_memberships")
      .withIndex("by_world_user", (q) =>
        q.eq("world_id", world._id).eq("user_id", user_id),
      )
      .first();
    if (!member) return null; // treat as not-found for non-members
    return {
      _id: world._id,
      name: world.name,
      slug: world.slug,
      content_rating: world.content_rating,
      current_branch_id: world.current_branch_id,
      role: member.role,
    };
  },
});

// --------------------------------------------------------------------
// Custom-seed world creation — Opus generates a minimal bible + biome +
// starter location from a user-supplied description. The generated
// bundle is inserted as the user's own world.

const CUSTOM_SEED_MODEL = "claude-opus-4-7";

export const seedFromDescription = action({
  args: {
    session_token: v.string(),
    description: v.string(),
    character_name: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { session_token, description, character_name },
  ): Promise<{ world_id: Id<"worlds">; slug: string }> => {
    const trimmed = description.trim();
    if (trimmed.length < 8)
      throw new Error("description too short — tell me 1–3 sentences");
    if (trimmed.length > 1200)
      throw new Error("description too long — keep it under ~1200 chars");

    // Gate non-technical stubs with the session so we catch unauth'd
    // callers before burning an Opus call.
    const user = await ctx.runMutation(internal.worlds.resolveUserForSeed, {
      session_token,
    });
    if (!user) throw new Error("not authenticated");

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: CUSTOM_SEED_MODEL,
      max_tokens: 2400,
      temperature: 1.0,
      system: [
        {
          type: "text",
          text: SEED_SYSTEM_PROMPT,
        },
      ],
      messages: [
        {
          role: "user",
          content: `<seed_idea>${trimmed}</seed_idea>\n\nRespond with strict JSON only, matching the schema.`,
        },
      ],
    });

    const text = response.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("")
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "");
    let bundle: any;
    try {
      bundle = JSON.parse(text);
    } catch (e: any) {
      throw new Error(`Opus didn't return clean JSON: ${e?.message ?? e}\n---\n${text.slice(0, 300)}`);
    }
    if (!bundle?.bible?.name || !bundle?.biome?.slug || !bundle?.starter?.slug) {
      throw new Error("generated bundle missing required fields");
    }

    return await ctx.runMutation(internal.worlds.insertSeededWorld, {
      session_token,
      bible: bundle.bible,
      biome: bundle.biome,
      starter: bundle.starter,
      character_name: character_name?.trim() || user.display_name || "traveler",
    });
  },
});

export const resolveUserForSeed = internalMutation({
  args: { session_token: v.string() },
  handler: async (ctx, { session_token }) => {
    try {
      const { user } = await resolveSession(ctx, session_token);
      return { user_id: user._id, display_name: user.display_name ?? null };
    } catch {
      return null;
    }
  },
});

/** Internal: actually write the world/branch/bible/biome/starter/
 *  character rows for a custom-seeded world. */
export const insertSeededWorld = internalMutation({
  args: {
    session_token: v.string(),
    bible: v.any(),
    biome: v.any(),
    starter: v.any(),
    character_name: v.string(),
  },
  handler: async (ctx, { session_token, bible, biome, starter, character_name }) => {
    const { user, user_id } = await resolveSession(ctx, session_token);
    const now = Date.now();
    const baseSlug = slugify(bible.name);
    const suffix = Math.random().toString(36).slice(2, 8);
    const slug = `${baseSlug}-${suffix}`;
    const rating = bible.content_rating === "teen" || bible.content_rating === "adult"
      ? bible.content_rating
      : "family";
    const worldId = await ctx.db.insert("worlds", {
      name: String(bible.name),
      slug,
      owner_user_id: user_id,
      content_rating: rating as "family" | "teen" | "adult",
      created_at: now,
    });
    const branchId = await ctx.db.insert("branches", {
      world_id: worldId,
      name: "Main",
      slug: "main",
      transient: false,
      state: { time: initWorldTime({}), turn: 0 },
      created_at: now,
    });
    await ctx.db.patch(worldId, { current_branch_id: branchId });
    await ctx.db.insert("world_memberships", {
      world_id: worldId,
      user_id,
      role: "owner",
      created_at: now,
    });

    // Author entity helper.
    const author = async (type: string, payload: any, slugOverride?: string) => {
      const hash = await writeJSONBlob(ctx, payload);
      const pseudonym = user.display_name ?? "author";
      const entitySlug = slugOverride ?? String(payload.slug ?? "");
      if (!entitySlug) throw new Error(`entity of type ${type} missing slug`);
      const id = await ctx.db.insert("entities", {
        world_id: worldId,
        branch_id: branchId,
        type,
        slug: entitySlug,
        current_version: 1,
        schema_version: 1,
        author_user_id: user_id,
        author_pseudonym: pseudonym,
        created_at: now,
        updated_at: now,
      });
      await ctx.db.insert("artifact_versions", {
        world_id: worldId,
        branch_id: branchId,
        artifact_entity_id: id,
        version: 1,
        blob_hash: hash,
        content_type: "application/json",
        author_user_id: user_id,
        author_pseudonym: pseudonym,
        edit_kind: "create",
        reason: "custom-seed",
        created_at: now,
      });
      return id;
    };

    await author("bible", bible, "bible");
    await author("biome", biome);
    const starterId = await author("location", starter);

    await ctx.db.insert("characters", {
      world_id: worldId,
      branch_id: branchId,
      user_id,
      name: character_name,
      pseudonym: character_name,
      current_location_id: starterId,
      state: { inventory: {}, hp: 10, gold: 0, energy: 5 },
      schema_version: 1,
      created_at: now,
      updated_at: now,
    });

    return { world_id: worldId, slug };
  },
});

function slugify(s: string): string {
  return (
    String(s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "world"
  );
}

const SEED_SYSTEM_PROMPT = `You are Weaver, a collaborative world-building game engine. A new player has given you a short seed idea. Generate a minimal starting bundle: world bible, one biome, and one starter location.

Return strict JSON matching exactly this shape:

{
  "bible": {
    "name": "<short world name, 1-4 words>",
    "tagline": "<one sentence>",
    "content_rating": "family" | "teen",
    "tone": {
      "descriptors": ["<3-6 tone words>"],
      "avoid": ["<2-4 tone-killer words>"],
      "prose_sample": "<one sentence in the world's voice>"
    },
    "style_anchor": {
      "descriptor": "<visual-style phrase>",
      "prompt_fragment": "<FLUX prompt fragment, same content as descriptor, more terse>"
    },
    "biomes": ["<the biome slug below>"],
    "characters": [],
    "established_facts": ["<2-4 grounded facts>"],
    "taboos": ["<1-3 things this world won't do>"]
  },
  "biome": {
    "slug": "<kebab-case>",
    "name": "<short name>",
    "tags": ["<atmospheric tag>", "..."],
    "establishing_shot_prompt": "<one sentence describing a wide shot of this biome>",
    "description": "<1-2 sentences describing the biome>"
  },
  "starter": {
    "slug": "<kebab-case>",
    "type": "location",
    "name": "<short location name>",
    "biome": "<same slug as biome.slug>",
    "tags": ["safe_anchor"],
    "safe_anchor": true,
    "options": [
      { "label": "<a short action phrase>", "effect": [{ "kind": "say", "text": "<one sentence flavor>" }] },
      { "label": "<a short action phrase>", "effect": [{ "kind": "say", "text": "<one sentence flavor>" }] }
    ],
    "description_template": "<1-2 short paragraphs, the opening prose for this location>"
  }
}

Rules:
- Match family-friendly content unless the seed explicitly asks otherwise (then teen max).
- The starter location has 2-3 options; none need targets (player can weave outward).
- No options with \`target\`: that's for later expansion; the initial beat stays in-place.
- No characters/npcs — leave those for the family to author.
- Prose should match the tone descriptors exactly.`;

// --------------------------------------------------------------------
// Biome palette auto-gen (UX-05). Opus generates a CSS-variable palette
// override for a biome, stored into the biome entity's payload.palette.
// Used by the page-render path: helper below checks entity payload
// first, then falls through to packages/engine/biomes/palettes.json.

const PALETTE_MODEL = "claude-sonnet-4-6";

export const generateBiomePalette = action({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    biome_slug: v.string(),
  },
  handler: async (
    ctx,
    { session_token, world_slug, biome_slug },
  ): Promise<{ generated: boolean; version: number }> => {
    const info = await ctx.runQuery(internal.worlds.loadBiomeForPalette, {
      session_token,
      world_slug,
      biome_slug,
    });
    if (!info) throw new Error("biome not found or forbidden");
    if (info.already_has_palette)
      return { generated: false, version: info.version };

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: PALETTE_MODEL,
      max_tokens: 600,
      temperature: 0.8,
      system: [{ type: "text", text: PALETTE_SYSTEM_PROMPT }],
      messages: [
        {
          role: "user",
          content: `<biome>
name: ${info.biome.name}
tags: ${JSON.stringify(info.biome.tags ?? [])}
establishing_shot: ${info.biome.establishing_shot_prompt ?? ""}
description: ${info.biome.description ?? ""}
</biome>

<world_style_anchor>
${JSON.stringify(info.style_anchor ?? {}, null, 2)}
</world_style_anchor>

Respond with strict JSON only.`,
        },
      ],
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
      throw new Error(`palette JSON parse failed: ${e?.message ?? e}`);
    }
    if (!parsed?.overrides || typeof parsed.overrides !== "object")
      throw new Error("palette response missing overrides");

    return await ctx.runMutation(internal.worlds.writeBiomePalette, {
      biome_entity_id: info.biome_entity_id,
      palette: {
        slug: biome_slug,
        name: parsed.name ?? info.biome.name,
        mood: parsed.mood ?? "",
        overrides: parsed.overrides,
      },
    });
  },
});

export const loadBiomeForPalette = internalQuery({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    biome_slug: v.string(),
  },
  handler: async (ctx, { session_token, world_slug, biome_slug }) => {
    const world = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q: any) => q.eq("slug", world_slug))
      .first();
    if (!world) return null;
    const { user_id } = await resolveMember(ctx as any, session_token, world._id);
    if (world.owner_user_id !== user_id) return null;
    if (!world.current_branch_id) return null;
    const biomeEntity = await ctx.db
      .query("entities")
      .withIndex("by_branch_type_slug", (q: any) =>
        q
          .eq("branch_id", world.current_branch_id!)
          .eq("type", "biome")
          .eq("slug", biome_slug),
      )
      .first();
    if (!biomeEntity) return null;
    const version = await ctx.db
      .query("artifact_versions")
      .withIndex("by_artifact_version", (q: any) =>
        q
          .eq("artifact_entity_id", biomeEntity._id)
          .eq("version", biomeEntity.current_version),
      )
      .first();
    if (!version) return null;
    const biome = await readJSONBlob<any>(ctx as any, version.blob_hash);
    // Bible for style_anchor.
    const bibleEntity = await ctx.db
      .query("entities")
      .withIndex("by_branch_type_slug", (q: any) =>
        q.eq("branch_id", world.current_branch_id!).eq("type", "bible").eq("slug", "bible"),
      )
      .first();
    let style_anchor: any = null;
    if (bibleEntity) {
      const bv = await ctx.db
        .query("artifact_versions")
        .withIndex("by_artifact_version", (q: any) =>
          q
            .eq("artifact_entity_id", bibleEntity._id)
            .eq("version", bibleEntity.current_version),
        )
        .first();
      if (bv) {
        const b = await readJSONBlob<any>(ctx as any, bv.blob_hash);
        style_anchor = b?.style_anchor ?? null;
      }
    }
    return {
      biome,
      biome_entity_id: biomeEntity._id,
      version: biomeEntity.current_version,
      already_has_palette: Boolean(biome?.palette?.overrides),
      style_anchor,
    };
  },
});

export const writeBiomePalette = internalMutation({
  args: {
    biome_entity_id: v.id("entities"),
    palette: v.any(),
  },
  handler: async (ctx, { biome_entity_id, palette }) => {
    const entity = await ctx.db.get(biome_entity_id);
    if (!entity) throw new Error("biome entity disappeared");
    const version = await ctx.db
      .query("artifact_versions")
      .withIndex("by_artifact_version", (q: any) =>
        q
          .eq("artifact_entity_id", biome_entity_id)
          .eq("version", entity.current_version),
      )
      .first();
    if (!version) throw new Error("biome has no current version");
    const payload = await readJSONBlob<any>(ctx as any, version.blob_hash);
    const nextPayload = { ...payload, palette };
    const nextHash = await writeJSONBlob(ctx, nextPayload);
    const nextV = entity.current_version + 1;
    await ctx.db.insert("artifact_versions", {
      world_id: entity.world_id,
      branch_id: entity.branch_id,
      artifact_entity_id: biome_entity_id,
      version: nextV,
      blob_hash: nextHash,
      content_type: "application/json",
      author_user_id: entity.author_user_id,
      author_pseudonym: entity.author_pseudonym,
      edit_kind: "auto_palette",
      reason: "biome_palette_gen",
      created_at: Date.now(),
    });
    await ctx.db.patch(biome_entity_id, {
      current_version: nextV,
      updated_at: Date.now(),
    });
    return { generated: true, version: nextV };
  },
});

const PALETTE_SYSTEM_PROMPT = `You are designing a CSS-variable palette override for a biome in Weaver, a dark-themed ("midnight-loom") collaborative storytelling app. The base theme uses Tailwind-ish CSS variables like --color-velvet-800, --color-mist-600, --color-candle-300, --color-rose-400, --color-teal-400, etc. Your overrides tint the PAGE when the player is in this biome — background, ink, atmosphere.

Return strict JSON matching:

{
  "name": "<1-4 words>",
  "mood": "<evocative fragment, 3-8 words>",
  "overrides": {
    "--color-velvet-800": "<rgb triple like '31 26 56' — Tailwind uses space-separated channels>",
    "--color-velvet-900": "<...>",
    "--color-mist-100": "<...>",
    "--color-candle-300": "<...>",
    "--color-rose-400": "<optional accent shift>",
    "--color-teal-400": "<optional accent shift>"
  }
}

Rules:
- 4-8 overrides max; pick the ones that shift the biome's feel most. Skip ones that don't help.
- Values are RGB triples with SPACES (e.g. "31 26 56"), not hex, not commas.
- Stay dark enough to remain readable (velvet-900 should be near-black, mist-100 near-white).
- Respect the world style anchor's color cues when hinted.
- No markdown, no commentary, JSON only.`;

// --------------------------------------------------------------------
// Bible feedback — Opus suggests a diff; user approves → new
// artifact_version. Keeps authorial voice; prevents arbitrary rewrites.

const BIBLE_FEEDBACK_MODEL = "claude-opus-4-7";

export const suggestBibleEdit = action({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    feedback: v.string(),
  },
  handler: async (
    ctx,
    { session_token, world_slug, feedback },
  ): Promise<{
    current: Record<string, unknown>;
    suggested: Record<string, unknown>;
    rationale: string;
    bible_entity_id: Id<"entities">;
    current_version: number;
  }> => {
    const trimmed = feedback.trim();
    if (trimmed.length < 4) throw new Error("feedback too short");
    if (trimmed.length > 1500) throw new Error("feedback too long");

    const info = await ctx.runQuery(internal.worlds.loadBibleForEdit, {
      session_token,
      world_slug,
    });
    if (!info) throw new Error("bible not found or forbidden");

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: BIBLE_FEEDBACK_MODEL,
      max_tokens: 3000,
      temperature: 0.7,
      system: [{ type: "text", text: BIBLE_EDIT_SYSTEM_PROMPT }],
      messages: [
        {
          role: "user",
          content: `<current_bible>\n${JSON.stringify(info.bible, null, 2)}\n</current_bible>\n\n<feedback>${trimmed}</feedback>\n\nRespond with strict JSON only.`,
        },
      ],
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
      throw new Error(`bible-edit JSON parse failed: ${e?.message ?? e}`);
    }
    if (!parsed?.suggested_bible || typeof parsed.suggested_bible !== "object")
      throw new Error("response missing suggested_bible");
    return {
      current: info.bible,
      suggested: parsed.suggested_bible,
      rationale: String(parsed.rationale ?? ""),
      bible_entity_id: info.bible_entity_id,
      current_version: info.version,
    };
  },
});

export const loadBibleForEdit = internalQuery({
  args: { session_token: v.string(), world_slug: v.string() },
  handler: async (ctx, { session_token, world_slug }) => {
    const world = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q: any) => q.eq("slug", world_slug))
      .first();
    if (!world) return null;
    const { user_id } = await resolveMember(ctx as any, session_token, world._id);
    if (world.owner_user_id !== user_id) return null;
    if (!world.current_branch_id) return null;
    const bibleEntity = await ctx.db
      .query("entities")
      .withIndex("by_branch_type_slug", (q: any) =>
        q
          .eq("branch_id", world.current_branch_id!)
          .eq("type", "bible")
          .eq("slug", "bible"),
      )
      .first();
    if (!bibleEntity) return null;
    const v = await ctx.db
      .query("artifact_versions")
      .withIndex("by_artifact_version", (q: any) =>
        q
          .eq("artifact_entity_id", bibleEntity._id)
          .eq("version", bibleEntity.current_version),
      )
      .first();
    if (!v) return null;
    const bible = await readJSONBlob<Record<string, unknown>>(
      ctx as any,
      v.blob_hash,
    );
    return {
      bible,
      bible_entity_id: bibleEntity._id,
      version: bibleEntity.current_version,
    };
  },
});

/** Apply a suggested bible diff: create a new artifact_version. Owner
 *  must re-supply the expected current_version so we bail if someone
 *  else edited the bible between suggest and apply. */
export const applyBibleEdit = mutation({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    new_bible_json: v.string(),
    expected_version: v.number(),
    reason: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { session_token, world_slug, new_bible_json, expected_version, reason },
  ) => {
    const world = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q) => q.eq("slug", world_slug))
      .first();
    if (!world) throw new Error(`world not found: ${world_slug}`);
    const { user_id, user } = await resolveMember(ctx, session_token, world._id);
    if (world.owner_user_id !== user_id)
      throw new Error("apply-bible-edit is owner-only");
    if (!world.current_branch_id) throw new Error("world has no branch");
    const bibleEntity = await ctx.db
      .query("entities")
      .withIndex("by_branch_type_slug", (q) =>
        q
          .eq("branch_id", world.current_branch_id!)
          .eq("type", "bible")
          .eq("slug", "bible"),
      )
      .first();
    if (!bibleEntity) throw new Error("bible not found");
    if (bibleEntity.current_version !== expected_version) {
      throw new Error(
        `bible version changed (saw v${bibleEntity.current_version}, expected v${expected_version}); reload and retry`,
      );
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(new_bible_json);
    } catch (e: any) {
      throw new Error(`new_bible_json not parseable: ${e?.message ?? e}`);
    }
    const hash = await writeJSONBlob(ctx, payload);
    const nextV = bibleEntity.current_version + 1;
    await ctx.db.insert("artifact_versions", {
      world_id: world._id,
      branch_id: world.current_branch_id,
      artifact_entity_id: bibleEntity._id,
      version: nextV,
      blob_hash: hash,
      content_type: "application/json",
      author_user_id: user_id,
      author_pseudonym: user.display_name ?? "author",
      edit_kind: "bible_feedback",
      reason: reason ?? "ai-suggested edit approved",
      created_at: Date.now(),
    });
    await ctx.db.patch(bibleEntity._id, {
      current_version: nextV,
      updated_at: Date.now(),
    });
    return { version: nextV };
  },
});

const BIBLE_EDIT_SYSTEM_PROMPT = `You are assisting a family who has given you feedback about their Weaver world bible. Propose a minimal edit to the bible that addresses the feedback while preserving their voice, taboos, and established facts.

Respond with strict JSON only:

{
  "suggested_bible": { <the full updated bible object, preserving all existing keys and values that don't need to change> },
  "rationale": "<one short paragraph explaining what you changed and why>"
}

Rules:
- DO keep every existing field that doesn't need to change.
- DO preserve established_facts unless the feedback explicitly contradicts one (and then add a note in rationale).
- DO respect taboos: never remove one, only add.
- DO change tone descriptors when feedback is about tone.
- DO add to biomes/characters lists when feedback introduces new elements.
- DON'T rewrite the prose_sample wholesale unless the feedback explicitly asks for tone shift.
- DON'T change content_rating unless explicitly requested.
- DON'T invent or remove content_rating, name, or tagline.`;

/** Fetch a biome's authored palette from its entity payload (auto-gen'd
 *  or hand-authored). Returns null if the biome has no palette or the
 *  biome entity isn't in the world. Used by the page loader alongside
 *  the static registry fallback. */
export const getBiomePaletteFromEntity = query({
  args: {
    session_token: v.string(),
    world_slug: v.string(),
    biome_slug: v.string(),
  },
  handler: async (ctx, { session_token, world_slug, biome_slug }) => {
    const world = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q) => q.eq("slug", world_slug))
      .first();
    if (!world) return null;
    await resolveMember(ctx, session_token, world._id);
    if (!world.current_branch_id) return null;
    const entity = await ctx.db
      .query("entities")
      .withIndex("by_branch_type_slug", (q) =>
        q
          .eq("branch_id", world.current_branch_id!)
          .eq("type", "biome")
          .eq("slug", biome_slug),
      )
      .first();
    if (!entity) return null;
    const v = await ctx.db
      .query("artifact_versions")
      .withIndex("by_artifact_version", (q) =>
        q
          .eq("artifact_entity_id", entity._id)
          .eq("version", entity.current_version),
      )
      .first();
    if (!v) return null;
    const payload = await readJSONBlob<any>(ctx as any, v.blob_hash);
    if (!payload?.palette?.overrides) return null;
    return payload.palette;
  },
});

export const getBible = query({
  args: { session_token: v.string(), world_id: v.id("worlds") },
  handler: async (ctx, { session_token, world_id }) => {
    await resolveMember(ctx, session_token, world_id);
    const world = await ctx.db.get(world_id);
    if (!world?.current_branch_id) return null;
    const entity = await ctx.db
      .query("entities")
      .withIndex("by_branch_type_slug", (q) =>
        q
          .eq("branch_id", world.current_branch_id!)
          .eq("type", "bible")
          .eq("slug", "bible"),
      )
      .first();
    if (!entity) return null;
    const version = await ctx.db
      .query("artifact_versions")
      .withIndex("by_artifact_version", (q) =>
        q
          .eq("artifact_entity_id", entity._id)
          .eq("version", entity.current_version),
      )
      .first();
    if (!version) return null;
    return {
      entity_id: entity._id,
      version: entity.current_version,
      ...(await readJSONBlob<Record<string, unknown>>(ctx as any, version.blob_hash)),
    };
  },
});
