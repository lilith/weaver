# Weaver — Tech Stack

## Versions (April 2026, locked for Wave 0)

| Category | Package | Version | Notes |
|---|---|---|---|
| Runtime | Node.js | 22.12+ | Vite 8 requirement |
| Package manager | pnpm | 9.x | Workspaces |
| Frontend framework | SvelteKit | 2.x w/ Svelte 5 runes | |
| Build tool | Vite | 8.0.x | Rolldown-based |
| UI styling | Tailwind CSS | 4.x | CSS variables for theming |
| Backend + DB | Convex | latest stable | |
| Convex client | convex-svelte | 0.0.12+ | |
| Convex + SvelteKit | convex-sveltekit | latest | Optional but recommended |
| Auth | Better Auth | latest | via `@convex-dev/better-auth` |
| Auth UI | @mmailaender/convex-better-auth-svelte | latest | |
| Magic links | Resend | latest SDK | |
| Validation | Zod | 3.x | Throughout |
| Hashing (content-addressed blobs) | @noble/hashes | latest | BLAKE3 for blob hashes; see `12_BLOB_STORAGE.md` |
| LLM SDK | @anthropic-ai/sdk | latest | |
| Image gen | @fal-ai/client | latest | FLUX.2 [pro] |
| Browser voice | @xenova/transformers | latest | Whisper WebGPU; see `15_VOICE_INPUT.md` |
| Rich text | CodeMirror 6 | latest | For module source editor (desktop advanced mode) |
| Code editor | Monaco (lazy) | latest | Desktop module designer only |
| Animation | Motion | latest | Framer Motion's Svelte-friendly successor |
| PWA | vite-plugin-pwa | latest | |
| Testing | Vitest | latest | Unit + property |
| Testing | fast-check | latest | Property-based |
| Testing | Playwright | latest | VLM screenshot eval |
| Deployment | Cloudflare Pages | — | |
| Storage | Cloudflare R2 | — | S3-compatible |

## Initial install commands

Run from repo root.

```bash
# Repo bootstrap
mkdir weaver && cd weaver
git init
pnpm init

# Workspaces
cat > pnpm-workspace.yaml <<EOF
packages:
  - 'apps/*'
  - 'packages/*'
EOF

# Main app
mkdir -p apps/play
cd apps/play
pnpm dlx sv create . --template minimal --types typescript
pnpm add convex convex-svelte convex-sveltekit
pnpm add tailwindcss@4 @tailwindcss/vite
pnpm add @xenova/transformers @fal-ai/client @anthropic-ai/sdk zod @noble/hashes
pnpm add vite-plugin-pwa
pnpm add motion
pnpm add -D @playwright/test vitest fast-check

cd ../..

# Engine package
mkdir -p packages/engine/src
cd packages/engine
pnpm init
# ... set up tsconfig, barrel exports ...
cd ../..

# Test package
mkdir -p packages/test/src
# ... similar bootstrap ...

# Convex dev
cd apps/play
pnpm dlx convex dev
# Follow prompts: log in, create project, get deployment URLs
```

## `.env.example`

```sh
# Anthropic (primary LLM)
ANTHROPIC_API_KEY=sk-ant-api03-...

# fal.ai (FLUX.2 image generation)
FAL_KEY=fa-...

# Cloudflare R2 (generated asset storage)
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=weaver-art
R2_PUBLIC_URL=https://your-custom-domain.r2.dev

# Resend (magic-link email)
RESEND_API_KEY=re_...
RESEND_FROM_EMAIL="Weaver <noreply@yourdomain.com>"

# Convex (populated by `convex dev`)
CONVEX_DEPLOYMENT=dev:your-deployment-name
NEXT_PUBLIC_CONVEX_URL=https://your-deployment.convex.cloud
PUBLIC_CONVEX_URL=https://your-deployment.convex.cloud

# App
PUBLIC_APP_URL=https://weaver.yourdomain.com
APP_WHITELIST_EMAILS=you@example.com,gen@example.com,...

# Testing (optional)
SENTRY_DSN=
```

