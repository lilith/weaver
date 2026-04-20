// Shared narrative prompt assembler — Ask 5.
//
// One helper that every AI-generation site calls to build its prompt.
// Pulls world bible (cached via Anthropic ephemeral cache), active
// biome mood, speaker voice + voice examples, and (in a future pass
// when Ask 4 lands) NPC memory + player-recent-actions summary.
//
// Contract:
//   await assembleNarrativePrompt(ctx, {
//     world_id,
//     purpose: "expansion" | "dialogue" | "narrate" | "summarize_journey",
//     speaker_entity_id?,
//     character_id?,
//     extra_context?
//   })
//   → {
//     system: Anthropic system blocks (with cache_control on the bible),
//     user: a single string the caller can prepend its own request to,
//     cacheable_tokens_estimate: approximate cacheable-block token count,
//   }
//
// Isolation — the assembler takes world_id and reads only inside it.
// Speaker/character args are validated to belong to that world before
// any blob read.

import { internalQuery } from "./_generated/server.js";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import { readJSONBlob } from "./blobs.js";
import { loadNpcMemory } from "./npc_memory.js";
import { isFeatureEnabled } from "./flags.js";

type AssemblyCtx = {
  db: {
    query: (name: any) => any;
    get: (id: any) => Promise<any>;
  };
};

export type AssembledPrompt = {
  system: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }>;
  user: string;
  meta: {
    purpose: string;
    has_bible: boolean;
    has_speaker: boolean;
    has_biome_context: boolean;
    estimated_cache_tokens: number;
  };
};

export type AssembleArgs = {
  world_id: Id<"worlds">;
  purpose: "expansion" | "dialogue" | "narrate" | "summarize_journey" | "other";
  // Optional scoping:
  speaker_entity_id?: Id<"entities">; // npc or character speaking
  character_id?: Id<"characters">; // the player's character (perspective)
  location_entity_id?: Id<"entities">; // current location — for biome lookup
  extra_context?: string;
};

export async function assembleNarrativePrompt(
  ctx: AssemblyCtx,
  args: AssembleArgs,
): Promise<AssembledPrompt> {
  const world = (await ctx.db.get(args.world_id)) as Doc<"worlds"> | null;
  if (!world?.current_branch_id) {
    return emptyPrompt(args.purpose);
  }
  const branch_id = world.current_branch_id;

  // Bible — cacheable prefix.
  const bibleEntity = await ctx.db
    .query("entities")
    .withIndex("by_branch_type_slug", (q: any) =>
      q.eq("branch_id", branch_id).eq("type", "bible").eq("slug", "bible"),
    )
    .first();
  const bible = bibleEntity ? await readEntityPayload<any>(ctx, bibleEntity) : null;

  // Speaker (if given) — must be in this world.
  let speaker: any = null;
  if (args.speaker_entity_id) {
    const e = (await ctx.db.get(args.speaker_entity_id)) as Doc<"entities"> | null;
    if (e && e.world_id === args.world_id) {
      speaker = await readEntityPayload<any>(ctx, e);
    }
  }

  // Biome — from current location if given.
  let biome: any = null;
  if (args.location_entity_id) {
    const loc = (await ctx.db.get(args.location_entity_id)) as Doc<"entities"> | null;
    if (loc && loc.world_id === args.world_id) {
      const locPayload = await readEntityPayload<any>(ctx, loc);
      const biomeSlug = locPayload?.biome;
      if (biomeSlug) {
        const biomeEntity = await ctx.db
          .query("entities")
          .withIndex("by_branch_type_slug", (q: any) =>
            q.eq("branch_id", branch_id).eq("type", "biome").eq("slug", biomeSlug),
          )
          .first();
        if (biomeEntity) {
          biome = await readEntityPayload<any>(ctx, biomeEntity);
        }
      }
    }
  }

  // Character (the player) — summary of state + inventory.
  let characterSummary: string | null = null;
  if (args.character_id) {
    const c = (await ctx.db.get(args.character_id)) as Doc<"characters"> | null;
    if (c && c.world_id === args.world_id) {
      characterSummary = summarizeCharacter(c);
    }
  }

  // Build the prompt blocks.
  const system: AssembledPrompt["system"] = [];
  system.push({
    type: "text",
    text: systemPreamble(args.purpose),
  });
  if (bible) {
    // World bible is the big cacheable block. Same content across every
    // call for this world → 90%-off on Anthropic's ephemeral cache.
    system.push({
      type: "text",
      text: `<world_bible>\n${JSON.stringify(bible, null, 2)}\n</world_bible>`,
      cache_control: { type: "ephemeral" },
    });
  }
  if (biome) {
    system.push({
      type: "text",
      text: `<active_biome>\n${JSON.stringify(
        {
          name: biome.name,
          mood: biome.establishing_shot_prompt ?? biome.description ?? null,
          tags: biome.tags,
        },
        null,
        2,
      )}\n</active_biome>`,
    });
  }
  if (speaker) {
    system.push({
      type: "text",
      text: `<speaker>\n${JSON.stringify(
        {
          name: speaker.name,
          pseudonym: speaker.pseudonym ?? speaker.name,
          role: speaker.role,
          voice: speaker.voice,
          description: speaker.description,
          memory_config: speaker.memory ?? null,
          memory_initial: speaker.memory_initial ?? null,
        },
        null,
        2,
      )}\n</speaker>`,
    });
  }

  // Ask 4: speaker memory. Flag-gated. Injected between <speaker> and
  // <player> so the model sees "who the NPC is" before "what they
  // remember" before "what's happening right now."
  if (args.speaker_entity_id) {
    const flagOn = await isFeatureEnabled(ctx as any, "flag.npc_memory", {
      world_id: args.world_id,
    });
    if (flagOn) {
      const mem = await loadNpcMemory(ctx as any, branch_id, args.speaker_entity_id);
      if (mem.total > 0 || speaker?.memory_initial) {
        const highLines = mem.high
          .map((m: any) => `  [${m.salience}] turn ${m.turn}: ${m.event_type} — ${m.summary}`)
          .join("\n");
        const recentLines = mem.recent
          .map((m: any) => `  [${m.salience}] turn ${m.turn}: ${m.event_type} — ${m.summary}`)
          .join("\n");
        const seedLines = Array.isArray(speaker?.memory_initial)
          ? speaker.memory_initial
              .map(
                (m: any) =>
                  `  [${m.salience ?? "medium"}] seed: ${m.summary}`,
              )
              .join("\n")
          : "";
        system.push({
          type: "text",
          text:
            `<speaker_memory>\n` +
            (seedLines ? `seed:\n${seedLines}\n` : "") +
            (highLines ? `high_salience:\n${highLines}\n` : "") +
            (recentLines ? `recent:\n${recentLines}\n` : "") +
            `total_rows: ${mem.total}\n` +
            `</speaker_memory>`,
        });
      }
    }
  }

  if (characterSummary) {
    system.push({
      type: "text",
      text: `<player>\n${characterSummary}\n</player>`,
    });
  }

  const user = args.extra_context ?? "";

  return {
    system,
    user,
    meta: {
      purpose: args.purpose,
      has_bible: !!bible,
      has_speaker: !!speaker,
      has_biome_context: !!biome,
      estimated_cache_tokens: bible ? Math.ceil(JSON.stringify(bible).length / 4) : 0,
    },
  };
}

