# Weaver — Prompt-Based Editing

## Goal

Every artifact in Weaver is editable by prompt. A player wants to change a location's mood? They tap "Edit with prompt," describe the change, Opus rewrites. They want the merchant's portrait to look more mysterious? Same affordance, FLUX Kontext edits the image. The pattern is identical across all artifact types.

## Universal affordance

On any artifact (location, inline script, module, image, character ref, biome ref, world bible, theme, NPC, item), a long-press or menu affordance reveals:

```
┌─────────────────────────────┐
│  ✏️  Edit with prompt       │
│  ✏️  Edit directly          │ (advanced / desktop)
│  🔄  View history           │
│  📋  Copy id                │ (debug)
└─────────────────────────────┘
```

"Edit with prompt" opens a modal:

```
┌───────────────────────────────────────┐
│  Edit: The Old Clearing               │
│                                       │
│  [Describe the change you want]       │
│  [                                  ] │
│  [                                  ] │
│  [                                  ] │
│                                       │
│  Voice input: 🎤                      │
│                                       │
│  [Cancel]            [Preview edit]   │
└───────────────────────────────────────┘
```

On Preview:
- For text artifacts (locations, scripts, themes): show a diff view — left side current, right side proposed — with accept/reject.
- For images: show current and 3 proposed variants side by side; pick one or regenerate.

On Accept: new version created, authored attribution updated (edit_by_<pseudonym>), mentorship log entry written, rollback preserved.

## Edit types by artifact

### Location JSON edit

Current location JSON + user prompt → Opus → new location JSON → validate → diff.

Prompt:

```
<s>
You edit a location in a collaborative world-building game.
The edit must preserve the location's id and basic shape.
Return only valid JSON matching the LocationSchema. 
Facts must not contradict the world bible. Tone must match.
</s>

<world_bible cached=true>{...}</world_bible>
<current_location>{...json...}</current_location>
<user_request>{user_prompt}</user_request>

Return the updated location JSON only.
```

Validation on response:
- Zod parse.
- Consistency check against world bible.
- All option targets remain resolvable.
- `state_keys` still cover all used template vars.

On validation fail: up to 2 retries with the error feedback; if still failing, reject with an actionable message.

Cost: ~$0.04 per edit (cached bible, small location input/output).

### Inline script edit

Same pattern, but:
- Opus is given the current script source + the Weaver grammar (from `03_INLINE_SCRIPT.md`, pre-summarized).
- Response is raw script source, not JSON.
- Validation: parser + static validator + property-based sanity test (100 random valid inputs, no crash).

### Character ref / NPC portrait edit

Uses FLUX Kontext via fal.ai — reference-preserving image edit.

```ts
const result = await fal.subscribe("fal-ai/flux-kontext", {
  input: {
    prompt: user_request,
    image_url: current_ref_image_url,
    style_reference_url: world_bible.style_anchor.ref_id_url,
    guidance_scale: 3.5,
    num_images: 3,  // 3 variants
  },
})
```

Output: 3 new image variants. User picks or regenerates. Picked image becomes the new version of the ref entity; downstream generations start using it immediately.

Cost: ~$0.09 per edit (3 variants × $0.03).

### Location art edit

Same pattern as character portrait but with:
- Reference: current location art.
- Additional refs: world bible style anchor + any characters present in the scene.
- Prompt includes location description for context.

### Theme edit

Simpler — edit is a descriptor change. The user prompt modifies the theme's descriptor or specifies direct overrides (e.g., "make it darker, more forest greens"). Opus regenerates the ThemeSchema with the new descriptor; validation and accept flow as usual.

### World bible edit

Breaking change: editing the world bible DOES NOT retroactively edit existing locations/characters/etc. New generations use the new bible; old ones remain as authored.

Optionally, a "retro-apply" action exists: regenerate art for existing locations against the new style anchor. Costs money; confirmation required with cost estimate ("This will cost ~$X to regenerate art for Y locations. Proceed?").

## Versioning

Every artifact has a version history stored in `artifact_versions`. Each version row carries a **content-addressed blob hash**, not the payload itself (see `12_BLOB_STORAGE.md`):

```ts
{
  artifact_entity_id: "forest_clearing_42",
  version: 3,
  blob_hash: "blake3:a1b2c3d4...",      // canonicalized JSON payload in the blob store
  author_user_id: "user_jason",
  author_pseudonym: "Stardust",
  edit_kind: "edit_prompt",
  reason: "made the clearing feel more twilight",
  created_at: 1744844400000,
}
```