All secrets go into Convex dashboard env vars (`npx convex env set KEY value`). Client-side never sees secrets except `PUBLIC_*` prefixed.

## Convex schema (Wave 0 starter)

```ts
// convex/schema.ts
import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"

export default defineSchema({
  // Identity
  users: defineTable({
    email: v.string(),
    display_name: v.optional(v.string()),
    is_minor: v.boolean(),                            // set by inviter
    guardian_user_ids: v.array(v.id("users")),        // may be empty for adults
    per_day_cost_cap_usd: v.optional(v.number()),     // null = uncapped (adults); minors default ~$1
    created_at: v.number(),
  }).index("by_email", ["email"]),
  // See 16_PRIVACY_AND_MINORS.md for semantics. is_minor / guardian_user_ids
  // are metadata-only in Wave 1 (no UI surfaces around them); they exist in
  // the schema so downstream features can land without a migration.

  // Worlds + branches
  worlds: defineTable({
    name: v.string(),
    owner_user_id: v.id("users"),
    content_rating: v.union(v.literal("family"), v.literal("teen"), v.literal("adult")),
    current_branch_id: v.optional(v.id("branches")),
    active_era: v.number(),                   // default 1. Era-system authority (see 25_ERAS_AND_PROGRESSION.md).
    arc_pressure: v.optional(v.any()),        // { <pressure_name>: 0-100, ... }; authored schema in bible.
    created_at: v.number(),
  }).index("by_owner", ["owner_user_id"]),

  branches: defineTable({
    world_id: v.id("worlds"),
    name: v.string(),
    parent_branch_id: v.optional(v.id("branches")),
    fork_point_timestamp: v.optional(v.number()),     // point-in-time fork reference
    transient: v.boolean(),                           // dreams + test branches set this true
    expires_at: v.optional(v.number()),               // transient branches eligible for GC after this time
    created_at: v.number(),
    created_by: v.optional(v.id("users")),
  })
    .index("by_world", ["world_id"])
    .index("by_expires", ["transient", "expires_at"]),  // for transient_branch_gc

  characters: defineTable({
    user_id: v.id("users"),
    world_id: v.id("worlds"),
    branch_id: v.id("branches"),
    name: v.string(),
    pseudonym: v.string(),
    current_location_id: v.optional(v.id("entities")),
    state: v.any(), // inventory, hp, gold, etc.
    schema_version: v.number(),

    // Era + progression (see 25_ERAS_AND_PROGRESSION.md)
    personal_era: v.number(),                             // default 1. Highest arc-beat era this character has acknowledged.
    arc_beats_acknowledged: v.array(v.string()),          // event_ids from campaign_events
    personal_chronicle: v.optional(v.string()),           // AI-woven summary of this character's journey across eras

    // Async-sync campaign (see ASYNC_SYNC_PLAY.md)
    last_caught_up_at: v.optional(v.number()),            // real_time of last acknowledged campaign event

    // Feature preferences
    prefer_prefetch: v.optional(v.boolean()),             // text prefetch opt-in; default true for adults, false for minors
    art_mode_preferred: v.optional(v.string()),           // "ambient_palette" | "banner" | "tarot_card" | ... (see ART_CURATION.md)

    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_user_world", ["user_id", "world_id"])
    .index("by_branch", ["branch_id"])
    .index("by_world_user", ["world_id", "user_id"]),

  // Content-addressed blob store (see 12_BLOB_STORAGE.md). Global — no world_id.
  // GC is mark-sweep (periodic walk of live heads), not refcount-driven.
  blobs: defineTable({
    hash: v.string(),                       // BLAKE3 hex (32-byte truncation)
    size: v.number(),                       // bytes
    kind: v.string(),                       // "json" | "text" | "image/png" | "image/webp" | ...
    storage: v.union(v.literal("inline"), v.literal("r2")),
    inline_bytes: v.optional(v.bytes()),    // present iff storage=inline (≤4KB)
    r2_key: v.optional(v.string()),         // present iff storage=r2
    created_at: v.number(),
    last_marked_reachable_at: v.optional(v.number()),  // updated by mark phase; unset blobs past grace age are swept
  })
    .index("by_hash", ["hash"])
    .index("by_marked", ["last_marked_reachable_at"]),

  // Per-world permission; see ISOLATION_AND_SECURITY.md rule 2.
  world_memberships: defineTable({
    user_id: v.id("users"),
    world_id: v.id("worlds"),
    role: v.union(
      v.literal("owner"),
      v.literal("family_mod"),
      v.literal("player"),
      v.literal("guardian"),
    ),
    added_by: v.id("users"),
    added_at: v.number(),
    revoked_at: v.optional(v.number()),     // soft-delete for audit; never hard-delete
  })
    .index("by_user_world", ["user_id", "world_id"])
    .index("by_world_role", ["world_id", "role"]),

  // Append-only audit of auth-sensitive actions; see ISOLATION_AND_SECURITY.md rule 19.
  audit_log: defineTable({
    world_id: v.optional(v.id("worlds")),
    actor_user_id: v.id("users"),
    action: v.string(),                     // "invite" | "role_grant" | "role_revoke" | "rating_change" | "debug_session" | "data_export" | "data_delete"
    target: v.any(),
    note: v.optional(v.string()),
    created_at: v.number(),
  })
    .index("by_world_time", ["world_id", "created_at"])
    .index("by_actor_time", ["actor_user_id", "created_at"]),

  // The core entity-component-relation store
  entities: defineTable({
    type: v.string(),
    branch_id: v.id("branches"),
    world_id: v.id("worlds"),
    current_version: v.number(),            // points at the latest artifact_versions row
    schema_version: v.number(),
    author_user_id: v.optional(v.id("users")),
    author_pseudonym: v.optional(v.string()),

    // Art pipeline (see art_queue + 12_BLOB_STORAGE.md). art_blob_hash points
    // at the current scene art blob; art_status tracks the generation state.
    // Older drafts of the spec used `art_ref: v.id("entities")` — replaced by
    // content-addressed blob hash so art rollback / dedupe comes for free.
    art_blob_hash: v.optional(v.string()),
    art_status: v.optional(
      v.union(
        v.literal("queued"),
        v.literal("generating"),
        v.literal("ready"),
        v.literal("failed"),
      ),
    ),

    // Draft/canon model (see 19_JOURNEYS_AND_JOURNAL.md).
    // Drafts are author-only; canonical entities are shared per world-membership.
    draft: v.optional(v.boolean()),         // absent reads as false
    expanded_from_entity_id: v.optional(v.id("entities")),  // parent location for expansions
    visited_at: v.optional(v.number()),     // null until first visit; distinguishes prefetched-pending drafts

    // Era-aware state (see 25_ERAS_AND_PROGRESSION.md). Absent on entities that don't change across eras.
    era_version_map: v.optional(v.any()),   // { 1: version_number, 2: version_number, ... }

    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_branch_type", ["branch_id", "type"])
    .index("by_world_type", ["world_id", "type"])
    .index("by_author", ["author_user_id"])
    .index("by_expansion_parent", ["expanded_from_entity_id"])
    .index("by_draft_unvisited", ["draft", "visited_at"]),  // for prefetch-pending sweep

  components: defineTable({
    entity_id: v.id("entities"),
    component_type: v.string(),
    payload: v.optional(v.any()),           // inline only for ≤4KB payloads (hot-path reads)
    blob_hash: v.optional(v.string()),      // set iff payload lives in the blob store
    schema_version: v.number(),
  })
    .index("by_entity_type", ["entity_id", "component_type"])
    .index("by_type", ["component_type"])
    .index("by_blob", ["blob_hash"]),

  relations: defineTable({
    subject_id: v.id("entities"),
    predicate: v.string(),
    object_id: v.id("entities"),
    payload: v.optional(v.any()),
    version: v.number(),
  })
    .index("by_subject_pred", ["subject_id", "predicate"])
    .index("by_object_pred", ["object_id", "predicate"])
    .index("by_predicate", ["predicate"]),

  // Async art generation. The queue exists for bulk / retriable gens; today's
  // shipped pipeline uses ctx.scheduler.runAfter() directly from the mutation
  // that creates/expands a location and writes the result onto the entity's
  // art_blob_hash + art_status fields. Keep the queue for future scenarios
  // (batch re-gen, retry-on-failure, throttled art budgets).
  art_queue: defineTable({
    entity_id: v.id("entities"),
    world_id: v.id("worlds"),             // for isolation scoping and budget attribution
    prompt: v.string(),
    refs: v.array(v.id("entities")),
    status: v.union(
      v.literal("pending"),
      v.literal("generating"),
      v.literal("ready"),
      v.literal("failed"),
    ),
    attempts: v.number(),
    result_blob_hash: v.optional(v.string()),   // BLAKE3 hex of the resulting image blob
    error: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_status", ["status", "created_at"])
    .index("by_world_status", ["world_id", "status"])
    .index("by_entity", ["entity_id"]),

  // Durable flows — step-keyed state machines. A module is { steps: { [id]: (ctx, state) => ({ next, effects }) } };
  // runtime stores current_step_id + state; resume is a handler lookup, not generator replay.
  // See 01_ARCHITECTURE.md §"Durable runtime" and the durable-runtime rewrite in that doc.
  flows: defineTable({
    module_name: v.string(),
    schema_version: v.number(),
    world_id: v.id("worlds"),
    branch_id: v.id("branches"),
    character_id: v.id("characters"),
    current_step_id: v.string(),          // name of the step handler to resume at
    state_blob_hash: v.optional(v.string()),  // the flow's state, stored as a blob for size + dedup
    status: v.union(
      v.literal("running"),
      v.literal("waiting"),
      v.literal("completed"),
      v.literal("escaped"),
    ),
    parent_flow_id: v.optional(v.id("flows")),
    stack_depth: v.number(),
    throwaway: v.boolean(),                // dream flows
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_world_character", ["world_id", "character_id"])
    .index("by_branch", ["branch_id"])
    .index("by_status", ["status", "updated_at"]),

  // Append-only log of step transitions — for debugging, escape-handler diagnostics, and
  // optional time-travel. NOT the replay substrate (state machines don't replay — they resume).
  flow_transitions: defineTable({
    flow_id: v.id("flows"),
    step_from: v.string(),
    step_to: v.string(),
    state_blob_hash: v.optional(v.string()),
    effects: v.any(),                      // what the step produced (narration, mutations, AI calls)
    created_at: v.number(),
  }).index("by_flow_time", ["flow_id", "created_at"]),

  // Journeys — a run of draft locations between canonical stops.
  // See 19_JOURNEYS_AND_JOURNAL.md. Opens on first-draft-entered-from-canonical,
  // closes on returning to any canonical location. One open journey per
  // character at a time.
  journeys: defineTable({
    world_id: v.id("worlds"),
    branch_id: v.id("branches"),
    character_id: v.id("characters"),
    user_id: v.id("users"),
    opened_at: v.number(),
    closed_at: v.optional(v.number()),
    entity_ids: v.array(v.id("entities")),
    entity_slugs: v.array(v.string()),
    status: v.union(
      v.literal("open"),       // in-flight; character on a draft
      v.literal("closed"),     // returned to canonical; awaiting decision
      v.literal("saved"),      // user saved at least one draft from this journey
      v.literal("discarded"),  // user explicitly declined to save any
      v.literal("dismissed"),  // hidden from journal; drafts still URL-navigable
    ),
    summary: v.optional(v.string()),  // AI-generated cluster one-liner
  })
    .index("by_world_user", ["world_id", "user_id"])
    .index("by_world_character_status", ["world_id", "character_id", "status"]),

  // Chat
  chat_threads: defineTable({
    scope_entity_id: v.id("entities"),  // location, world, etc.
    world_id: v.id("worlds"),
    branch_id: v.id("branches"),
    created_at: v.number(),
  }).index("by_scope", ["scope_entity_id"]),

  chat_messages: defineTable({
    thread_id: v.id("chat_threads"),
    character_id: v.id("characters"),
    pseudonym: v.string(),
    body: v.string(),
    created_at: v.number(),
  }).index("by_thread_time", ["thread_id", "created_at"]),

  // Mentorship log (append-only) — world-scoped since one user may play in multiple worlds
  mentorship_log: defineTable({
    user_id: v.id("users"),
    world_id: v.id("worlds"),
    branch_id: v.optional(v.id("branches")),
    scope: v.string(),          // "world_bible_edit" | "location_edit" | "rejection" | ...
    context: v.any(),
    ai_suggestion: v.optional(v.any()),
    human_action: v.any(),
    before_blob_hash: v.optional(v.string()),   // snapshot of payload before edit, via blob store
    after_blob_hash: v.optional(v.string()),
    note: v.optional(v.string()),
    created_at: v.number(),
  })
    .index("by_world_user_time", ["world_id", "user_id", "created_at"])
    .index("by_world_scope_time", ["world_id", "scope", "created_at"]),

  // Cost ledger
  cost_ledger: defineTable({
    world_id: v.id("worlds"),
    branch_id: v.optional(v.id("branches")),
    user_id: v.optional(v.id("users")),
    kind: v.string(),  // "opus" | "haiku" | "sonnet" | "fal" | ...
    cost_usd: v.number(),  // 6-decimal precision stored as string-like number
    reason: v.string(),
    created_at: v.number(),
  })
    .index("by_world_day", ["world_id", "created_at"])
    .index("by_user_day", ["user_id", "created_at"]),

  // Theme
  themes: defineTable({
    world_id: v.id("worlds"),
    branch_id: v.id("branches"),
    spec: v.any(),        // ThemeSchema (see 10_THEME_GENERATION.md)
    version: v.number(),
    active: v.boolean(),
    created_at: v.number(),
  }).index("by_world_active", ["world_id", "active"]),

  // Artifact version history (for rollback; see 11_PROMPT_EDITING.md, 12_BLOB_STORAGE.md, 25_ERAS_AND_PROGRESSION.md)
  artifact_versions: defineTable({
    artifact_entity_id: v.id("entities"),
    version: v.number(),
    era: v.number(),                        // default 1. Which era this version belongs to.
    blob_hash: v.string(),                  // canonicalized payload in blob store
    author_user_id: v.id("users"),
    author_pseudonym: v.string(),
    edit_kind: v.string(),                  // "create" | "edit_prompt" | "edit_direct" | "restore" | "stage_shift"
    reason: v.optional(v.string()),
    created_at: v.number(),
  })
    .index("by_artifact_version", ["artifact_entity_id", "version"])
    .index("by_artifact_era", ["artifact_entity_id", "era"])
    .index("by_blob", ["blob_hash"]),

  // Art curation (see ART_CURATION.md). Replaces the single entities.art_blob_hash
  // pair with a multi-mode multi-variant wardrobe.
  entity_art_renderings: defineTable({
    world_id: v.id("worlds"),
    entity_id: v.id("entities"),
    mode: v.string(),                       // "ambient_palette" | "banner" | "portrait_badge" | "tarot_card" | "illumination" | ...
    variant_index: v.number(),              // 1, 2, 3 within a mode; incremented per regen
    era: v.optional(v.number()),            // era-specific rendering (see 25_ERAS_AND_PROGRESSION.md); absent = era-agnostic
    blob_hash: v.optional(v.string()),      // set when ready; absent while queued/generating
    status: v.union(
      v.literal("queued"),
      v.literal("generating"),
      v.literal("ready"),
      v.literal("failed"),
      v.literal("hidden"),                  // soft-deleted
    ),
    prompt_used: v.string(),                // for regen / debug / feedback context
    requested_by_user_id: v.id("users"),
    requested_by_character_id: v.optional(v.id("characters")),
    upvote_count: v.number(),               // denormalized from art_feedback; updated on vote
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_entity_mode", ["entity_id", "mode", "upvote_count"])
    .index("by_entity_mode_era", ["entity_id", "mode", "era"])
    .index("by_world", ["world_id"])
    .index("by_status", ["status", "created_at"]),

  art_feedback: defineTable({
    world_id: v.id("worlds"),
    rendering_id: v.id("entity_art_renderings"),
    user_id: v.id("users"),
    action: v.union(
      v.literal("upvote"),
      v.literal("downvote"),
      v.literal("delete"),
      v.literal("undelete"),
      v.literal("regen_requested"),
      v.literal("reference_board_add"),
      v.literal("feedback_comment"),
    ),
    comment: v.optional(v.string()),        // for feedback_comment action
    created_at: v.number(),
  })
    .index("by_rendering", ["rendering_id"])
    .index("by_world_user", ["world_id", "user_id"]),

  art_reference_board: defineTable({
    world_id: v.id("worlds"),
    rendering_id: v.id("entity_art_renderings"),
    kind: v.string(),                       // "style" | "character:<slug>" | "biome:<slug>" | "location:<slug>" | "mode:<mode-name>"
    added_by_user_id: v.id("users"),
    caption: v.optional(v.string()),
    order: v.number(),
    created_at: v.number(),
  })
    .index("by_world_kind", ["world_id", "kind", "order"]),

  // Async-sync campaign (see ASYNC_SYNC_PLAY.md). Append-only log of campaign-level events.
  campaign_events: defineTable({
    world_id: v.id("worlds"),
    branch_id: v.id("branches"),
    character_id: v.id("characters"),       // who acted
    event_type: v.string(),                 // "entered_biome" | "combat_start" | "dialogue" | "arc_beat" | ...
    summary: v.string(),                    // 1-sentence AI-or-authored summary
    world_time_iso: v.optional(v.string()), // when, in world-time (if clock enabled)
    real_time: v.number(),                  // when, in wall-time (for sorting)
    location_entity_id: v.optional(v.id("entities")),
    biome: v.optional(v.string()),
    era: v.number(),                        // which era this event happened in
    gating: v.optional(v.boolean()),        // arc-beat events that block personal-era advance until acknowledged
    payload: v.optional(v.any()),           // event-specific extras
  })
    .index("by_world_real_time", ["world_id", "real_time"])
    .index("by_world_character", ["world_id", "character_id"])
    .index("by_gating", ["world_id", "gating"]),

  // Chronicles — authored/AI-woven era-transition narratives (see 25_ERAS_AND_PROGRESSION.md).
  // Read-only history; visible in the journal under a World Chronicle section.
  chronicles: defineTable({
    world_id: v.id("worlds"),
    branch_id: v.id("branches"),
    era_from: v.number(),
    era_to: v.number(),
    summary_blob_hash: v.string(),              // AI-generated era-transition narrative
    stage_shift_manifest_blob_hash: v.string(), // what entities changed + how (audit trail)
    authored_at: v.number(),
    authored_by_user_id: v.id("users"),         // who triggered the advance
  })
    .index("by_world_era", ["world_id", "era_to"]),

  // NPC memory (see 24_NPC_AND_NARRATIVE_PROMPTS.md). Per-subject event log filtered into dialogue prompts.
  npc_memory: defineTable({
    world_id: v.id("worlds"),
    branch_id: v.id("branches"),
    subject_entity_id: v.id("entities"),        // whose memory this is — NPC or character
    event_type: v.string(),                     // "the_player_visited" | "dialogue_turn" | ...
    summary: v.string(),                        // one-line what-happened
    salience: v.union(
      v.literal("low"), v.literal("medium"), v.literal("high"),
    ),
    turn: v.number(),                           // world turn counter at write-time
    era: v.optional(v.number()),                // era in which this memory was formed
    involved_entity_ids: v.array(v.id("entities")),  // who else was in it
    payload: v.optional(v.any()),               // optional structured detail
    created_at: v.number(),
  })
    .index("by_subject_turn", ["subject_entity_id", "turn"])
    .index("by_world_subject", ["world_id", "subject_entity_id"]),

  // Feature flags (see FEATURE_REGISTRY.md). Runtime gating for pullable features.
  // Scope resolution precedence: character → user → world → global. Default is registry-driven.
  feature_flags: defineTable({
    flag_key: v.string(),                       // "flag.art_curation" | "flag.eras" | ...
    scope_kind: v.union(
      v.literal("global"),
      v.literal("world"),
      v.literal("user"),
      v.literal("character"),
    ),
    scope_id: v.optional(v.string()),           // null for global; world_id / user_id / character_id otherwise
    enabled: v.boolean(),
    set_by_user_id: v.optional(v.id("users")),
    set_at: v.number(),
    notes: v.optional(v.string()),
  })
    .index("by_key_scope", ["flag_key", "scope_kind", "scope_id"]),
})
```

