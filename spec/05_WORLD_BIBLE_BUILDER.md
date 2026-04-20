# Weaver — World Bible Builder

## Goal

A 15-minute guided session that produces the canonical reference set a world needs. Every generation (text, image, theme, option expansion) pulls from this. It's the single most important thing the family creates together.

## What the bible contains

```ts
// convex/schemas/worldBible.ts
export const WorldBibleSchema = z.object({
  id: z.string(),
  branch_id: z.string(),
  world_id: z.string(),
  schema_version: z.number().default(1),

  name: z.string(),
  tagline: z.string(),                    // "a cozy mountain valley, after the war"
  content_rating: z.enum(["family", "teen", "adult"]).default("family"),
  creativity: z.enum(["grounded", "balanced", "maxed"]).default("balanced"),

  tone: z.object({
    descriptors: z.array(z.string()),     // ["gentle", "curious", "slightly_whimsical"]
    avoid: z.array(z.string()),           // ["grimdark", "nihilism", "body_horror"]
    prose_sample: z.string(),             // 2-3 sentences illustrating voice
  }),

  style_anchor: z.object({
    descriptor: z.string(),               // "cozy watercolor, soft ink, warm palette"
    ref_id: z.string(),                   // entity id of the canonical style image
    prompt_fragment: z.string(),          // snippet injected into FLUX.2 prompts
  }),

  characters: z.array(z.object({
    id: z.string(),
    name: z.string(),
    pseudonym: z.string(),                // display handle
    user_id: z.string().optional(),       // if player-linked
    role: z.string(),                     // "player_character" | "core_npc" | "pet"
    description: z.string(),              // detailed physical + personality
    ref_ids: z.array(z.string()),         // 1-3 canonical images per character
    tags: z.array(z.string()),            // ["small", "pomeranian", "gentle"]
  })),

  biomes: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    ref_id: z.string(),                   // canonical establishing image
    prompt_fragment: z.string(),          // injected for any location of this biome
    tags: z.array(z.string()),
  })),

  established_facts: z.array(z.string()), // "The chapel stands at the south end of the village."
  taboos: z.array(z.string()),            // things the AI must never introduce

  theme_id: z.string().optional(),        // link to generated UI theme (see 10_THEME_GENERATION.md)

  created_by: z.string(),                 // user_id
  created_at: z.number(),
  updated_at: z.number(),
})
```

All `ref_id` values point to entities in the main store with `type: "ref"` and components containing the image URL + prompt + metadata. This means refs are editable like any other artifact.

## The onboarding flow

Conversational, optionally voice-input. All family members present (or they can join later and contribute a character).

### Step 1 — World name & tagline (1 min)

```
"Welcome to Weaver. What do you want to call your world?"
[text input]

"In one sentence, what kind of place is it?"
[text input, 1-3 sentences]

Example:
"The Quiet Vale" — "a small mountain valley in early spring, 
recovering from a long winter, watched over by old gods."
```

### Step 2 — Tone & vibe (2 min)

Tap-based multi-select with a handful of seed tones, plus free-text "add your own."

```
How should the world feel? (pick 2-4)
[ cozy ]  [ whimsical ]  [ mysterious ]  [ adventurous ]
[ melancholy ]  [ gentle ]  [ grand ]  [ small-scale ]
[ dreamlike ]  [ grounded ]  [ humorous ]  [ reverent ]

And what should it NEVER be?
[ grimdark ]  [ violent ]  [ horror ]  [ cynical ]
[ explicit ]  [ political ]  [ preachy ]
```

Then:

```
Give me a taste of the voice — write 2-3 sentences in the tone
you want, as if narrating the opening of the story.
[text input, Sonnet-assisted optional]
```

The prose sample is gold. It's injected into every narrative generation's system prompt as "the narrator sounds like this."

### Step 3 — Style anchor (3 min)

Visual direction. Three parallel generators produce candidate style images; family picks one (or regenerates).

```
"Pick or describe the visual style."

Quick pick:
[ Ghibli watercolor ]   [ Chunky pixel art ]
[ Ink & wash ]          [ Cozy 3D render ]
[ Storybook illustration ] [ Nordic folk art ]
[ Describe your own... ]

[if "describe your own":]
"Describe the look and feel in a sentence or two."
[text input]

[then:]
"Generating 3 candidates..."
[3 FLUX.2 generations of a simple reference scene 
 — "a small cottage in a clearing at dusk" — in the requested style]

[ pick A ] [ pick B ] [ pick C ] [ regenerate all ]
```

The picked image becomes `style_anchor.ref_id`. Its prompt becomes `style_anchor.descriptor`. From this point on, every FLUX.2 call includes this image as a style reference.

### Step 4 — Characters (5 min)

One character per family member participating, plus optional pets / signature NPCs.

```
"Let's make each player's character."

For each family member:
  [they take a turn]
  
  "What's your character's name or pseudonym?"
  [text input]
  
  "Describe them — how they look, what they're like."
  [text input, 2-3 sentences encouraged]
  
  "Anything they carry or wear that should always appear?"
  [text input, optional]
  
  [Generate 3 candidate portraits against style anchor]
  [pick one, or regenerate]
  
  [optional: generate 2 more angles against the picked portrait
   for 3-view character ref sheet → improves consistency downstream]
```

Each character becomes an entity with:
- A `character_ref` component holding 1-3 images.
- A link to the user_id (permission).
- A displayed `pseudonym`.

