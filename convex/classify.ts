// Intent classifier + atom router (spec 04).
//
// A player's free-text input routes through Haiku to classify into
// one of 8 atoms: move / examine / take / talk / attack /
// create_location / create_object / narrative. The router then
// dispatches to the right handler. Previously every free-text input
// was one-shot-expanded into a new location; now only
// create_location does that.
//
// Cost-wise: Haiku classify ≈ $0.0005/call (500 in + 100 out).
// Handlers that don't need Opus (move/take/examine/narrative) are
// free; the expensive create_location still calls Opus but only
// when the classifier says so.

import { action, internalQuery, internalAction } from "./_generated/server.js";
import { v } from "convex/values";
import { internal, api } from "./_generated/api.js";
import Anthropic from "@anthropic-ai/sdk";
import { resolveMember } from "./sessions.js";
import { readJSONBlob } from "./blobs.js";
import type { Doc, Id } from "./_generated/dataModel.js";

const CLASSIFY_MODEL = "claude-haiku-4-5-20251001";

const ATOMS = [
  "move",
  "examine",
  "take",
  "talk",
  "attack",
  "create_location",
  "create_object",
  "narrative",
] as const;
export type Atom = (typeof ATOMS)[number];

export type Classification = {
  atom: Atom;
  target?: string;
  description?: string;
  confidence: number;
};

const CLASSIFY_SYSTEM = `You classify a player's free-text action in a text-adventure game.
Return strict JSON matching:
{ "atom": "move|examine|take|talk|attack|create_location|create_object|narrative",
  "target": "<optional entity/location/npc name the player referenced>",
  "description": "<optional description hint if create_*>",
  "confidence": 0.0-1.0 }

Rules:
- move: the player wants to go somewhere (existing neighbor or a new place).
- examine/inspect: look at something in the current scene; no state change.
- take/pick up: grab an object.
- talk: speak to an NPC by name, or speak aloud.
- attack/fight/swing at: initiate combat against a named enemy.
- create_location: go somewhere not in the scene's neighbors — prefer this over move when the target isn't in CONTEXT.neighbors.
- create_object: bring a new object into the scene.
- narrative: flavour action without mechanical effect (e.g. "sigh", "look pensive").

If ambiguous prefer narrative. If the target isn't in CONTEXT pick the create_* form.
Return JSON only, no preamble, no code fences.`;

