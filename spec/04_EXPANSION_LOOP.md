# Weaver — Expansion Loop

## The magic feature

A player types "I climb the chapel tower" — or picks an option that leads to a location that doesn't exist yet — and the world grows to accommodate them. Within 2–4 seconds they have a text description of the new place. By next visit, it has art. They are attributed as its discoverer. The world bible keeps the new location consistent with everything else.

This is the single feature that turns Weaver from a finite authored game into an infinite co-authored one.

## Two triggers

1. **Free-text input.** Player types anything instead of picking an option. Free-text arrives either typed or as voice dictated via Whisper WebGPU (on-device, see `15_VOICE_INPUT.md`) — the classifier is agnostic to input method.
2. **Unresolved option target.** Any option's `target` points to an id that doesn't exist yet (stub created; expansion fires on arrival).

Both paths funnel through the same classifier → atom → handler pipeline.

## The pipeline

```
input ──→ intent classifier (Haiku) ──→ atom
                                          │
                                          ▼
                                 ┌────────────────────┐
                                 │  atom dispatcher   │
                                 └────────────────────┘
                                  │  │  │  │  │  │  │  │
                                  ▼  ▼  ▼  ▼  ▼  ▼  ▼  ▼
                              move ex tk ta at cl co nr
```

Eight atoms cover the input space:

| Atom | Meaning | Handler |
|---|---|---|
| `move` | Player wants to move to a known or described location | Resolve target; if new, call create_location |
| `examine` | Player inspects something in current scene | Generate description, no state change |
| `take` | Pick up an item | Inventory mutation; fail if not possible |
| `talk` | Address an NPC or speak aloud | Route to NPC dialogue flow |
| `attack` | Initiate combat | Emit `start_combat` event |
| `create_location` | Describe or ask about a place that doesn't exist | Spawn stub, queue generation |
| `create_object` | Bring a new object into being | Create item entity, place in scene |
| `narrative` | Pure prose action with no mechanical effect | AI narrates result, no state change |

## Intent classifier (Haiku 4.5)

The cheap model. One call per free-text input.

```ts
// convex/actions/classifyIntent.ts
import { action } from "./_generated/server"
import Anthropic from "@anthropic-ai/sdk"
import { z } from "zod"

const AtomSchema = z.object({
  atom: z.enum(["move", "examine", "take", "talk", "attack", "create_location", "create_object", "narrative"]),
  target: z.string().optional(),      // referenced entity, location name, npc name
  description: z.string().optional(), // if create_*, the description hint
  confidence: z.number(),
})

const SYSTEM = `You classify a player's free-text action in a text-adventure game.
Return strict JSON matching the schema. Be decisive.

Atoms:
- move: player moves to a location (existing or new)
- examine: inspect something in the current scene
- take: pick up an object
- talk: address an NPC or speak aloud
- attack: initiate combat
- create_location: describe or reach a place not yet in the world
- create_object: bring a new object into being in the scene
- narrative: prose action with no mechanical effect

If ambiguous, prefer narrative. If referencing a place/object/npc not in current context, prefer create_*.
`

export const classifyIntent = action({
  args: { input: v.string(), context: v.any() },
  handler: async (ctx, { input, context }) => {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const result = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      system: SYSTEM,
      messages: [
        { role: "user", content: [
          { type: "text", text: "CONTEXT:\n" + JSON.stringify(context) },
          { type: "text", text: "INPUT: " + input },
          { type: "text", text: "Return JSON only, no preamble." },
        ]},
      ],
    })
    const text = result.content[0].type === "text" ? result.content[0].text : ""
    const parsed = AtomSchema.parse(JSON.parse(text.trim()))
    return parsed
  },
})
```

Cost: ~500 input tokens + ~100 output = ~$0.0005 per free-text input.

## Atom handlers

Each atom has a deterministic handler that uses context + world bible + current state. Handlers call Opus only when genuinely needed (content generation), never for routine decisions.

### `move`

```
classify_atom(text="I go to the chapel") → {atom: "move", target: "chapel"}
  ↓
resolve_target("chapel") →
  if found in neighbors → move player
  elif found by name anywhere in world → path-resolve + move
  else → handler: create_location(hint="chapel") → move when ready
```