On every edit (prompt or direct), the new payload is canonicalized, hashed, written to the blob store if the hash is new, and a version row is inserted pointing at that hash. The live entity row's `current_version` field is updated to point at the new version. **Rollback is a pointer update** — restoring an earlier version writes a new `artifact_versions` row with `edit_kind: "restore"` and the prior version's `blob_hash`; no payload copy.

Identical payloads dedupe automatically (two users editing to the same final text write one blob). See `12_BLOB_STORAGE.md` for the hash algorithm, canonicalization rules, and storage tiers.

## Permissions

Three roles per world:

- **Owner** — created the world. Can edit anything. Transferrable.
- **Family-mod** — promoted by owner. Can edit anything, but edits carry attribution noting the mod acted on behalf of the original author when applicable.
- **Player** — can edit artifacts they authored; can suggest edits to others' artifacts (goes to mod queue).

Permission check happens in the edit mutation. Denied attempts are logged (mentorship log) with reason.

## The mentorship log entry

Every edit writes a row to `mentorship_log`:

```ts
{
  user_id: "user_jason",
  scope: "location_edit",
  context: { artifact_id: "forest_clearing_42", artifact_type: "location" },
  ai_suggestion: {...what Opus proposed...},
  human_action: "accept" | "reject" | "modify",  // what the user did
  before: {...previous version payload...},
  after: {...new version payload...},
  note: "user added a detail Opus missed about the stump's age",
  created_at: 1744844400000,
}
```

The log is append-only. Privacy: users can browse their own entries as "Things I've Taught the World." Family owners can see all entries in their world. Never exposed cross-world.

Later (Wave 3+), distilled per-family into a style preference profile that subtly steers Opus's defaults.

## Diff UX

For text artifacts, diff view uses a three-way merge visualization:

```
┌─────────────────────┬─────────────────────┐
│ Before              │ After               │
├─────────────────────┼─────────────────────┤
│ You stand in a      │ You stand in a      │
│ small clearing      │ small clearing at   │
│ ringed by birches.  │ dusk, ringed by     │
│                     │ silvered birches.   │
│                     │ The first stars     │
│                     │ show through the    │
│                     │ canopy.             │
└─────────────────────┴─────────────────────┘
    [Reject]   [Modify]   [Accept]
```

`Modify` opens the after panel as editable — user can tweak Opus's output before accepting. Final accepted text is what commits, not necessarily Opus's exact output. The mentorship log captures the difference (Opus said X, human adjusted to Y).

For images, diff view is two images side by side:

```
┌───────────┬───────────┐
│ Current   │ Variant A │  Variant B   Variant C
│  [img]    │  [img]    │  [img]        [img]
└───────────┴───────────┘
    [Reject all]   [Regenerate]   [Accept A/B/C]
```

For JSON and scripts, a structural diff (like GitHub's) highlights added/removed fields or lines.

## Concurrent edits

If two users try to edit the same artifact at the same time, last-write-wins at the version level, but a warning shows: "This artifact was edited by Jason 30 seconds ago. Review their change first?"

The edit modal shows the other person's pending/recent edit alongside, allowing the current user to merge intents.

## Direct edit (advanced)

For technical users (desktop only, behind a "show advanced" toggle), a direct-edit mode opens the artifact's JSON or script source in CodeMirror. Saving runs the same validators as prompt-based edit. Intended for edge cases where prompt-based iteration is too slow.

Not surfaced on mobile. Not the default path.

## Test coverage

Prompt-editing touches many artifacts, so it gets dedicated test suites:

- **Unit**: each edit kind has 10+ positive + negative cases.
- **Property**: random valid artifacts × random plausible edit prompts → result is always either a valid new version or a clean rejection.
- **Replay corpus**: 20+ recorded edit sessions in the corpus. Replayed on every PR.
- **VLM eval**: after image edits, sample 20% of edits through the screenshot eval to ensure visual quality didn't regress.

## Cost summary

Per edit:
- Text artifact (location, script, theme): ~$0.04 (cached bible, small delta)
- Image artifact (character, location art): ~$0.09 (3-variant FLUX Kontext)
- World bible edit: ~$0.08 (larger context, larger output)

Expected Wave 1 family cost for editing: very small. A family that edits ~20 artifacts per week: ~$1/week in edit costs on top of normal play.