/** Internal: the raw Haiku call. Caller builds CONTEXT + input. */
export const classifyIntent = internalAction({
  args: {
    input: v.string(),
    context: v.any(),
  },
  handler: async (_ctx, { input, context }): Promise<Classification> => {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: CLASSIFY_MODEL,
      max_tokens: 256,
      temperature: 0,
      system: CLASSIFY_SYSTEM,
      messages: [
        {
          role: "user",
          content: `CONTEXT:\n${JSON.stringify(context)}\nINPUT: ${input}`,
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
    } catch {
      return { atom: "narrative", confidence: 0, description: input };
    }
    if (!ATOMS.includes(parsed?.atom)) {
      return { atom: "narrative", confidence: 0, description: input };
    }
    return {
      atom: parsed.atom,
      target: parsed.target,
      description: parsed.description,
      confidence: Number(parsed.confidence ?? 0.5),
    };
  },
});

/** Build a compact classifier context from the current scene. The
 *  classifier sees names of neighbors, npcs at the location, items
 *  in-scene, and inventory slugs — enough to resolve "the goose" or
 *  "the apothecary" without needing the full bible. */
export const loadClassifierContext = internalQuery({
  args: {
    session_token: v.string(),
    world_id: v.id("worlds"),
    location_slug: v.string(),
  },
  handler: async (ctx, { session_token, world_id, location_slug }) => {
    const { user_id } = await resolveMember(ctx as any, session_token, world_id);
    const world = await ctx.db.get(world_id);
    if (!world?.current_branch_id) throw new Error("world has no branch");
    const branch_id = world.current_branch_id;
    const loc = await ctx.db
      .query("entities")
      .withIndex("by_branch_type_slug", (q: any) =>
        q.eq("branch_id", branch_id).eq("type", "location").eq("slug", location_slug),
      )
      .first();
    if (!loc) throw new Error("location not found");
    let locPayload: any = null;
    try {
      const v = await ctx.db
        .query("artifact_versions")
        .withIndex("by_artifact_version", (q: any) =>
          q.eq("artifact_entity_id", loc._id).eq("version", loc.current_version),
        )
        .first();
      if (v) locPayload = await readJSONBlob<any>(ctx as any, v.blob_hash);
    } catch {}
    const neighborNames: string[] = [];
    if (locPayload?.neighbors) {
      for (const slug of Object.values(locPayload.neighbors) as string[]) {
        const ne = await ctx.db
          .query("entities")
          .withIndex("by_branch_type_slug", (q: any) =>
            q.eq("branch_id", branch_id).eq("type", "location").eq("slug", slug),
          )
          .first();
        if (ne) {
          try {
            const nv = await ctx.db
              .query("artifact_versions")
              .withIndex("by_artifact_version", (q: any) =>
                q.eq("artifact_entity_id", ne._id).eq("version", ne.current_version),
              )
              .first();
            if (nv) {
              const np = await readJSONBlob<any>(ctx as any, nv.blob_hash);
              neighborNames.push(`${np?.name ?? slug} (slug: ${slug})`);
            }
          } catch {}
        }
      }
    }
    // NPCs anywhere in this branch with lives_at === location_slug.
    const npcs: Array<{ name: string; slug: string; hostile?: boolean }> = [];
    const allNpcs = await ctx.db
      .query("entities")
      .withIndex("by_branch_type", (q: any) => q.eq("branch_id", branch_id).eq("type", "npc"))
      .collect();
    for (const e of allNpcs.slice(0, 50)) {
      try {
        const nv = await ctx.db
          .query("artifact_versions")
          .withIndex("by_artifact_version", (q: any) =>
            q.eq("artifact_entity_id", e._id).eq("version", e.current_version),
          )
          .first();
        if (!nv) continue;
        const np = await readJSONBlob<any>(ctx as any, nv.blob_hash);
        if (np?.lives_at === location_slug) {
          npcs.push({
            name: String(np.name ?? e.slug),
            slug: e.slug,
            hostile: !!np.combat_profile,
          });
        }
      } catch {}
    }
    // Character state → inventory keys (slug set; classifier can
    // match "use the key" to the key item the player carries).
    const character = await ctx.db
      .query("characters")
      .withIndex("by_world_user", (q: any) =>
        q.eq("world_id", world_id).eq("user_id", user_id),
      )
      .first();
    const invSlugs: string[] = [];
    const inv = (character?.state as any)?.inventory;
    if (inv && typeof inv === "object" && !Array.isArray(inv)) {
      for (const [slug, entry] of Object.entries(inv as Record<string, any>)) {
        if ((entry?.qty ?? 0) > 0) invSlugs.push(slug);
      }
    }
    return {
      location_name: locPayload?.name ?? location_slug,
      biome: locPayload?.biome ?? null,
      neighbors: neighborNames,
      npcs,
      inventory: invSlugs.slice(0, 20),
    };
  },
});

/** The public dispatch action. Player sends free text; we classify
 *  then route to the right handler. The create_location path
 *  delegates to the existing expandFromFreeText action so prose,
 *  journeys, and prefetch semantics stay identical. */
export const dispatchFreeText = action({
  args: {
    session_token: v.string(),
    world_id: v.id("worlds"),
    location_slug: v.string(),
    input: v.string(),
  },
  handler: async (
    ctx,
    { session_token, world_id, location_slug, input },
  ): Promise<
    | { kind: "goto"; new_location_slug: string; atom: Atom }
    | { kind: "narrate"; text: string; atom: Atom }
    | { kind: "flow_started"; flow_id: Id<"flows">; atom: Atom }
    | { kind: "noop"; reason: string; atom: Atom }
  > => {
    const trimmed = input.trim();
    if (!trimmed) throw new Error("empty input");
    if (trimmed.length > 500) throw new Error("input too long (max 500 chars)");
    const context = await ctx.runQuery(internal.classify.loadClassifierContext, {
      session_token,
      world_id,
      location_slug,
    });
    const classification = await ctx.runAction(internal.classify.classifyIntent, {
      input: trimmed,
      context,
    });

    // Atom routing. Low-confidence → narrative fallback.
    const atom = classification.confidence >= 0.4 ? classification.atom : "narrative";
    switch (atom) {
      case "move": {
        // If target matches a neighbor's slug/name, navigate via goto.
        const match = context.neighbors.find((n: string) =>
          matchesTarget(n, classification.target),
        );
        if (match) {
          const slug = extractSlug(match);
          if (slug) {
            const world = await ctx.runQuery(internal.classify.worldSlugOf, {
              world_id,
            });
            await ctx.runMutation(api.cli.teleportCharacter, {
              session_token,
              world_slug: world.slug,
              loc_slug: slug,
            });
            return { kind: "goto", new_location_slug: slug, atom };
          }
        }
        // Fall through to create_location.
      }
      case "create_location": {
        const result = await ctx.runAction(api.expansion.expandFromFreeText, {
          session_token,
          world_id,
          location_slug,
          input: classification.description ?? trimmed,
        });
        if (result.kind === "goto") return { ...result, atom: "create_location" };
        return { ...result, atom: "create_location" };
      }
      case "attack": {
        const npc = (context.npcs as any[]).find((n) =>
          matchesTarget(n.name, classification.target) ||
          matchesTarget(n.slug, classification.target),
        );
        if (npc && npc.hostile) {
          const { flow_id } = await ctx.runAction(api.flows.startFlow, {
            session_token,
            world_slug: (
              await ctx.runQuery(internal.classify.worldSlugOf, { world_id })
            ).slug,
            module: "combat",
            initial_state: { enemy_slug: npc.slug, enemy_name: npc.name },
          });
          return { kind: "flow_started", flow_id, atom };
        }
        return {
          kind: "narrate",
          text: `You swing — but there's nothing here that'll fight back.`,
          atom,
        };
      }
      case "talk": {
        const npc = (context.npcs as any[]).find((n) =>
          matchesTarget(n.name, classification.target) ||
          matchesTarget(n.slug, classification.target),
        );
        if (npc) {
          const { flow_id } = await ctx.runAction(api.flows.startFlow, {
            session_token,
            world_slug: (
              await ctx.runQuery(internal.classify.worldSlugOf, { world_id })
            ).slug,
            module: "dialogue",
            initial_state: { speaker_slug: npc.slug },
          });
          return { kind: "flow_started", flow_id, atom };
        }
        return {
          kind: "narrate",
          text: `You say the words aloud; nobody in earshot answers.`,
          atom,
        };
      }
      case "examine":
      case "narrative":
      default:
        return {
          kind: "narrate",
          text: classification.description ?? `You consider it.`,
          atom,
        };
    }
  },
});

export const worldSlugOf = internalQuery({
  args: { world_id: v.id("worlds") },
  handler: async (ctx, { world_id }) => {
    const w = await ctx.db.get(world_id);
    return { slug: w?.slug ?? "" };
  },
});

// --------------------------------------------------------------------
// Helpers

function matchesTarget(candidate: string, target: string | undefined): boolean {
  if (!target) return false;
  const a = candidate.toLowerCase();
  const t = target.toLowerCase();
  return a === t || a.includes(t) || t.includes(a);
}

function extractSlug(named: string): string | null {
  // "Name (slug: foo-bar)" → "foo-bar"
  const m = /slug:\s*([a-z0-9-]+)/i.exec(named);
  return m ? m[1] : null;
}