### `create_location` (the big one)

Generated locations land as **drafts** — author-only, not on the shared map — and accumulate into a **journey** until the character returns to a canonical location. See `19_JOURNEYS_AND_JOURNAL.md` for the journey/journal UX that lets players keep the dreams that mattered and let the rest fade. The old inline "save to map" card per-location is gone; the save decision is deferred to the journey's close.

```
classify_atom(text="I climb the chapel tower") → {atom: "create_location", description: "chapel tower"}
  ↓
generate_location_content (opus, 2-4s):
  prompt = world_bible (cached, 90% off) + neighbors + hint
         + bias-toward-known-biomes-and-locations prompt fragment
  opus returns JSON matching LocationSchema
  validate → insert entity with { draft: true, expanded_from_entity_id: <parent> }
  ↓
recordJourneyTransition(ctx, character, dest=draft):
  if no open journey: open one with dest as entity[0]
  else: append dest to journey entity list
  ↓
scheduleArtForEntity (fal.ai FLUX → R2 blob, async):
  action loads bible style + biome prompt + location prose
  FLUX.2 [pro] gen; download bytes; upload to R2 via S3
  internal mutation writes blob row + patches entity.art_blob_hash + art_status=ready
  (player probably already moved on; next visit shows art; storybook placeholder meanwhile)
  ↓
player moves back to a canonical location:
  recordJourneyTransition(ctx, character, dest=canonical):
    close current journey; set status=closed
  UI shows the single cluster panel: "You wandered through N places. Keep any?"
  user ticks a subset → journeys.resolveJourney batches saveToMap
```

**Click-into-nowhere chain.** When the player taps an option whose `target` slug doesn't resolve yet (Opus-generated options often reference places that don't exist — "Climb higher", "Step into the light"), `applyOption` returns `needs_expansion: { hint: option.label }` instead of failing silently. SvelteKit chains into the expansion action using the label as the hint, then redirects to the newly-created draft. One click still = one transition, with a ~5-8s Opus latency instead of a no-op.

### Biome-bias prompt pattern

Opus, given a broad world bible, tends to invent new biomes mid-world. That fractures the visual anchor and makes downstream art re-generation harder. The expansion prompt biases toward existing biomes and — where structurally appropriate — existing locations:

```
<expansion_guidance>
Prefer biomes that already exist in this world. Only invent a new biome if
the player's input genuinely describes somewhere outside every existing
biome's scope. The world's current biomes are:
  - forest: {description}
  - village: {description}
  - stone_tower: {description}

Prefer connecting the new location to existing neighbors where plausible.
Existing locations adjacent to "{parent_name}" include:
  - forest_clearing_42 (forest)
  - village_square (village)
</expansion_guidance>
```

Empirically this keeps Quiet Vale visually coherent across hundreds of drafts.

### Opus prompt template for `create_location`

```
<system>
You are Weaver, a collaborative world-building engine. You generate locations
that fit a specific world's established tone and style.

Return strict JSON matching the Location schema. Creativity is welcome in prose
and flavor. Facts and references MUST match the world bible exactly — do not
contradict established character traits, geographic relations, or tone.

Each location should:
- Have 2-5 interesting options a player could take
- Include at least one option that leads back toward known territory (safety)
- Not introduce characters or items not in the world bible without reason
- Be appropriate for the content rating of this world
</system>

<world_bible cached=true>
{
  "style_anchor": "cozy watercolor, soft ink outlines, warm palette",
  "tone": "gentle and curious, slightly whimsical, never grim",
  "content_rating": "family",
  "characters": [
    {"name": "Violet", "pseudonym": "Barmaid", "ref_id": "ref_violet",
     "description": "Human woman, 30s, warm auburn braid, green apron..."},
    {"name": "Stardust", "pseudonym": "Player Character",
     "description": "Small pomeranian with a star-shaped marking..."}
  ],
  "biomes": [
    {"id": "forest", "description": "Birch and oak forest, dappled light, ferns."},
    {"id": "village", "description": "Thatched cottages along a cobbled square."},
    {"id": "stone_tower", "description": "Weathered gray stone, narrow windows..."}
  ],
  "established_facts": [
    "The chapel stands at the south end of the village.",
    "Jason the potter has a kiln behind his cottage.",
    "The forest extends indefinitely to the north."
  ]
}
</world_bible>

<current_context>
<parent_location>{...JSON of parent...}</parent_location>
<neighbors>[...brief summaries of nearby locations...]</neighbors>
<recent_events>[...last 3 events in player's character log...]</recent_events>
<expansion_hint>"Jason climbed the chapel tower looking for ravens"</expansion_hint>
</current_context>

Generate the new location. Return only valid JSON.
```

