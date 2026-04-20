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
| LLM SDK | @anthropic-ai/sdk | latest | |
| Image gen | @fal-ai/client | latest | FLUX.2 [pro] |
| Browser voice | @xenova/transformers | latest | Whisper WebGPU |
| Rich text | CodeMirror 6 | latest | For inline script editor |
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
pnpm add @xenova/transformers @fal-ai/client @anthropic-ai/sdk zod
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
    created_at: v.number(),
  }).index("by_email", ["email"]),

  // Worlds + branches
  worlds: defineTable({
    name: v.string(),
    owner_user_id: v.id("users"),
    content_rating: v.union(v.literal("family"), v.literal("teen"), v.literal("adult")),
    current_branch_id: v.optional(v.id("branches")),
    created_at: v.number(),
  }).index("by_owner", ["owner_user_id"]),

  branches: defineTable({
    world_id: v.id("worlds"),
    name: v.string(),
    parent_branch_id: v.optional(v.id("branches")),
    created_at: v.number(),
  }).index("by_world", ["world_id"]),

  characters: defineTable({
    user_id: v.id("users"),
    world_id: v.id("worlds"),
    branch_id: v.id("branches"),
    name: v.string(),
    pseudonym: v.string(),
    current_location_id: v.optional(v.id("entities")),
    state: v.any(), // inventory, hp, gold, etc.
    schema_version: v.number(),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_user_world", ["user_id", "world_id"])
    .index("by_branch", ["branch_id"]),

  // The core entity-component-relation store
  entities: defineTable({
    type: v.string(),
    branch_id: v.id("branches"),
    world_id: v.id("worlds"),
    version: v.number(),
    schema_version: v.number(),
    author_user_id: v.optional(v.id("users")),
    author_pseudonym: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_branch_type", ["branch_id", "type"])
    .index("by_world_type", ["world_id", "type"])
    .index("by_author", ["author_user_id"]),

  components: defineTable({
    entity_id: v.id("entities"),
    component_type: v.string(),
    payload: v.any(),
    schema_version: v.number(),
  })
    .index("by_entity_type", ["entity_id", "component_type"])
    .index("by_type", ["component_type"]),

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

  // Async art generation
  art_queue: defineTable({
    entity_id: v.id("entities"),
    prompt: v.string(),
    refs: v.array(v.id("entities")),
    status: v.union(
      v.literal("pending"),
      v.literal("generating"),
      v.literal("ready"),
      v.literal("failed"),
    ),
    attempts: v.number(),
    result_url: v.optional(v.string()),
    error: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_status", ["status", "created_at"])
    .index("by_entity", ["entity_id"]),

  // Durable flow runtime
  flows: defineTable({
    module_name: v.string(),
    schema_version: v.number(),
    character_id: v.id("characters"),
    state: v.union(v.literal("running"), v.literal("waiting"), v.literal("completed"), v.literal("escaped")),
    stack_depth: v.number(),
    parent_flow_id: v.optional(v.id("flows")),
    throwaway: v.boolean(),  // dream flows
    created_at: v.number(),
    updated_at: v.number(),
  }).index("by_character", ["character_id"]),

  events: defineTable({
    flow_id: v.id("flows"),
    op_index: v.number(),
    op: v.any(),      // { kind, args }
    result: v.optional(v.any()),
    seed: v.string(),
    created_at: v.number(),
  }).index("by_flow_index", ["flow_id", "op_index"]),

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

  // Mentorship log (append-only)
  mentorship_log: defineTable({
    user_id: v.id("users"),
    scope: v.string(),          // "world_bible_edit" | "location_edit" | "rejection" | ...
    context: v.any(),
    ai_suggestion: v.optional(v.any()),
    human_action: v.any(),
    before: v.optional(v.any()),
    after: v.optional(v.any()),
    note: v.optional(v.string()),
    created_at: v.number(),
  })
    .index("by_user_time", ["user_id", "created_at"])
    .index("by_scope_time", ["scope", "created_at"]),

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

  // Artifact version history (for rollback)
  artifact_versions: defineTable({
    artifact_entity_id: v.id("entities"),
    version: v.number(),
    payload: v.any(),
    author_user_id: v.id("users"),
    author_pseudonym: v.string(),
    edit_kind: v.string(),   // "create" | "edit_prompt" | "edit_direct" | "restore"
    reason: v.optional(v.string()),
    created_at: v.number(),
  }).index("by_artifact_version", ["artifact_entity_id", "version"]),
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
