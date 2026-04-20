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

// ---------------------------------------------------------------
// Theme generation (spec 10). ThemeSchema is stored in `themes`
// table; payload.spec matches this shape. One active row per
// (world, branch); generate new versions on bible change.

export const ColorRampSchema = z.object({
  50: z.string(),
  100: z.string(),
  200: z.string(),
  300: z.string(),
  400: z.string(),
  500: z.string(),
  600: z.string(),
  700: z.string(),
  800: z.string(),
  900: z.string(),
});
export type ColorRamp = z.infer<typeof ColorRampSchema>;

export const ThemeSpecSchema = z.object({
  name: z.string(),
  descriptor: z.string(),
  colors: z.object({
    primary: ColorRampSchema,
    accent: ColorRampSchema,
    neutral: ColorRampSchema,
    success: ColorRampSchema,
    warning: ColorRampSchema,
    danger: ColorRampSchema,
    background: z.string(),
    surface: z.string(),
    ink: z.string(),
    ink_soft: z.string(),
  }),
  typography: z.object({
    heading_family: z.string(),
    body_family: z.string(),
    mono_family: z.string(),
    base_size: z.number().default(16),
    scale: z.enum(["tight", "default", "loose"]).default("default"),
    heading_weight: z.number().default(600),
    body_weight: z.number().default(400),
  }),
  atoms: z.object({
    radius_scale: z.enum(["sharp", "subtle", "soft", "round"]).default("subtle"),
    border_weight: z.enum(["hairline", "regular", "bold"]).default("regular"),
    button_shape: z.enum(["rectangle", "rounded", "pill"]).default("rounded"),
    card_style: z
      .enum(["flat", "subtle_shadow", "defined_shadow", "inset", "bordered"])
      .default("subtle_shadow"),
    divider_style: z.enum(["solid", "dashed", "dotted", "ornate"]).default("solid"),
    texture: z
      .enum(["none", "paper", "parchment", "canvas", "film_grain"])
      .default("none"),
  }),
  motion: z.object({
    pace: z.enum(["snappy", "balanced", "gentle", "dreamy"]).default("balanced"),
    easing: z
      .enum(["linear", "easeOut", "easeInOut", "spring_soft", "spring_bouncy"])
      .default("easeOut"),
    distance_scale: z.number().default(1),
    reduce_on_mobile: z.boolean().default(true),
  }),
});
export type ThemeSpec = z.infer<typeof ThemeSpecSchema>;

/** Convert a validated ThemeSpec → CSS-variable block for a `<style>`
 *  tag. Prefixes vars with `--theme-` to avoid colliding with the
 *  existing `--biome-*` palette set. Caller wraps in a selector like
 *  `:root` or `.world-<slug>`. */
export function themeToCss(spec: ThemeSpec, selector = ":root"): string {
  const rampVars = (name: string, r: ColorRamp) =>
    Object.entries(r)
      .map(([k, v]) => `  --theme-${name}-${k}: ${v};`)
      .join("\n");
  const PACE = {
    snappy: "120ms",
    balanced: "220ms",
    gentle: "360ms",
    dreamy: "560ms",
  } as const;
  const EASE = {
    linear: "linear",
    easeOut: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    easeInOut: "cubic-bezier(0.4, 0, 0.2, 1)",
    spring_soft: "cubic-bezier(0.34, 1.26, 0.64, 1)",
    spring_bouncy: "cubic-bezier(0.34, 1.56, 0.64, 1)",
  } as const;
  const RADIUS = {
    sharp: "0px",
    subtle: "4px",
    soft: "8px",
    round: "16px",
  } as const;
  const BORDER = {
    hairline: "1px",
    regular: "2px",
    bold: "3px",
  } as const;
  const SCALE = {
    tight: "1.3",
    default: "1.55",
    loose: "1.75",
  } as const;
  const lines: string[] = [];
  lines.push(`${selector} {`);
  lines.push(rampVars("primary", spec.colors.primary));
  lines.push(rampVars("accent", spec.colors.accent));
  lines.push(rampVars("neutral", spec.colors.neutral));
  lines.push(rampVars("success", spec.colors.success));
  lines.push(rampVars("warning", spec.colors.warning));
  lines.push(rampVars("danger", spec.colors.danger));
  lines.push(`  --theme-background: ${spec.colors.background};`);
  lines.push(`  --theme-surface: ${spec.colors.surface};`);
  lines.push(`  --theme-ink: ${spec.colors.ink};`);
  lines.push(`  --theme-ink-soft: ${spec.colors.ink_soft};`);
  lines.push(`  --theme-font-heading: ${spec.typography.heading_family};`);
  lines.push(`  --theme-font-body: ${spec.typography.body_family};`);
  lines.push(`  --theme-font-mono: ${spec.typography.mono_family};`);
  lines.push(`  --theme-font-base: ${spec.typography.base_size}px;`);
  lines.push(`  --theme-line-height: ${SCALE[spec.typography.scale]};`);
  lines.push(`  --theme-weight-heading: ${spec.typography.heading_weight};`);
  lines.push(`  --theme-weight-body: ${spec.typography.body_weight};`);
  lines.push(`  --theme-radius: ${RADIUS[spec.atoms.radius_scale]};`);
  lines.push(`  --theme-border: ${BORDER[spec.atoms.border_weight]};`);
  lines.push(`  --theme-pace: ${PACE[spec.motion.pace]};`);
  lines.push(`  --theme-ease: ${EASE[spec.motion.easing]};`);
  lines.push(`  --theme-distance-scale: ${spec.motion.distance_scale};`);
  lines.push("}");
  return lines.join("\n");
}