## Repo layout

```
weaver/
├── apps/
│   └── play/                   # SvelteKit app
│       ├── src/
│       │   ├── routes/         # pages
│       │   ├── lib/            # UI components, client utilities
│       │   └── convex/         # client-imported API bindings (generated)
│       ├── static/             # PWA manifest, icons, biome fallbacks
│       └── ...
├── convex/                     # Convex backend (schema, queries, mutations, actions)
│   ├── schema.ts
│   ├── migrations/
│   ├── intent/                 # classifier + atom handlers
│   ├── art/                    # art queue worker
│   ├── worldBible/
│   ├── combat/                 # Wave 1 hardcoded
│   ├── chat/
│   ├── themes/
│   ├── editing/                # prompt-based editing
│   ├── auth/
│   └── _generated/
├── packages/
│   ├── engine/                 # shared types, schemas, effect atoms, template, runtime
│   │   ├── schemas/
│   │   ├── effects/
│   │   ├── template/
│   │   ├── runtime/            # flow runner, replay
│   │   ├── ai/                 # LLM + image-gen chokepoint
│   │   └── index.ts
│   └── test/                   # trinity + corpus
│       ├── crawler/
│       ├── vlm/
│       ├── replay/
│       ├── seeds/
│       └── corpus/
├── .github/workflows/
│   └── trinity.yml
├── scripts/                    # seed, migration, etc.
├── .env.example
├── package.json
├── pnpm-workspace.yaml
└── README.md
```

