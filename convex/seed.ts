// Seed — materializes the "Tiny complete example" from
// spec/AUTHORING_AND_SYNC.md into Convex. Idempotent per (world_slug):
// running twice is safe — existing world is skipped.
//
// Usage:
//   npx convex run seed:seedTinyWorld '{"owner_email":"you@example.com"}'

import { internalMutation } from "./_generated/server.js";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import { writeJSONBlob } from "./blobs.js";

const WORLD_SLUG = "quiet-vale";
const BRANCH_SLUG = "main";

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
  description:
    "Mara is in her late twenties, short, watchful, a carpenter.",
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

export const seedTinyWorld = internalMutation({
  args: { owner_email: v.string(), owner_display_name: v.optional(v.string()) },
  handler: async (ctx, { owner_email, owner_display_name }) => {
    // 1. Owner user.
    let owner = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", owner_email))
      .first();
    if (!owner) {
      const userId = await ctx.db.insert("users", {
        email: owner_email,
        display_name: owner_display_name ?? owner_email.split("@")[0],
        is_minor: false,
        guardian_user_ids: [],
        created_at: Date.now(),
      });
      owner = (await ctx.db.get(userId))!;
    }

    // 2. World + branch (idempotent on slug).
    let world = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q) => q.eq("slug", WORLD_SLUG))
      .first();
    if (world) {
      return {
        world_id: world._id,
        branch_id: world.current_branch_id!,
        status: "exists",
      };
    }
    const worldId = await ctx.db.insert("worlds", {
      name: BIBLE.name,
      slug: WORLD_SLUG,
      owner_user_id: owner._id,
      content_rating: "family",
      created_at: Date.now(),
    });
    const branchId = await ctx.db.insert("branches", {
      world_id: worldId,
      name: "Main",
      slug: BRANCH_SLUG,
      transient: false,
      created_at: Date.now(),
    });
    await ctx.db.patch(worldId, { current_branch_id: branchId });

    // 3. Helper: author an entity with a blob-backed payload.
    const authorEntity = async (
      type: Doc<"entities">["type"],
      payload: Record<string, unknown>,
      slug: string,
      author_pseudonym?: string,
    ) => {
      const hash = await writeJSONBlob(ctx, payload);
      const now = Date.now();
      const entityId = await ctx.db.insert("entities", {
        type,
        slug,
        branch_id: branchId,
        world_id: worldId,
        current_version: 1,
        schema_version: 1,
        author_user_id: owner._id,
        author_pseudonym: author_pseudonym ?? "Stardust",
        created_at: now,
        updated_at: now,
      });
      await ctx.db.insert("artifact_versions", {
        artifact_entity_id: entityId,
        version: 1,
        blob_hash: hash,
        content_type: "application/json",
        author_user_id: owner._id,
        author_pseudonym: author_pseudonym ?? "Stardust",
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
    await authorEntity(
      "location",
      LOCATION_MARA_COTTAGE as Record<string, unknown>,
      LOCATION_MARA_COTTAGE.slug,
      LOCATION_MARA_COTTAGE.author_pseudonym,
    );

    // 4. Player character bound to the owner user, placed at the safe anchor.
    await ctx.db.insert("characters", {
      user_id: owner._id,
      world_id: worldId,
      branch_id: branchId,
      name: CHARACTER_MARA.name,
      pseudonym: CHARACTER_MARA.pseudonym,
      current_location_id: villageSquareId,
      state: { inventory: [], hp: 10, gold: 0, energy: 5 },
      schema_version: 1,
      created_at: Date.now(),
      updated_at: Date.now(),
    });

    return {
      world_id: worldId,
      branch_id: branchId,
      status: "seeded",
    };
  },
});