The character ref images are passed to FLUX.2 whenever the character appears in a generated scene. This is what keeps character art consistent across all future locations.

### Step 5 — Biomes (3 min)

```
"What kinds of places exist in this world? Pick the ones you want."

Common:
[ village ] [ forest ] [ meadow ] [ inn ] [ river ]
[ home ] [ market ] [ farm ]

Adventurous:
[ mountains ] [ caves ] [ ruins ] [ tower ] [ deep forest ]
[ coast ] [ lake ] [ mysterious grove ]

Far:
[ desert ] [ tundra ] [ ocean ] [ sky realm ] [ under-realm ]

[ Add a custom biome... ]
```

For each picked biome, generate a candidate establishing shot. Family picks or regenerates. Each becomes a `biome_ref` entity.

### Step 6 — Facts & taboos (2 min)

```
"Any fixed facts about this world the story should never contradict?"
[text input, multi-line]

Examples:
- "Magic returned to the world five years ago."
- "The old king died childless; the vale has no central ruler."
- "Dogs can speak here, but only when no one's listening."

"Anything you want to make sure NEVER shows up?"
[text input, multi-line]

Examples:
- "No violence against children."
- "No real-world brands or celebrities."
- "Nothing that makes Jason scared."
```

Facts and taboos are injected into every generation prompt as hard constraints.

### Step 7 — Theme preview (1 min)

Theme generation kicks off in the background during earlier steps. By now it's ready.

```
"Here's how your world will look and feel."

[Preview of the app with generated theme applied]
[ Looks right ] [ Regenerate ] [ Tweak... ]
```

See `10_THEME_GENERATION.md` for the theme generation flow.

### Final — Review and commit

```
"Your world is ready."

[Summary card showing: name, tagline, tone tags, style, character 
 portraits, biome list, facts, taboos, theme preview]

[ Start playing ] [ Back to edit ]
```

Commit persists the full WorldBible entity tree. Player is placed at a starter location (auto-generated from biome-0 + opening prose).

## Prompts used in the builder

### Style candidate generator

```
<style_request>{user_description}</style_request>

Generate a single establishing image: a small cottage in a clearing 
at dusk, with a warm light in the window. Rendered in the requested 
style. No text, no people, no characters. Square aspect, 1:1.

[FLUX.2 [pro], 1MP, 3 variants in parallel]
```

### Character portrait generator

```
<character>{user_description}</character>
<style_anchor>{style_anchor.descriptor}</style_anchor>

Generate a portrait of this character, 3/4 view, neutral expression, 
plain background, matching the style anchor. The character should 
feel alive, specific, and consistent with the descriptions.

[FLUX.2 [pro], 1MP, refs: [style_anchor.ref_id]]
```

### Character 3-view sheet (optional, improves downstream consistency)

Generated from the picked portrait:

```
Generate a character reference sheet: the same character shown in 
three views — front, 3/4, and back — against a plain background, 
all consistent with the provided reference image.

[FLUX.2 [pro], 16:9, refs: [portrait_ref, style_anchor.ref_id]]
```

### Biome establishing shot

```
<biome>{biome_name}: {biome_description}</biome>
<style_anchor>{style_anchor.descriptor}</style_anchor>

Generate an establishing shot of this biome — a representative 
view that captures its mood and typical features. No characters, 
no text. 16:9 landscape.

[FLUX.2 [pro], 2MP landscape, refs: [style_anchor.ref_id]]
```

## The family dynamics piece

The builder is designed for **one device passed around**, not separate devices. This is deliberate:

- Each step surfaces to whomever is holding the device.
- Character creation is turn-based: each family member takes the device when it's their character's turn.
- Voice input (Whisper WebGPU) is available so a 7-year-old can describe their character verbally while an adult types.
- Parents can override kids' inputs for rating/taboo concerns before commit; this goes into the mentorship log with reasoning.

## Saving, reopening, editing

The bible is a first-class artifact, editable after commit. Later edits go through the standard prompt-edit flow (see `11_PROMPT_EDITING.md`). World owners can edit; family-mods can suggest edits for owner approval.

Editing the bible after play has started **does not retroactively edit existing locations**. New locations generate against the current bible; old ones remain authored as they were. If the family wants to retroactively update, they can run a "re-theme" action that regenerates art for old locations against the new style anchor (costs money; confirmation required).

## Time & cost

Build time target: 10-15 minutes active, plus a few minutes of parallel AI gen during steps 5-7.

Cost per world bible creation:
- Opus tone/prose assists: ~$0.05
- Style candidates (3 images): ~$0.09
- Character portraits (5 people × 3 candidates): ~$0.45
- Character 3-view sheets (5 × optional): ~$0.15
- Biome establishing shots (6 biomes × 3 candidates): ~$0.54
- Theme generation (see `10_THEME_GENERATION.md`): ~$0.02
- **Total: ~$1.30 per world bible.**

Regeneration of any component costs marginal per-image rates.

## Storage

- Bible entity + components: ~5-15KB text per world. Cheap.
- Reference images: ~300KB each. ~10 refs per world = ~3MB per world in R2. Basically free.
- Reusable across branches of the same world (forking doesn't duplicate refs; branches share by default, override when explicitly edited).

## Bible in prompts

The full bible is serialized into the system prompt for every generation call with `cache_control: {type: "ephemeral"}`. Anthropic charges 1.25x for first write, then 0.10x for reads within 5 minutes (auto-extended on hits). A busy session amortizes the cache write over hundreds of reads — net cost for bible context per call is negligible after the first call.