Notes:
- `<world_bible>` is wrapped with `cache_control: {type: "ephemeral"}` — same content across many calls, 90% off per repeat read.
- `temperature: 1.0` with `top_p: 0.95`. High creativity, world-bible-constrained.
- Response capped at 2K tokens for location JSON.
- Cost per new location: ~8K input (cached: 0.8K effective) + 1.5K output = ~($0.004 + $0.0375) = ~$0.04.

### `narrative`

Free-form prose that has no mechanical effect. Player: "I sit by the fire and reflect on the day." Handler generates 1-3 sentences of flavor text via Sonnet (cheap narration), inserts into chat log (but not location description), no state change.

### `examine`

Player: "I look closely at the stump." Handler checks if there's an existing examine option; if yes, trigger it. If no, Sonnet generates a short paragraph from world bible + location description, inserted as an AI-narrated `say`.

### `take` / `create_object`

Take: resolve item in scene, move to inventory, error gracefully if not present or not takeable. Create-object: spawn item entity with author attribution, place in scene or inventory per phrasing.

### `talk`

Route to NPC. If NPC has a dialogue module, enter its flow. If not, Sonnet handles a 1-2 turn exchange against NPC character ref + personality notes, then returns.

### `attack`

Emit `start_combat` with target. Wave 1 combat is hardcoded (see `01_ARCHITECTURE.md`), so this hands control to the combat system. Wave 2 this is a module event.

## World bible prompt caching

The world bible is large (~5-15K tokens) and stable. Cached via Anthropic's ephemeral cache (5-min default TTL, auto-extended on hits).

```ts
const result = await anthropic.messages.create({
  model: "claude-opus-4-7",
  max_tokens: 2048,
  temperature: 1.0,
  system: [
    { type: "text", text: SYSTEM_PROMPT },
    { type: "text", text: renderWorldBible(bible),
      cache_control: { type: "ephemeral" } },  // 90% off on hits
  ],
  messages: [...],
})
```

Warm cache after an idle period: first hit of session pays the 1.25x write cost, every subsequent within 5 minutes pays 0.10x read cost. Cost amortizes quickly.

## Art queue

Image generation is never on the critical path of a player's action. It's always async:

```
enqueue_art(entity_id) →
  insert row into art_queue table: {entity_id, prompt, refs[], status: "pending"}
  ↓
art_worker (Convex scheduled action, runs every 10s):
  pick oldest pending row, mark "generating"
  build prompt from entity + world bible
  call fal.ai FLUX.2 [pro] with refs
  on success: upload to R2, update entity.art_ref, mark "ready"
  on failure: retry up to 3x, then mark "failed"
```

The first-visit experience:
1. Player enters new location at t=0.
2. Text description appears at t≈2-4s.
3. Biome-fallback image shown immediately (generic "forest" image from a pre-baked set).
4. Actual generated image replaces fallback when ready (usually t≈6-10s).
5. Player likely moves on before art is ready; next visit shows the specific image.

Cost per generated location image: ~$0.03 (FLUX.2 [pro], 1MP).

## Creativity knobs

| Knob | Wave 1 Default | Rationale |
|---|---|---|
| `temperature` (Opus location gen) | 1.0 | Max creative prose |
| `top_p` (Opus location gen) | 0.95 | Retain coherence |
| `temperature` (Haiku classify) | 0.0 | Deterministic classification |
| `temperature` (Sonnet narrative) | 0.9 | Flavorful but not wild |
| `temperature` (FLUX.2 guidance) | N/A | FLUX uses guidance scale; keep default |