function emptyPrompt(purpose: string): AssembledPrompt {
  return {
    system: [{ type: "text", text: systemPreamble(purpose) }],
    user: "",
    meta: {
      purpose,
      has_bible: false,
      has_speaker: false,
      has_biome_context: false,
      estimated_cache_tokens: 0,
    },
  };
}

function systemPreamble(purpose: string): string {
  switch (purpose) {
    case "expansion":
      return `You are Weaver — a collaborative world-building game engine. A player just typed a free-text action; your job is to respond with a new location (spatial action) or a short narration (non-spatial).`;
    case "dialogue":
      return `You are voicing an NPC inside Weaver, a collaborative world-building game. Stay in character — the speaker's voice style, examples, and personality are authoritative. Never break the fourth wall.`;
    case "narrate":
      return `You are Weaver narrating a brief in-world moment. 1–3 sentences, matching the world bible's tone exactly. No direct dialogue unless the speaker is specified.`;
    case "summarize_journey":
      return `You read a sequence of location descriptions from a collaborative story-game and return a single sentence (≤80 characters) that captures the cluster. Plain text. No quotes, no preamble. If the places don't feel like one coherent arc, say so briefly.`;
    default:
      return `You are Weaver, a collaborative world-building game engine.`;
  }
}

function summarizeCharacter(c: Doc<"characters">): string {
  const s = (c.state as any) ?? {};
  const parts: string[] = [];
  parts.push(`name: ${c.name}`);
  if (c.pseudonym && c.pseudonym !== c.name) parts.push(`known as ${c.pseudonym}`);
  if (typeof s.hp === "number") parts.push(`hp: ${s.hp}`);
  if (typeof s.gold === "number") parts.push(`gold: ${s.gold}`);
  if (typeof s.energy === "number") parts.push(`energy: ${s.energy}`);
  // Inventory: two shapes — legacy array of slugs/objects OR the Wave-2
  // map keyed by slug (flag.item_taxonomy).
  if (Array.isArray(s.inventory) && s.inventory.length > 0) {
    parts.push(
      `inventory: ${s.inventory
        .slice(0, 8)
        .map((i: any) => (typeof i === "string" ? i : i.slug ?? "item"))
        .join(", ")}`,
    );
  } else if (
    s.inventory &&
    typeof s.inventory === "object" &&
    !Array.isArray(s.inventory)
  ) {
    const entries = Object.entries(s.inventory).filter(
      ([, v]: any) => (v?.qty ?? 0) > 0,
    );
    if (entries.length > 0) {
      parts.push(
        `inventory: ${entries
          .slice(0, 8)
          .map(
            ([slug, v]: any) =>
              `${slug}×${v.qty}${v.kind ? `(${v.kind})` : ""}`,
          )
          .join(", ")}`,
      );
    }
  }
  return parts.join("\n");
}

async function readEntityPayload<T>(
  ctx: AssemblyCtx,
  entity: Doc<"entities">,
): Promise<T | null> {
  const version = await ctx.db
    .query("artifact_versions")
    .withIndex("by_artifact_version", (q: any) =>
      q.eq("artifact_entity_id", entity._id).eq("version", entity.current_version),
    )
    .first();
  if (!version) return null;
  return readJSONBlob<T>(ctx as any, version.blob_hash);
}

// -----------------------------------------------------------------------
// Internal query wrapper so actions can pre-assemble a prompt with one
// ctx.runQuery call. Returns the same shape as assembleNarrativePrompt.

export const buildPrompt = internalQuery({
  args: {
    world_id: v.id("worlds"),
    purpose: v.union(
      v.literal("expansion"),
      v.literal("dialogue"),
      v.literal("narrate"),
      v.literal("summarize_journey"),
      v.literal("other"),
    ),
    speaker_entity_id: v.optional(v.id("entities")),
    character_id: v.optional(v.id("characters")),
    location_entity_id: v.optional(v.id("entities")),
    extra_context: v.optional(v.string()),
  },
  handler: async (ctx, args) => assembleNarrativePrompt(ctx as any, args),
});
