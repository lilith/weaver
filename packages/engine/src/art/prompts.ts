// Art mode prompt templates — spec ART_CURATION.md §"Mode-aware prompts".
//
// Each mode takes an ArtPromptCtx and returns a FLUX prompt string.
// Image sizing hints live in MODE_SIZES. Reference-board images are
// passed separately by the caller; these templates produce the text
// prompt only.

export type ArtPromptCtx = {
  entity: {
    name?: string;
    description?: string;
    portrait_prompt?: string;
    establishing_shot_prompt?: string;
    slug?: string;
    kind?: string; // character | npc | location | biome | item
  };
  world_style_anchor?: {
    descriptor?: string;
    prompt_fragment?: string;
  };
  biome?: {
    name?: string;
    palette?: Record<string, unknown>;
    atmosphere?: string;
  };
  // Optional agentic feedback aggregated from art_feedback.comment rows.
  // Spec: "include recent feedback comments in prompt context."
  feedback_context?: string;
};

function styleFragment(ctx: ArtPromptCtx): string {
  return ctx.world_style_anchor?.prompt_fragment ?? ctx.world_style_anchor?.descriptor ?? "";
}

function descFor(ctx: ArtPromptCtx, locFallback = false): string {
  if (ctx.entity.description) return ctx.entity.description;
  if (locFallback && ctx.entity.establishing_shot_prompt)
    return ctx.entity.establishing_shot_prompt;
  return "";
}

export const MODE_PROMPTS: Record<string, (ctx: ArtPromptCtx) => string> = {
  banner: (ctx) => {
    const parts = [
      "Atmospheric wide shot, 21:9 aspect, cinematic",
      descFor(ctx, true),
      styleFragment(ctx),
      "no characters, no text, moody light",
    ];
    if (ctx.feedback_context) parts.push(`notes: ${ctx.feedback_context}`);
    return parts.filter(Boolean).join(". ");
  },

  portrait_badge: (ctx) => {
    const parts = [
      "Portrait, 3/4 view, neutral background",
      ctx.entity.portrait_prompt ?? descFor(ctx),
      styleFragment(ctx),
      "shoulders up, expressive face",
    ];
    if (ctx.feedback_context) parts.push(`notes: ${ctx.feedback_context}`);
    return parts.filter(Boolean).join(". ");
  },

  tarot_card: (ctx) => {
    const parts = [
      "Tarot card illustration, portrait orientation, ornate art-nouveau border",
      `single subject: ${ctx.entity.name ?? "the subject"}`,
      descFor(ctx, true),
      styleFragment(ctx),
    ];
    if (ctx.feedback_context) parts.push(`notes: ${ctx.feedback_context}`);
    return parts.filter(Boolean).join(". ");
  },

  illumination: (ctx) => {
    const letter = ctx.entity.name?.[0]?.toUpperCase() ?? "W";
    const parts = [
      `Illuminated manuscript capital letter "${letter}", with margin vignette`,
      descFor(ctx, true),
      "gold leaf, rich pigments, hand-lettered",
      styleFragment(ctx),
    ];
    if (ctx.feedback_context) parts.push(`notes: ${ctx.feedback_context}`);
    return parts.filter(Boolean).join(". ");
  },

  hero_full: (ctx) => {
    const parts = [
      "Establishing shot, 16:9 landscape",
      descFor(ctx, true),
      styleFragment(ctx),
    ];
    if (ctx.feedback_context) parts.push(`notes: ${ctx.feedback_context}`);
    return parts.filter(Boolean).join(". ");
  },

  // ambient_palette is free — no FLUX call. Palette extraction happens
  // downstream from an existing blob (or style anchor). Still exposed
  // here so the UI can treat every mode uniformly.
  ambient_palette: (ctx) => {
    return `Palette extraction from ${ctx.entity.slug ?? "entity"} (no gen)`;
  },

  // Pixel-art map tile — top-down, square, NES/SNES-era aesthetic.
  // Fed into /map/[world] via the map_tile rendering. Limited
  // palette + clean edges so the tile reads at 96-128px.
  map_tile: (ctx) => {
    const parts = [
      "Top-down map tile, square composition, pixel-art",
      "16-bit / SNES aesthetic, limited palette (8-12 colors), clean pixel edges, dithering for shadows",
      descFor(ctx, true),
      styleFragment(ctx),
      "no text, no borders, edge-to-edge fill",
    ];
    if (ctx.feedback_context) parts.push(`notes: ${ctx.feedback_context}`);
    return parts.filter(Boolean).join(". ");
  },
};

export const MODE_SIZES: Record<string, string> = {
  banner: "landscape_16_9",
  portrait_badge: "square_hd",
  tarot_card: "portrait_4_3",
  illumination: "square_hd",
  hero_full: "landscape_16_9",
  ambient_palette: "square_hd",
  map_tile: "square_hd",
};

export const ALL_MODES = Object.keys(MODE_PROMPTS);

export const WAVE_2_MODES = [
  "ambient_palette",
  "banner",
  "portrait_badge",
  "tarot_card",
  "illumination",
] as const;

export function isValidMode(mode: string): boolean {
  return ALL_MODES.includes(mode);
}

/** Build the next variant index for an entity-mode. Caller passes the
 *  current list of variant_index values (typically from by_entity_mode_variant). */
export function nextVariantIndex(existing: number[]): number {
  if (existing.length === 0) return 1;
  return Math.max(...existing) + 1;
}