## Useful commands

```bash
# Dev
pnpm dev                # Starts SvelteKit + Convex in parallel
pnpm build              # Production build
pnpm preview            # Preview production build

# Testing
pnpm test               # Unit + property
pnpm test:crawler       # State-space crawl
pnpm test:vlm           # Screenshot eval
pnpm test:replay        # Replay corpus
pnpm test:all           # Everything

# Convex
pnpm convex dev         # Dev deployment, live watch
pnpm convex deploy      # Production deploy
pnpm convex env set K V # Set secret

# Cloudflare Pages
# Configured via git push; no local command needed.

# Linting / formatting
pnpm lint
pnpm format
pnpm typecheck
```

## AI chokepoint

All LLM and image-gen calls route through `packages/engine/ai/`:

```
packages/engine/ai/
├── anthropic.ts       # Opus, Sonnet, Haiku wrappers
├── fal.ts             # FLUX.2, FLUX Kontext, Nano Banana wrappers
├── cache.ts           # (prompt, seed, model) → response cache
├── costLedger.ts      # per-call cost accounting
├── prompts/           # reusable prompt templates
└── index.ts
```

Every call returns both the result and the cost. Cost is written to `cost_ledger`. Cache is consulted before any live call. This gives:
- Unified retry/backoff.
- Single place to swap models.
- Test-mode cache replay.
- Budget enforcement (reject before exceeding per-world daily cap).