Family can tune creativity per world via a world-settings entity: `creativity: "maxed" | "balanced" | "grounded"`. This maps to temperature presets.

## World bible stays consistent — how

The hard constraint enforcement is **not** "tell the model to be consistent." It's:

1. **Every generation call includes the full world bible.** No summaries, no partial — full (cached at 90% off).
2. **Validation after generation.** New location JSON is checked against world bible for contradictions:
   - Characters referenced must exist (fuzzy match).
   - Geographic claims must match established facts (simple predicate check).
   - Content rating must match.
3. **On contradiction, retry with correction prompt.** Up to 2 retries. If still invalid, flag for human review; fall back to a safe generic location.

Typical contradiction check (heuristic, cheap):

```ts
function checkConsistency(newLoc, bible) {
  const issues = []
  // Character references
  for (const name of extractCharacterNames(newLoc.description_template)) {
    if (!bible.characters.some(c => fuzzyMatch(c.name, name))) {
      issues.push(`Unknown character: ${name}`)
    }
  }
  // Content rating: simple keyword/pattern scan
  if (bible.content_rating === "family" && containsUnsafeContent(newLoc)) {
    issues.push("Content rating violation")
  }
  // Geographic claims (only check explicit ones)
  // ...
  return issues
}
```

## Attribution propagation

Every artifact created through the expansion loop carries:

- `author_user_id` — the user whose action caused creation.
- `author_pseudonym` — their per-branch handle.
- `discovery_context` — optional, the hint or free-text that triggered creation.
- `generator` — "opus-4.7-auto" or "opus-4.7-edit-by-<user>" or "human".

When rendered, the UI shows: `discovered by <pseudonym>`. If later edited by another user via prompt, the edit history shows both.

Never shown: the underlying `user_id`. Pseudonyms can be changed per-branch; the link to the real user lives in the `users` table, permission-gated.

## Moderation

Wave 1 safety is prompt-injected on every LLM call against the world's content rating (default `family`). No separate moderation pipeline, post-generation moderation pass, or Haiku classifier loop in Wave 1 — the per-family single-instance deployment model makes those unnecessary. See `16_PRIVACY_AND_MINORS.md` for the full rationale and what is deferred to Wave 4+ (public worlds).

The image-gen prompt safety suffix is applied uniformly: `Family-friendly, no gore, no violence, no suggestive content.` on any world with rating `family`.

## Rate limits & cost ceilings

The expansion loop enforces two kinds of ceiling: a per-world daily cost cap (budget-driven) and a per-user per-minute free-text rate (abuse-driven).

Specific numbers — per-world daily default, per-user per-minute rate, per-call cost estimates, graceful-degradation language — live in `14_COST_MODEL.md` alongside the rest of the cost model. This section documents the *mechanism*:

- The classifier always runs (cheap); it routes into handler dispatch regardless of budget state.
- Handlers that incur material cost (`create_location`, `create_object`, image gen) check the `cost_ledger` budget for the world before proceeding.
- Over-budget calls downgrade to a graceful fallback (generic stub location, biome fallback image) with an in-character "the world is resting tonight" message. Existing content stays fully playable.
- The per-user per-minute rate is enforced in the classifier's Convex action via a rolling-window check on `cost_ledger` entries by user.
- Users with `per_day_cost_cap_usd` set (e.g. minors per `16_PRIVACY_AND_MINORS.md`) hit their personal cap before the world cap — first one to zero wins.

## Testing the expansion loop

Covered in detail in `06_TESTING.md`. In brief:

- Golden corpus of 500 (input, context) → expected atom pairs. Haiku classifier accuracy target: >95%.
- Fuzzer generates random plausible inputs against random states, asserts no crashes.
- Consistency checker runs on every generated location in CI replay corpus.
- VLM screenshot eval checks that rendered location makes sense visually (options present, text coherent, art either ready or fallback).
