# Weaver — Privacy and Minors (Wave 1 family-instance posture)

## Context

Weaver is deployed **one instance per family**. Wave 1 has a single instance — Lilith's family — self-hosted by Lilith on her own Cloudflare / Convex / Anthropic / fal.ai accounts. No other family's data ever touches this deployment.

That shape collapses the privacy story. Lilith is not a third-party operator collecting data from other people's children; she's a parent running a game on hardware and accounts she controls, for her own family. COPPA's "operator" framing doesn't apply to single-household self-hosting any more than it applies to a family running a Minecraft server on a closet PC.

This document describes the Wave 1 posture. The full multi-tenant / public-worlds posture (guardian dashboards, chat moderation pipelines, post-gen moderation, replay-corpus anonymization, COPPA-operator compliance, cross-family trust) is **deferred to Wave 4+** and will be respecified when cross-family deployment actually lands.

## What Wave 1 still does

Small, high-value, cheap to implement:

### 1. Content rating = "family" (default and locked)

- Every world in this instance is rated "family." Immutable for Wave 1 — no UI to change it.
- Enforced via prompt injection on every LLM call:
  > The content rating of this world is "family." Do not generate content involving violence beyond cartoon slapstick, sexual content of any kind, explicit drug/alcohol content, self-harm, or graphic imagery. Keep tone suitable for young readers.
- Every image-gen prompt is appended with: `Family-friendly, no gore, no violence, no suggestive content.`
- FLUX.2 and Claude's built-in safety filters are the primary guard; the prompt guidance is a second layer.

### 2. No PII collected

- Auth is email (magic link) + self-chosen display name. No real names, addresses, phone numbers, school names, or birthdates stored.
- The schema is already shaped this way — do not add fields that collect PII without explicit approval.

### 3. Voice stays on-device

- Whisper WebGPU transcription only (`15_VOICE_INPUT.md`). Audio never leaves the browser. This is locked.

### 4. No analytics, no fingerprinting, no third-party SDKs

- No behavioral analytics, ever.
- No cross-device tracking.
- No advertising.
- No third-party SDKs on pages anyone visits. Convex + R2 (our own buckets) + our code, period.
- No data sales. Explicit and permanent.

### 5. `is_minor` + `guardian_user_ids` in schema

Kept — not for a full guardian-dashboard product, but because they're useful metadata even in single-family mode:

```ts
users: defineTable({
  email: v.string(),
  display_name: v.optional(v.string()),
  is_minor: v.boolean(),
  guardian_user_ids: v.array(v.id("users")),  // who the "grown-ups" are
  per_day_cost_cap_usd: v.optional(v.number()), // kid-specific budget; adults can be uncapped
  created_at: v.number(),
})
```

Concrete Wave 1 uses:
- **Per-user cost cap.** Minors default to $1/day; adults uncapped (the whole instance has a $500/mo Anthropic ceiling already). Stops a kid accidentally burning the budget with a regenerate-storm.
- **UI hint only.** "You're chatting with Jason" vs. "You're chatting with Lilith" — UI can soften prompts shown to younger users. No access-control surface beyond that.

`guardian_user_ids` is just metadata Lilith can read in the DB if she wants to; there's no dashboard for it in Wave 1.

## What Wave 1 explicitly does NOT do (deferred to Wave 4+)

These are all appropriate for cross-family / public deployments and wasted effort for a single-family instance. Leaving them out is a deliberate choice, not an oversight.

- Haiku post-generation moderation pass on every location / image.
- Chat message pre-post moderation pipeline.
- Guardian dashboard as a distinct UI surface.
- Weekly guardian digest email.
- Replay-corpus anonymization + per-session guardian approval.
- Data-export / data-deletion self-serve UX (if Lilith wants to nuke data she has DB access).
- Zero-retention Anthropic endpoint (only needed for cross-family).
- Formal COPPA / GDPR-K compliance documentation.
- Plain-language third-party data-flow disclosure page.

If any of the above start to feel necessary before Wave 4 (e.g. Jason's friend's family asks to share the instance), **stop and re-spec this document**. Don't incrementally drift toward multi-tenant privacy — it's a rewrite, not a patchset.

## Data flows (for the record)

Since this is a self-hosted instance, the "third parties" are just the upstream services Lilith is already paying for:

| Service | Sees | Why |
|---|---|---|
| Anthropic | World bible, location prose, player free-text, chat text on edit-prompt flows | LLM inference |
| fal.ai | Image prompts | Image gen |
| Cloudflare R2 | Generated image blobs, large JSON blobs | Storage |
| Convex | All app data (users, entities, chat, events, cost ledger) | Backend + DB |
| Resend | Email addresses + magic-link emails | Auth |

Each of those has its own retention policy on its side. Nothing else receives user data. Voice audio is not on this list because it never leaves the device.

## What happens when cross-family lands (Wave 4+)

This is a flag for future-us, not a spec:

- A cross-family deployment is a **different product**. It gets its own privacy document, its own moderation pipeline, its own trust architecture, likely its own Convex project with operator-role isolation, and probably a formal COPPA/GDPR-K review.
- Do not try to retrofit this document to cover it. Start fresh.
- Any design choice made in Wave 1–3 that would hard-block a clean Wave 4 privacy story should be flagged at the time it's made. (Example: if chat messages are stored with cross-world denormalization that couples families, that's a Wave 4 problem being created in Wave 1.)

## Implementation checklist for Wave 1

Small list now:

- [ ] `users.is_minor` + `users.guardian_user_ids` + `users.per_day_cost_cap_usd` in schema.
- [ ] Per-user daily cost cap enforced in the cost-ledger mutation (skip for users with no cap set).
- [ ] LLM system-prompt injection of the "family rating" guidance on every narrative / expansion / dialogue call.
- [ ] Image-gen prompt safety suffix on every fal.ai call.
- [ ] No PII fields added without explicit sign-off — periodic self-check during schema edits.
- [ ] No analytics / fingerprinting / ad / third-party SDK added without explicit sign-off.

That's it for Wave 1.

## Ripples to other specs

This collapse simplifies several sibling specs:

- **`00_OVERVIEW.md`** — Core principles entry is one line: "Default content rating is 'family'; per-family self-hosted deployment." No "first-class minor safety" framing needed beyond that.
- **`04_EXPANSION_LOOP.md`** — Moderation section is one line: "Safety is prompt-injected on every LLM call; there is no separate moderation pipeline in Wave 1."
- **`06_TESTING.md`** — Replay-corpus anonymization section: delete. Corpus is family-internal, tied to this one instance.
- **`08_WAVE_1_DISPATCH.md`** — **Task C6 collapses** from "Guardian dashboard + moderation primitives (2 days)" to "safety prompts + per-user cost cap wiring (~2 hours)." Likely folds into an existing task rather than standing alone.
- **`09_TECH_STACK.md`** — Schema additions reduce to three `users` fields (`is_minor`, `guardian_user_ids`, `per_day_cost_cap_usd`). No moderation tables, no moderation-event log, no anonymization queues.

Apply these on the next touch of each file; don't do them as a separate pass.