### Cost-ledger daily-cap enforcement pattern

Every AI call (LLM or image gen) passes through a check before dispatch:

```ts
// packages/engine/ai/costLedger.ts
export async function checkBudgetOrThrow(ctx, { world_id, user_id, estimated_cost_usd }) {
  const today_start = startOfUtcDay(Date.now())
  // Per-user daily cap (minors, tunable adults)
  if (user_id) {
    const user = await ctx.db.get(user_id)
    if (user.per_day_cost_cap_usd != null) {
      const spent = await sumCostLedger(ctx, { user_id, since: today_start })
      if (spent + estimated_cost_usd > user.per_day_cost_cap_usd) {
        throw new BudgetExceeded("user_daily_cap", { spent, cap: user.per_day_cost_cap_usd })
      }
    }
  }
  // Per-world daily cap
  const world = await ctx.db.get(world_id)
  const world_spent = await sumCostLedger(ctx, { world_id, since: today_start })
  if (world_spent + estimated_cost_usd > (world.per_day_cost_cap_usd ?? DEFAULT_WORLD_CAP)) {
    throw new BudgetExceeded("world_daily_cap", { spent: world_spent, cap: world.per_day_cost_cap_usd })
  }
}
```

`BudgetExceeded` is caught at the handler boundary and routed to a graceful fallback: stub location, biome-fallback image, in-character "the world is resting" response. Caller is never blocked by an exception surface.

