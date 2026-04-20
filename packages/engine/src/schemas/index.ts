// Zod schemas shared between Convex mutations and the SvelteKit client.
// Authoritative shapes per spec/02_LOCATION_SCHEMA.md and
// spec/05_WORLD_BIBLE_BUILDER.md.

import { z } from "zod";

// ---------------------------------------------------------------
// Location effects — discriminated union of the mutations a location
// can trigger. Matches spec/02 §"LocationEffect" + inline-script effects
// (`start_combat`, `give_item`, `add_predicate`, `emit`).
export const LocationEffect = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("set"), path: z.string(), value: z.unknown() }),
  z.object({ kind: z.literal("inc"), path: z.string(), by: z.number() }),
  z.object({ kind: z.literal("goto"), target: z.string() }),
  z.object({
    kind: z.literal("spawn_location"),
    hint: z.string(),
    biome: z.string().optional(),
  }),
  z.object({ kind: z.literal("start_combat"), opponent_id: z.string() }),
  z.object({ kind: z.literal("roll"), sides: z.number(), save_as: z.string() }),
  z.object({ kind: z.literal("say"), text: z.string() }),
  z.object({
    kind: z.literal("give_item"),
    slug: z.string(),
    qty: z.number().optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    kind: z.literal("take_item"),
    slug: z.string(),
    qty: z.number().optional(),
  }),
  z.object({ kind: z.literal("use_item"), slug: z.string() }),
  z.object({ kind: z.literal("crack_orb"), slug: z.string() }),
  z.object({
    kind: z.literal("add_predicate"),
    predicate: z.string(),
    object_id: z.string(),
    payload: z.unknown().optional(),
  }),
  z.object({
    kind: z.literal("emit"),
    event_type: z.string(),
    payload: z.unknown().optional(),
  }),
]);
export type LocationEffect = z.infer<typeof LocationEffect>;

// ---------------------------------------------------------------
// Option — one choice on a location.
export const LocationOption = z.object({
  label: z.string(),
  condition: z.string().optional(),
  target: z.string().optional(), // slug | "#inline:<name>" | "#module:<name>/<method>"
  effect: z.array(LocationEffect).optional(),
  hidden_until: z.string().optional(),
  author_pseudonym: z.string().optional(),
});
export type LocationOption = z.infer<typeof LocationOption>;

// ---------------------------------------------------------------
// Location — the authored payload stored as a JSON blob.
export const Location = z.object({
  slug: z.string(),
  type: z.literal("location").default("location"),
  schema_version: z.number().default(1),

  name: z.string(),
  biome: z.string(),
  coords: z.object({ q: z.number(), r: z.number() }).optional(),
  neighbors: z.record(z.string(), z.string()).optional(),

  description_template: z.string(),
  options: z.array(LocationOption).default([]),

  on_enter: z.array(LocationEffect).default([]),
  on_leave: z.array(LocationEffect).default([]),

  state_keys: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),

  safe_anchor: z.boolean().default(false),
  author_pseudonym: z.string().optional(),
  chat_thread_id: z.string().optional(),
});
export type Location = z.infer<typeof Location>;

// ---------------------------------------------------------------
// World bible — authored per-world constants.
export const Bible = z.object({
  name: z.string(),
  tagline: z.string(),
  content_rating: z
    .enum(["family", "teen", "adult"])
    .default("family"),
  creativity: z.enum(["grounded", "balanced", "maxed"]).default("balanced"),
  tone: z.object({
    descriptors: z.array(z.string()),
    avoid: z.array(z.string()),
    prose_sample: z.string().optional(),
  }),
  style_anchor: z
    .object({
      descriptor: z.string(),
      prompt_fragment: z.string(),
      ref: z.string().optional(),
    })
    .optional(),
  biomes: z.array(z.string()).default([]),
  characters: z.array(z.string()).default([]),
  established_facts: z.array(z.string()).default([]),
  taboos: z.array(z.string()).default([]),
});
export type Bible = z.infer<typeof Bible>;

// ---------------------------------------------------------------
// Biome — authored biome metadata.
export const Biome = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  tags: z.array(z.string()).default([]),
  establishing_shot_prompt: z.string().optional(),
  ref: z.string().optional(),
});
export type Biome = z.infer<typeof Biome>;

// ---------------------------------------------------------------
// Character — authored character metadata.
export const CharacterAuthored = z.object({
  slug: z.string(),
  name: z.string(),
  pseudonym: z.string(),
  role: z.enum(["player_character", "core_npc", "pet"]).default("player_character"),
  description: z.string(),
  tags: z.array(z.string()).default([]),
  portrait_prompt: z.string().optional(),
  refs: z.array(z.string()).default([]),
  voice: z
    .object({
      style: z.string(),
      examples: z.array(z.string()).default([]),
    })
    .optional(),
});
export type CharacterAuthored = z.infer<typeof CharacterAuthored>;
