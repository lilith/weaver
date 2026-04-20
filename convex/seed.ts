// Seed a starter world under the signed-in user.
// Each invocation creates its own world with a slug scoped per-user —
// e.g., `quiet-vale-<suffix>` — so multiple users and repeat calls
// don't collide.

import { mutation } from "./_generated/server.js";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel.js";
import { writeJSONBlob } from "./blobs.js";
import { resolveSession } from "./sessions.js";
import { scheduleArtForEntity } from "./art.js";

type Template = "quiet-vale";

const BIBLE = {
  name: "The Quiet Vale",
  tagline: "A small mountain village, just after dawn.",
  content_rating: "family",
  creativity: "balanced",
  tone: {
    descriptors: ["cozy", "gentle", "small-scale"],
    avoid: ["grimdark", "cynical"],
    prose_sample:
      "The air was cold and smelled of woodsmoke. Somewhere a dog was barking without urgency.",
  },
  style_anchor: {
    descriptor: "cozy watercolor, warm palette, soft ink lines",
    prompt_fragment: "cozy watercolor, warm palette, soft ink",
  },
  biomes: ["village"],
  characters: ["mara"],
  established_facts: [
    "It is early spring.",
    "The village has one inn and no formal authority.",
  ],
  taboos: ["No violence against children."],
};

const BIOME_VILLAGE = {
  slug: "village",
  name: "The village",
  description:
    "A handful of stone cottages on a hillside, threaded with cobbled lanes and overgrown kitchen gardens. Smoke from a few chimneys.",
  tags: ["settled", "friendly"],
  establishing_shot_prompt:
    "A handful of stone cottages on a hillside, cobbled lanes, smoke from chimneys, morning light, cozy watercolor.",
};

const CHARACTER_MARA = {
  slug: "mara",
  name: "Mara",
  pseudonym: "Mara",
  role: "player_character",
  description: "Mara is in her late twenties, short, watchful, a carpenter.",
  tags: ["human", "adult", "woodworker"],
  portrait_prompt:
    "Late-twenties woman, short dark hair, green cloak, silver ring on right hand, watchful expression, cozy watercolor style.",
  refs: [],
  voice: {
    style: "Terse, dry humor.",
    examples: ["The roof leaks. We fix it or we move."],
  },
};

const LOCATION_VILLAGE_SQUARE = {
  slug: "village-square",
  type: "location",
  name: "The village square",
  biome: "village",
  neighbors: { n: "mara-cottage" },
  tags: ["safe_anchor"],
  safe_anchor: true,
  author_pseudonym: "Stardust",
  state_keys: ["this.visited"],
  on_enter: [{ kind: "inc", path: "this.visited", by: 1 }],
  options: [
    {
      label: "Draw water from the well",
      effect: [
        {
          kind: "say",
          text: "The rope is cold. The bucket comes up full and slightly muddy.",
        },
      ],
    },
    { label: "Walk up to Mara's cottage", target: "mara-cottage" },
  ],
  description_template:
    "A cobbled square with a well at its center. A chicken looks at you with something like disappointment.{{#if this.visited}} Smoke still curls from Mara's chimney uphill.{{/if}}",
};

const LOCATION_MARA_COTTAGE = {
  slug: "mara-cottage",
  type: "location",
  name: "Mara's cottage",
  biome: "village",
  neighbors: { s: "village-square" },
  tags: ["has_chat", "safe_anchor"],
  safe_anchor: true,
  author_pseudonym: "Stardust",
  state_keys: [],
  options: [
    {
      label: "Ask what she's making",
      effect: [{ kind: "say", text: '"A cradle." She doesn\'t elaborate.' }],
    },
    {
      label: "Warm yourself by the fire",
      effect: [{ kind: "say", text: "You thaw slowly." }],
    },
    { label: "Step back out", target: "village-square" },
  ],
  description_template:
    "A one-room cottage that smells like pine shavings and tea. Mara looks up from a piece of furniture she's building and nods.",
};

function shortSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

export const seedStarterWorld = mutation({
  args: {
    session_token: v.string(),
    template: v.optional(v.literal("quiet-vale")),
    character_name: v.optional(v.string()),
  },
  handler: async (ctx, { session_token, character_name }) => {
    const { user, user_id } = await resolveSession(ctx, session_token);

    const slug = `quiet-vale-${shortSuffix()}`;
    const now = Date.now();

    const worldId = await ctx.db.insert("worlds", {
      name: BIBLE.name,
      slug,
      owner_user_id: user_id,
      content_rating: "family",
      created_at: now,
    });

    const branchId = await ctx.db.insert("branches", {
      world_id: worldId,
      name: "Main",
      slug: "main",
      transient: false,
      created_at: now,
    });
    await ctx.db.patch(worldId, { current_branch_id: branchId });

    await ctx.db.insert("world_memberships", {
      world_id: worldId,
      user_id,
      role: "owner",
      created_at: now,
    });

    // Helper: author an entity with a blob-backed payload.
    const authorEntity = async (
      type: string,
      payload: Record<string, unknown>,
      entitySlug: string,
      author_pseudonym?: string,
    ) => {
      const hash = await writeJSONBlob(ctx, payload);
      const entityId = await ctx.db.insert("entities", {
        world_id: worldId,
        branch_id: branchId,
        type,
        slug: entitySlug,
        current_version: 1,
        schema_version: 1,
        author_user_id: user_id,
        author_pseudonym: author_pseudonym ?? user.display_name ?? "author",
        created_at: now,
        updated_at: now,
      });
      await ctx.db.insert("artifact_versions", {
        world_id: worldId,
        branch_id: branchId,
        artifact_entity_id: entityId,
        version: 1,
        blob_hash: hash,
        content_type: "application/json",
        author_user_id: user_id,
        author_pseudonym: author_pseudonym ?? user.display_name ?? "author",
        edit_kind: "create",
        reason: "seed",
        created_at: now,
      });
      return entityId;
    };

    await authorEntity("bible", BIBLE as Record<string, unknown>, "bible");
    await authorEntity(
      "biome",
      BIOME_VILLAGE as Record<string, unknown>,
      BIOME_VILLAGE.slug,
    );
    await authorEntity(
      "character",
      CHARACTER_MARA as Record<string, unknown>,
      CHARACTER_MARA.slug,
    );
    const villageSquareId = await authorEntity(
      "location",
      LOCATION_VILLAGE_SQUARE as Record<string, unknown>,
      LOCATION_VILLAGE_SQUARE.slug,
      LOCATION_VILLAGE_SQUARE.author_pseudonym,
    );
    const maraCottageId = await authorEntity(
      "location",
      LOCATION_MARA_COTTAGE as Record<string, unknown>,
      LOCATION_MARA_COTTAGE.slug,
      LOCATION_MARA_COTTAGE.author_pseudonym,
    );

    // Kick off scene-art generation for the seeded locations. Async.
    await scheduleArtForEntity(ctx, villageSquareId);
    await scheduleArtForEntity(ctx, maraCottageId);

    // The caller's character for this world.
    await ctx.db.insert("characters", {
      world_id: worldId,
      branch_id: branchId,
      user_id,
      name: character_name?.trim() || user.display_name || "traveler",
      pseudonym: character_name?.trim() || user.display_name || "traveler",
      current_location_id: villageSquareId,
      state: { inventory: [], hp: 10, gold: 0, energy: 5 },
      schema_version: 1,
      created_at: now,
      updated_at: now,
    });

    return { world_id: worldId, slug, branch_id: branchId };
  },
});