### Scheduled actions (Convex cron)

```
convex/scheduled/
├── transient_branch_gc.ts   # hourly — deletes branches where transient=true AND expires_at<now
├── nightlyBackup.ts         # daily — exports each world to WEAVER_BACKUP_DIR (see AUTHORING_AND_SYNC.md)
└── artWorker.ts             # every 10s — drains art_queue (see 04_EXPANSION_LOOP.md)
```

`transient_branch_gc` is the cleanup path for dreams + test branches. Transient branches set `expires_at` at creation (default 30 minutes for dream, 24 hours for test fork). The GC job:

1. Scans `branches` by the `by_expires` index for `transient=true AND expires_at<now`.
2. For each, deletes entity rows, component rows, relation rows, chat threads, flows, and flow_transitions with matching `branch_id`. Payload blobs are left in place — they may be referenced elsewhere, and the mark-sweep blob GC handles them on its own cadence.
3. A separate blob mark-sweep GC (daily mark, weekly sweep with 7-day grace) removes blobs that weren't marked reachable in the most recent pass. See `12_BLOB_STORAGE.md` §"Garbage collection."
4. Deletes the branch row last.

This is why blob + branch architecture matters: the branch GC is trivial — delete heads rows, and the next mark-sweep pass naturally drops any blobs that are no longer reachable from any branch's heads.

## Model routing (Wave 1)

| Task | Model | Why |
|---|---|---|
| Intent classification | Haiku 4.5 | Cheap, fast, deterministic |
| Location generation | Opus 4.7 (temp 1.0) | High creativity + 1M context for world bible |
| Examine/narrate/chat NPCs | Sonnet 4.6 | Good prose, cheaper |
| Consistency check | Haiku 4.5 | Pattern matching, cheap |
| Theme generation | Opus 4.7 | Structured JSON output, needs bible context |
| Inline script generation | Opus 4.7 | Code-quality, rare |
| Edit-by-prompt (text) | Opus 4.7 | Rewrite with context, rare |
| Edit-by-prompt (image) | FLUX Kontext via fal.ai | Reference-preserving edit |
| New art | FLUX.2 [pro] via fal.ai | Quality + reference support |
| VLM screenshot eval | Haiku 4.5 | Cheap vision |
| Voice-to-text (in game) | Whisper WebGPU (browser) | Free, private, on-device |
