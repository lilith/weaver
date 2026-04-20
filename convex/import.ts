// Bulk world import — server side. Consumes a pre-validated bundle
// produced by scripts/import-world.mjs, writes a new world + branch +
// owner membership + every bible/biome/character/npc/location as a
// blob-backed entity + artifact_version in a single transaction.
//
// Contract for the bundle shape: backstory/IMPORT_CONTRACT.md.

import { mutation } from "./_generated/server.js";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel.js";
import { resolveSession } from "./sessions.js";
import { writeJSONBlob } from "./blobs.js";

type Entity = {
  type: "bible" | "biome" | "character" | "npc" | "location";
  slug: string;
  payload: Record<string, unknown>;
  author_pseudonym?: string;
};

export const importWorldBundle = mutation({
  args: {
    session_token: v.string(),
    world_name: v.string(),
    world_slug: v.string(),
    content_rating: v.union(
      v.literal("family"),
      v.literal("teen"),
      v.literal("adult"),
    ),
    entities: v.array(
      v.object({
        type: v.union(
          v.literal("bible"),
          v.literal("biome"),
          v.literal("character"),
          v.literal("npc"),
          v.literal("location"),
        ),
        slug: v.string(),
        payload: v.any(),
        author_pseudonym: v.optional(v.string()),
      }),
    ),
    starter_location_slug: v.string(), // where the caller's character spawns
    character_name: v.optional(v.string()),
  },
  handler: async (
    ctx,
    {
      session_token,
      world_name,
      world_slug,
      content_rating,
      entities,
      starter_location_slug,
      character_name,
    },
  ) => {
    const { user, user_id } = await resolveSession(ctx, session_token);

    // Idempotency: refuse to overwrite. If slug exists, caller must delete
    // or rename.
    const existing = await ctx.db
      .query("worlds")
      .withIndex("by_slug", (q) => q.eq("slug", world_slug))
      .first();
    if (existing) {
      throw new Error(
        `world "${world_slug}" already exists — rename or delete via the dashboard first`,
      );
    }

    const now = Date.now();
    const worldId = await ctx.db.insert("worlds", {
      name: world_name,
      slug: world_slug,
      owner_user_id: user_id,
      content_rating,
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

    // Write each entity. Preserve authored slug.
    const slugToEntityId = new Map<string, Id<"entities">>();
    let starterEntityId: Id<"entities"> | null = null;

    for (const e of entities as Entity[]) {
      const hash = await writeJSONBlob(ctx, e.payload);
      const entityId = await ctx.db.insert("entities", {
        world_id: worldId,
        branch_id: branchId,
        type: e.type,
        slug: e.slug,
        current_version: 1,
        schema_version: 1,
        author_user_id: user_id,
        author_pseudonym:
          e.author_pseudonym ?? user.display_name ?? user.email,
        draft: false,
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
        author_pseudonym:
          e.author_pseudonym ?? user.display_name ?? user.email,
        edit_kind: "create",
        reason: "import",
        created_at: now,
      });
      slugToEntityId.set(`${e.type}:${e.slug}`, entityId);
      if (e.type === "location" && e.slug === starter_location_slug) {
        starterEntityId = entityId;
      }
    }

    if (!starterEntityId) {
      throw new Error(
        `starter_location_slug "${starter_location_slug}" not found in imported locations`,
      );
    }

    // The caller's character for this world, placed at the starter.
    await ctx.db.insert("characters", {
      world_id: worldId,
      branch_id: branchId,
      user_id,
      name: character_name?.trim() || user.display_name || "traveler",
      pseudonym: character_name?.trim() || user.display_name || "traveler",
      current_location_id: starterEntityId,
      state: { inventory: [], hp: 10, gold: 0, energy: 5 },
      schema_version: 1,
      created_at: now,
      updated_at: now,
    });

    return {
      world_id: worldId,
      branch_id: branchId,
      slug: world_slug,
      entity_count: entities.length,
      slug_map: Object.fromEntries(slugToEntityId.entries()),
    };
  },
});
