# Weaver — Theme Generation

## Goal

Given a world bible, produce a UI theme that feels like the world. Colors, typography, decorative atoms, motion. Mapped to Tailwind 4 CSS variables at the root so a theme swap is instant (one mutation, all screens update reactively).

## Theme schema

```ts
// packages/engine/schemas/theme.ts
import { z } from "zod"

export const ColorRampSchema = z.object({
  50: z.string(),   // lightest
  100: z.string(),
  200: z.string(),
  300: z.string(),
  400: z.string(),
  500: z.string(),  // base
  600: z.string(),
  700: z.string(),
  800: z.string(),
  900: z.string(),  // darkest
})

export const ThemeSchema = z.object({
  id: z.string(),
  world_id: z.string(),
  branch_id: z.string(),
  version: z.number().default(1),
  active: z.boolean().default(true),

  name: z.string(),                     // "Quiet Vale — Spring"
  descriptor: z.string(),               // 1-line summary for human

  // Core colors — mapped 1:1 to Tailwind 4 --color-* vars
  colors: z.object({
    primary: ColorRampSchema,           // brand-ish, for primary actions
    accent: ColorRampSchema,            // secondary emphasis
    neutral: ColorRampSchema,           // grayscale for text, borders, bg
    success: ColorRampSchema,
    warning: ColorRampSchema,
    danger: ColorRampSchema,
    background: z.string(),             // overall page bg (resolved color)
    surface: z.string(),                // card/panel bg
    ink: z.string(),                    // body text color
    ink_soft: z.string(),               // muted text
  }),

  // Typography
  typography: z.object({
    heading_family: z.string(),         // CSS font-family string or Google Fonts key
    body_family: z.string(),
    mono_family: z.string(),
    base_size: z.number(),              // px (mobile default, e.g. 16)
    scale: z.enum(["tight", "default", "loose"]),  // line-height / letter-spacing preset
    heading_weight: z.number(),         // 400 | 600 | 700
    body_weight: z.number(),
  }),

  // Decorative atoms
  atoms: z.object({
    radius_scale: z.enum(["sharp", "subtle", "soft", "round"]),  // 0 | 4px | 8px | 16px
    border_weight: z.enum(["hairline", "regular", "bold"]),       // 1px | 2px | 3px
    button_shape: z.enum(["rectangle", "rounded", "pill"]),
    card_style: z.enum(["flat", "subtle_shadow", "defined_shadow", "inset", "bordered"]),
    divider_style: z.enum(["solid", "dashed", "dotted", "ornate"]),
    texture: z.enum(["none", "paper", "parchment", "canvas", "film_grain"]),
  }),

  // Motion
  motion: z.object({
    pace: z.enum(["snappy", "balanced", "gentle", "dreamy"]),
    easing: z.enum(["linear", "easeOut", "easeInOut", "spring_soft", "spring_bouncy"]),
    distance_scale: z.number(),         // multiplier for slide distances
    reduce_on_mobile: z.boolean().default(true),
  }),

  // Optional decorative SVG assets
  ornaments: z.array(z.object({
    name: z.string(),                   // "divider" | "corner_flourish" | "page_header"
    ref_id: z.string(),                 // entity id of a generated SVG or image
  })).default([]),

  created_at: z.number(),
  updated_at: z.number(),
})

export type Theme = z.infer<typeof ThemeSchema>
```

## Generation flow

Runs during world bible step 7 (or manually via "Regenerate theme" later).

```
generate_theme(world_bible) →
  prompt = assemble(world_bible) + theme_instructions
  opus_response = opus_4.7(prompt, temperature=0.7, response_schema=ThemeSchema)
  theme = validate_and_parse(opus_response)
  if has_ornaments_request:
    queue generate_ornament_svgs(theme)
  insert_theme(theme)
```

### Prompt

