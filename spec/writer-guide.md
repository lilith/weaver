# Weaver — Writer's Guide

*For creative writers organizing source material for import into a Weaver world.*

## What this is

Weaver is a text-adventure world engine. A **world** is a collection of **locations**, **characters**, **NPCs**, **items**, and a **world bible** that anchors tone, style, and canon. The engine consumes structured files; this guide shows you what structure and where natural prose lives inside it.

You write prose. The importer converts your files into the engine's internal entity shape. Your job is to deliver the material in a consistent, referenceable form — not to write code, JSON, or schemas.

## What the engine does with your material

When a player visits a place you wrote, the engine:

1. Renders your prose description to the screen.
2. Swaps `{{variables}}` with live state (time of day, weather, whether the player's been here before).
3. Shows the choices you listed.
4. If the player chooses something you defined, it follows your link.
5. If they type free-text or choose something you *didn't* define, the AI extends your world by generating the next place in your style — which is why the world bible matters so much.

Your source material becomes the **canonical spine**. Everything the AI generates later is anchored to that spine via your bible.

## File layout

Everything lives under a single source directory. Example:

```
my-world/
├── bible.md                    # world bible — the one required file
├── biomes/
│   ├── forest.md
│   ├── village.md
│   └── chapel-ruins.md
├── characters/
│   ├── mara.md                 # player characters + core NPCs
│   ├── jason.md
│   └── old-halvard.md
├── locations/
│   ├── village-square.md
│   ├── forest-clearing.md
│   ├── forest-deep.md
│   └── chapel-tower.md
├── items/
│   ├── flint.md
│   └── snowglobe.md
├── npcs/
│   └── violet-the-barmaid.md
└── dialogue/
    └── halvard-greetings.md    # optional; pools of dialogue fragments
```

One entity per file. Filename becomes the entity's stable `slug` (hyphenated, lowercase). Subdirectory says what *kind* of entity it is. If in doubt about what directory something goes in, use the primary identity: a "chapel-ruins" that's a place goes in `locations/`; if it's a type of place used by many locations, it goes in `biomes/`.

## Frontmatter convention

Every file starts with a YAML header delimited by `---`, followed by prose. Fields are documented per-type below. Unknown fields are ignored by the importer (so drafts can carry notes without breaking).

```markdown
---
slug: forest-clearing            # optional; defaults to filename
name: A small clearing
biome: forest
connects:
  n: forest-deep
  s: village-square
  e: forest-creek
tags: [has_chat, safe_anchor]
author: Stardust
---

You stand in a small clearing ringed by pale birches. An old stump
occupies the center.

## Choices

- **Examine the old stump** — Rings uncountable. Older than any living memory.
- **Head deeper into the forest** → forest-deep
- **Return to the village** → village-square
```

This is a writer-facing format. The importer translates it into the engine's internal shapes. You never need to see or edit the underlying schema.

## 1. The world bible

**File:** `bible.md` (required, one per world).

The bible is the canonical reference set every AI generation reads. Writers hate writing "style guides" but this one is *used* — every future generation is cached against it, so time spent here pays compound interest.

### Template

```markdown
---
name: The Quiet Vale
tagline: A small mountain valley in early spring, recovering from a long winter, watched over by old gods.
content_rating: family                # family | teen | adult (default family)
creativity: balanced                  # grounded | balanced | maxed
---

## Tone

**Feels like:** cozy, gentle, slightly whimsical, reverent of quiet things
**Never:** grimdark, cynical, nihilist, body horror, preachy

**Voice sample** *(2–3 sentences in the narrator's voice)*:

> The wind moved through the birches with an old kind of patience.
> Mara pulled her cloak tighter and watched her breath rise. Somewhere
> downhill, a kettle was starting to sing.

## Style anchor

**Visual:** cozy watercolor, soft ink lines, warm muted palette, Ghibli-adjacent
**Reference scene:** a small cottage in a clearing at dusk with a warm light in the window.
*(the engine generates the canonical reference image from this description during import)*

## Established facts

These are true and will never be contradicted:

- Magic returned to the world five years ago, after a century of silence.
- The old king died childless; the Vale has no central ruler.
- Dogs can speak here, but only when no one's listening.
- The chapel stands at the south end of the village.

## Taboos

Never introduce:

- Violence against children.
- Real-world brands or celebrities.
- Anything that would frighten Jason (age 8).
- Explicit content of any kind.

## Themes and motifs

*(Optional. Threads the AI can draw on when extending the world.)*

- Small kindnesses matter more than grand gestures.
- The world is recovering; ruin is visible but not central.
- Animals and weather are half-characters.
```

The **voice sample** is the single most impactful thing in this file. It's injected into every narrative generation as "the narrator sounds like this." Write it with care; rewrite it three times.

## 2. Biomes

**Files:** `biomes/<slug>.md`. One per type-of-place that multiple locations share (forest, village, inn, ruins). Six to twelve biomes is typical for a small world.

### Template

```markdown
---
slug: forest
name: The birch forest
tags: [outdoor, wild, diurnal]
---

Cool, quiet, pale-trunked birches standing in loose ranks. Mossy ground,
patches of sunlight. The occasional deer trail. Streams are frequent
and small. Nothing dangerous, but the woods hide things — old stone
cairns, older things beneath them.

## Establishing shot

*(What the engine should generate as the canonical image for this biome.
Used as a style reference for every location of this type.)*

A wide view of a birch forest in late afternoon, gentle low sun through
the trunks, a faint path winding out of frame, no characters, cozy
watercolor style.
```

**Keep biome descriptions atmospheric, not geographic.** Don't say "there are 200 trees" — say "loose ranks of pale trunks." The AI extrapolates.

## 3. Characters

**Files:** `characters/<slug>.md`. Player characters AND recurring core NPCs who travel across locations. One-off NPCs tied to a single place go in `npcs/` instead (see §5).

### Template

```markdown
---
slug: mara
name: Mara
pseudonym: Mara                       # display handle shown in UI
role: player_character                # player_character | core_npc | pet
tags: [human, adult, woodworker]
always_wears: ["a green cloak", "a silver ring on the right hand"]
---

Mara is in her late twenties, small, watchful. Grew up in the Vale, left
for a decade, came back last spring. Carpenter by trade. Speaks only when
she has something to say. Walks with a very slight limp nobody remembers
the cause of.

## Portrait prompt

*(What the engine should generate as the canonical character portrait.
Reference sheets get generated from this — front, 3/4, back views — so
she looks consistent across all scenes she appears in.)*

A 3/4 portrait of a young woman, late twenties, short dark hair, green
cloak with a silver ring visible on her right hand, quiet watchful
expression, cozy watercolor style.

## Voice / speech

Terse. Doesn't soften statements. Dry humor when she does joke.
Example: "The roof leaks. We fix it or we move."

## Relationships

*(Optional. Informs how the AI writes interactions with other characters.)*

- **old-halvard** — she respects him but thinks he's wrong about the old gods.
- **jason** — treats him like a younger brother; patient, slightly amused.
```

**Portrait prompt field is load-bearing.** The character ref image generated from this description becomes the style reference for *every* scene this character appears in. Consistent art across the world depends on it being precise — physical details, signature clothing, facial structure.

## 4. Locations

**Files:** `locations/<slug>.md`. The meat of the world. A location is a place with prose, a scene image, and a set of choices.

### Template

```markdown
---
slug: forest-clearing
name: A small clearing
biome: forest
coords: { q: 4, r: -2 }                # optional hex coords; omit if you don't care
connects:
  n: forest-deep
  s: village-square
  e: forest-creek
tags: [has_chat]                       # has_chat | safe_anchor | combat_allowed
author: Stardust                       # your pseudonym
---

You stand in a small clearing ringed by pale birches.
{{weather_rain? Rain taps softly against the leaves.}}
{{visited? The path back to the village curves behind you.}}
An old stump occupies the center.

## Choices

- **Examine the old stump** — Rings uncountable. Older than any living memory.
  - *sets:* `stump_examined = true`

- **Head deeper into the forest** → forest-deep

- **Return to the village** → village-square

## Scene art

*(Optional. If omitted, the engine generates one against the biome's style.)*

A small clearing in a birch forest, a large stump in the center,
late afternoon light, cozy watercolor.

## Notes

*(Optional. For the importer and future editors. Not shown to players.)*

This is a natural safe-anchor candidate after Jason's first trip deep
into the forest; consider marking `safe_anchor: true` after playtest.
```

### Variable interpolation — the `{{... ?}}` shorthand

Writers shouldn't need to learn the engine's template grammar. The importer accepts a **writer-friendly shorthand**:

| You write | Meaning |
|---|---|
| `{{weather_rain? text}}` | Show `text` only if it's raining. |
| `{{visited? text}}` | Show `text` only if the player has been here before. |
| `{{night? text}}` | Show `text` only if it's nighttime. |
| `{{!fire_lit? text}}` | Show `text` only if the fire is NOT lit. |
| `{{character.name}}` | Insert the visiting player's character name. |
| `{{time_of_day}}` | Insert "dawn", "morning", "afternoon", "dusk", "night". |

The importer expands these to the engine's real template syntax. Stick to this shorthand in your files and you never need to touch the engine's internals.

**If you need something not in the shorthand above**, leave a plain-English note in the prose like `{{TODO: only show if Mara is still in the village}}` — the importer will flag it for a developer to wire up.

### Choices — four kinds

1. **Flavor choice** — describes something, no navigation. The prose after the em-dash is what the player sees when they pick it.
   ```markdown
   - **Examine the old stump** — Rings uncountable. Older than any living memory.
   ```

2. **Navigation** — go somewhere else.
   ```markdown
   - **Head deeper into the forest** → forest-deep
   ```

3. **Conditional navigation** — only visible when a condition is met. Use `[if ...]` in the bullet.
   ```markdown
   - **Rent a room for the night** [if gold >= 5] → inn-bedroom-3
   - **Light the fire** [if has flint, if fire not lit]
   ```

4. **Effect + flavor** — does something to the world state.
   ```markdown
   - **Drink from the spring** — Cold. Clean. You feel rested.
     - *sets:* `character.rested = true`
     - *takes:* 1 water_skin
   ```

**Do not** write inline scripts or code in your files. If a choice needs real logic (branching, random encounters, combat), describe it in prose in a `## Notes` section and a developer will upgrade it to a script or module. The importer will mark that location as "needs developer pass."

### Hooks: `## On arrive` and `## On leave`

Optional sections. What happens when the player enters or exits this location.

```markdown
## On arrive

- *increments:* `visits` by 1
- *says:* The birches sigh in the wind as you step into the clearing.

## On leave

- *clears:* `warmed_by_fire`
```

Keep these simple. If you find yourself writing more than a few bullets here, the location probably wants to be an encounter (a richer, multi-step thing) — note that in `## Notes` and leave it for a developer.

## 5. NPCs (location-bound)

**Files:** `npcs/<slug>.md`. For NPCs that live in one place (the barmaid at the inn, the blacksmith, the weaver), as opposed to core NPCs who travel (which go in `characters/`).

```markdown
---
slug: violet-the-barmaid
name: Violet
lives_at: inn-common-room
tags: [adult, warm, talkative]
---

A middle-aged woman with flour-dusted forearms and a ready laugh.
She's been pouring drinks at this inn for twenty years and has
opinions about everyone who's ever passed through.

## Portrait prompt

Middle-aged woman behind a wooden bar, warm smile, hair tied back with
a cloth, flour dusting her forearms, cozy watercolor style.

## Voice / speech

Warm, quick, a little teasing. Asks more questions than she answers.
Remembers names.

## What she knows

*(Facts the AI can draw on when the player chats with her. Keep them
short — the AI will extrapolate within your tone.)*

- Halvard comes in every Thursday for one ale and no conversation.
- The old chapel south of the village has been locked since autumn.
- She's never been past the forest edge and has no plans to.
```

**Writing dialogue:** don't script full conversations. Give the AI the character's voice (above) + "what she knows" + one or two example lines. Chat generation will stay in-voice.

Optional: a `## Sample lines` section with 3–5 example one-liners in her voice gives the AI an even tighter anchor.

## 6. Items

**Files:** `items/<slug>.md`. Short — items are mostly a name, a description, and a few tags.

```markdown
---
slug: snowglobe
name: Snowglobe of the Ice Realm
tags: [artifact, fragile, magic]
stackable: false
---

A heavy glass sphere on a pewter base. Inside, a tiny snow-covered
pine stands impossibly sharp and detailed. If you shake it, the snow
falls for longer than it should.

## Portrait prompt

A small snowglobe on a pewter base, a tiny detailed pine tree inside
with falling snow, sitting on a wooden table, cozy watercolor style.
```

## 7. Dialogue pools (optional)

**Files:** `dialogue/<slug>.md`. Pools of lines the AI can draw on for specific characters or situations. Purely optional — most worlds won't need this.

```markdown
---
slug: halvard-greetings
character: old-halvard
trigger: first_meeting_of_day
---

Pool of one-liners Halvard might open with when a player greets him
for the first time on a given in-game day. The engine picks one at
random (weighted slightly toward lines that haven't been seen recently).

- "Morning."
- "You're up early."
- "The chapel bell didn't ring today. Did you notice?"
- "Watch your step near the old well. Ice."
```

## 8. Attribution

The `author` field in location frontmatter is your pseudonym as it appears on the in-game byline ("✦ discovered by Stardust"). Use a single consistent pseudonym across all your files for a given world. Multi-author worlds use different pseudonyms per author.

If you write a location on commission for another author's world, use *their* pseudonym, not yours. Attribution is about in-world authorship, not professional credit.

## 9. What NOT to write

Writers sometimes want to reach into the engine. Don't.

- **No code, no JavaScript, no JSON.** If you catch yourself writing curly-brace structures beyond the `{{shorthand?}}`, stop.
- **No combat mechanics.** Combat is its own system. Describe the *scene* that leads into combat; leave the mechanics to the encounter module.
- **No inventory mechanics beyond simple `gives:` / `takes:`.** Crafting, trading, durability — all module territory. Describe the intent in prose; a developer wires it.
- **No explicit save/load, version pinning, or state keys.** The engine handles those.
- **No hard cross-references to future content.** If location A says "you'll want to come back here once you have the snowglobe," that's fine; but don't try to define the snowglobe's future behavior *inside* location A.

When in doubt: write in prose, flag in `## Notes`, a developer picks it up.

## 10. Content safety (reminder)

Weaver worlds default to a **family** content rating. Even in teen- or adult-rated worlds, consider who might sit next to the player. Guidelines:

- No graphic violence, sexual content, or self-harm, regardless of rating, unless the bible explicitly opts in.
- No real-world public figures.
- No real-world personal identifiers (addresses, schools, phone numbers).
- Fear and tension are fine; horror imagery for minors is not.

The bible's `taboos` list is authoritative. Re-read it before submitting.

## 11. Import checklist

Before handing off your directory to the importer:

- [ ] `bible.md` present and fully filled in (tone, voice sample, style, facts, taboos).
- [ ] Every `biome:` referenced in a location has a matching `biomes/<slug>.md`.
- [ ] Every `→ slug` in a location choice points to an existing file OR is deliberately left as a stub for the engine to expand on first visit (flag these in `## Notes`).
- [ ] Every character mentioned by name in prose has either a `characters/<slug>.md` or `npcs/<slug>.md`.
- [ ] Every `{{shorthand?}}` is one of the documented forms, or marked `{{TODO: ...}}` for a developer.
- [ ] At least one location has `tags: [safe_anchor]` — the default "when in doubt, send player here" place.
- [ ] Author pseudonym consistent across files.
- [ ] Taboos list reviewed; nothing in your content violates it.

## 12. Tiny complete example

The smallest world the importer accepts:

```
tiny-world/
├── bible.md
├── biomes/
│   └── village.md
├── characters/
│   └── mara.md
└── locations/
    ├── village-square.md
    └── mara-cottage.md
```

**`bible.md`:**

```markdown
---
name: The Quiet Vale
tagline: A small mountain village, just after dawn.
content_rating: family
---

## Tone
**Feels like:** cozy, gentle, small-scale
**Never:** grimdark, cynical

**Voice sample:**
> The air was cold and smelled of woodsmoke. Somewhere a dog was
> barking without urgency.

## Style anchor
**Visual:** cozy watercolor, warm palette, soft ink lines.

## Established facts
- It is early spring.
- The village has one inn and no formal authority.

## Taboos
- No violence against children.
```

**`biomes/village.md`:**

```markdown
---
name: The village
tags: [settled, friendly]
---

A handful of stone cottages on a hillside, threaded with cobbled lanes
and overgrown kitchen gardens. Smoke from a few chimneys.
```

**`characters/mara.md`:**

```markdown
---
name: Mara
pseudonym: Mara
role: player_character
---

Mara is in her late twenties, short, watchful, a carpenter. Green cloak,
silver ring. Doesn't talk unless she has something to say.

## Portrait prompt
Late-twenties woman, short dark hair, green cloak, silver ring on right
hand, watchful expression, cozy watercolor style.
```

**`locations/village-square.md`:**

```markdown
---
name: The village square
biome: village
connects:
  n: mara-cottage
tags: [safe_anchor]
author: Stardust
---

A cobbled square with a well at its center. A chicken looks at you with
something like disappointment. {{visited? Smoke still curls from
Mara's chimney uphill.}}

## Choices

- **Draw water from the well** — The rope is cold. The bucket comes up
  full and slightly muddy.
- **Walk up to Mara's cottage** → mara-cottage
```

**`locations/mara-cottage.md`:**

```markdown
---
name: Mara's cottage
biome: village
connects:
  s: village-square
tags: [has_chat, safe_anchor]
author: Stardust
---

A one-room cottage that smells like pine shavings and tea. Mara looks
up from a piece of furniture she's building and nods.

## Choices

- **Ask what she's making** — "A cradle." She doesn't elaborate.
- **Warm yourself by the fire** — You thaw slowly.
- **Step back out** → village-square
```

That's a complete, importable world. Everything else — rain, day/night, weather systems, combat, new locations the player discovers — the engine handles on top of your spine.

## 13. After import

Your source directory is the authoritative draft. After import:

- The engine creates entity rows from your files, one per file.
- Art generation queues up (style anchor first, then character refs, then scene art).
- Every generated image lands in a `ref_id` — editable later by prompt if the first generation isn't right.
- The bible is cached into every AI call automatically.

If you edit a source file after import and re-run the importer, it treats your files as a new **version** of each entity. The engine keeps the history. Players see the new version from their next visit; existing play state is preserved.

## Questions the engine will ask a developer (not you)

If you followed this guide, a developer reviewing your import only needs to resolve:

- Conditional logic beyond the shorthand (the `{{TODO: ...}}` markers).
- Anything in `## Notes` that flagged "needs developer pass."
- New shorthand forms you requested in `{{TODO: ...}}` that would be useful to add to a future version of this guide.

You're done. Hand off the directory and a sentence on what you want the starting location to be.