```
<s>
You are designing a visual theme for a collaborative world-building game's UI.
The theme should reflect the specific world's tone, style, and content.

Return strict JSON matching the ThemeSchema. Consider:
- Colors: pick a small coherent palette; generate full 10-step ramps for each
  named color by interpolating through shade/tint sensibly.
- Typography: pick fonts that are free, widely available (Google Fonts OK), and
  readable on mobile. Avoid overly decorative display fonts for body.
- Atoms: pick cohesive shape/weight decisions that feel like the world.
- Motion: match the world's pace — a whimsical world moves differently than a
  grave one.
</s>

<world_bible cached=true>
{...full bible serialization...}
</world_bible>

Generate the theme. Return only valid JSON.
```

Opus produces ~1-2K tokens of structured JSON. Cost: ~$0.02 per theme.

## Example themes

### "Quiet Vale — Spring" (cozy watercolor world)

```json
{
  "name": "Quiet Vale — Spring",
  "descriptor": "Soft, warm, watercolor — earth tones and meadow greens",
  "colors": {
    "primary": {
      "50": "#f4f6f0", "100": "#e3eada", "200": "#c8d5b3",
      "300": "#a8bc88", "400": "#8ba468", "500": "#6e8a4e",
      "600": "#576f3e", "700": "#435530", "800": "#313e23", "900": "#1f2715"
    },
    "accent": {
      "50": "#fdf7ec", "100": "#fae6c7", "200": "#f4cd93",
      "300": "#ecae60", "400": "#e1893a", "500": "#cf6f23",
      "600": "#a85719", "700": "#834216", "800": "#5e3013", "900": "#3b1e0a"
    },
    "neutral": {
      "50": "#faf6f0", "100": "#efe8dc", "200": "#dcd1be",
      "300": "#bfae93", "400": "#9a8670", "500": "#7a6a58",
      "600": "#5d5043", "700": "#443a31", "800": "#2d2822", "900": "#1a1714"
    },
    "success": {"50": "#f0fae5", "500": "#6aa534", "900": "#1e3110"},
    "warning": {"50": "#fcf6dd", "500": "#c89b2f", "900": "#3b2d0e"},
    "danger":  {"50": "#fbecea", "500": "#b44a3a", "900": "#3f120c"},
    "background": "#fbf8f1",
    "surface": "#fefcf7",
    "ink": "#2a241d",
    "ink_soft": "#6a5a4a"
  },
  "typography": {
    "heading_family": "'EB Garamond', 'Cormorant Garamond', serif",
    "body_family": "'Merriweather', Georgia, serif",
    "mono_family": "'JetBrains Mono', 'Fira Code', monospace",
    "base_size": 16,
    "scale": "loose",
    "heading_weight": 600,
    "body_weight": 400
  },
  "atoms": {
    "radius_scale": "soft",
    "border_weight": "regular",
    "button_shape": "rounded",
    "card_style": "subtle_shadow",
    "divider_style": "ornate",
    "texture": "paper"
  },
  "motion": {
    "pace": "gentle",
    "easing": "easeInOut",
    "distance_scale": 1.0,
    "reduce_on_mobile": true
  },
  "ornaments": []
}
```

### "Iron Reach" (dark, industrial, ash)

```json
{
  "name": "Iron Reach",
  "descriptor": "Soot, iron, and low firelight. Heavy silhouettes, terse shapes.",
  "colors": {
    "primary": {"500": "#6b4f2c", ...},
    "accent": {"500": "#b83c24", ...},
    "neutral": {"500": "#463f3a", ...},
    "background": "#1a1817",
    "surface": "#26221f",
    "ink": "#dcd3c7",
    "ink_soft": "#857b71"
  },
  "typography": {
    "heading_family": "'Cinzel', 'Trajan Pro', serif",
    "body_family": "'Lora', Georgia, serif",
    "mono_family": "'IBM Plex Mono', monospace",
    "base_size": 16,
    "scale": "default",
    "heading_weight": 700,
    "body_weight": 400
  },
  "atoms": {
    "radius_scale": "sharp",
    "border_weight": "bold",
    "button_shape": "rectangle",
    "card_style": "bordered",
    "divider_style": "solid",
    "texture": "canvas"
  },
  "motion": {
    "pace": "snappy",
    "easing": "easeOut",
    "distance_scale": 0.7,
    "reduce_on_mobile": true
  }
}
```

## Tailwind 4 binding

At root of every rendered screen, inject CSS variables from the active theme:

```html
<!-- apps/play/src/lib/theme/themeRoot.svelte -->
<script lang="ts">
  import { useQuery } from "convex-svelte"
  import { api } from "../../convex/_generated/api"
  import { themeToCssVars } from "@weaver/engine/theme"

  const theme = useQuery(api.themes.getActive, { world_id: /* ... */ })
</script>

<svelte:head>
  {#if theme.data}
    {@html `<style>:root { ${themeToCssVars(theme.data)} }</style>`}
    {#if theme.data.typography.heading_family.includes("Garamond")}
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link href="https://fonts.googleapis.com/css2?family=EB+Garamond:wght@400;600&family=Merriweather:wght@400;700&display=swap" rel="stylesheet" />
    {/if}
  {/if}
</svelte:head>

<slot />
```

`themeToCssVars` serializes the theme into CSS var declarations:

```css
--color-primary-500: #6e8a4e;
--color-primary-50: #f4f6f0;
/* ... all ramps ... */
--color-bg: #fbf8f1;
--color-surface: #fefcf7;
--color-ink: #2a241d;
--font-heading: "EB Garamond", serif;
--font-body: "Merriweather", Georgia, serif;
--radius-button: 0.5rem;
--radius-card: 0.75rem;
--shadow-card: 0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04);
--motion-duration: 300ms;
--motion-easing: cubic-bezier(0.4, 0.0, 0.2, 1);
/* etc. */
```

Tailwind 4 arbitrary value syntax consumes these directly in components:

```svelte
<button class="bg-[--color-primary-500] text-[--color-surface] rounded-[--radius-button] px-4 py-2">
  {label}
</button>
```

Or via Tailwind theme extension:

```js
// tailwind.config.js
export default {
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: "var(--color-primary-500)",
          50: "var(--color-primary-50)",
          // ... etc
        },
      },
      borderRadius: {
        button: "var(--radius-button)",
      },
      // etc.
    },
  },
}
```

Usage:

```svelte
<button class="bg-primary text-white rounded-button px-4 py-2">{label}</button>
```

## Regenerating a theme

UI affordance: Settings → World → Theme → "Regenerate." Shows the prompt textarea with the current descriptor prefilled. User can edit, hit regenerate. New theme generated, preview shown, confirm to set active.

```
[ Current theme: Quiet Vale — Spring ]
[ Descriptor: Soft, warm, watercolor — earth tones and meadow greens ]
[ Edit descriptor: ________________________ ]
[ Regenerate ]
```

Regenerating creates a new theme entity version; old one retained in `themes` table with `active: false`. User can roll back by reactivating an old one.

## Per-branch theming

Themes are per-branch, so a branch fork can be retheme without affecting the parent world. Useful for "what if this vale were darker" exploration.

## Ornaments (optional Wave 2+)

Small SVG decorative assets generated to match the theme — section dividers, corner flourishes, page headers. Generated via a separate FLUX.2 SVG mode or as PNGs with transparent bg. Not essential for MVP; skip in Wave 1.

## Accessibility

All generated themes are post-validated:

- Contrast ratio check: ink vs background ≥ 7:1 (AAA); primary-500 vs primary-50 readable.
- Font size ≥ 16px on mobile.
- Motion: `prefers-reduced-motion` media query overrides `motion.pace` to "snappy" with reduced distance.

If validation fails, Opus is re-prompted with the specific violation and asked to fix. Max 2 retries before flagging for human review and falling back to the default theme.

## Default theme (fallback)

Ships with the app. Used before bible is built, during theme regeneration, and on theme-generation failure:

```
{
  "name": "Weaver Default",
  "descriptor": "Neutral, readable, mobile-optimized.",
  "colors": { /* neutral gray ramps, blue primary */ },
  "typography": { /* system font stack, 16px base */ },
  "atoms": { /* soft radius, regular borders, rounded buttons */ },
  "motion": { /* balanced, easeInOut */ }
}
```

## Cost

- Theme generation: ~$0.02 per call (cached bible is 90% off).
- Ornament SVGs (optional): ~$0.03 each, ~3-5 per theme.

Total per theme including ornaments: ~$0.15 max; without ornaments, ~$0.02.
