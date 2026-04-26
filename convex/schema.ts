// Weaver schema — entity/component/relation store, content-addressed payloads
// via blob hashes, isolation-first indexing.
//
// Rule 1 (spec: CLAUDE.md §URGENT): every per-world index begins with
// world_id (or branch_id when rows are branch-scoped). Cross-world reads
// don't exist by design. Tables holding pre-world state (users,
// auth_tokens, sessions, blobs) are exempt — blobs are content-addressed
// + mark-swept; the others are identity-layer.
//
// Rule 6: blobs have no ref_count. Reachability via mark-sweep.

import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // ---------------------------------------------------------------
  // Identity (world-agnostic)
  users: defineTable({
    email: v.string(),
    display_name: v.optional(v.string()),
    is_minor: v.boolean(),
    guardian_user_ids: v.array(v.id("users")),
    per_day_cost_cap_usd: v.optional(v.number()),
    created_at: v.number(),
  }).index("by_email", ["email"]),

  // ---------------------------------------------------------------
  // Worlds + branches
  worlds: defineTable({
    name: v.string(),
    slug: v.string(), // globally unique
    owner_user_id: v.id("users"),
    content_rating: v.union(
      v.literal("family"),
      v.literal("teen"),
      v.literal("adult"),
    ),
    current_branch_id: v.optional(v.id("branches")),
    // Eras v1 — optional, defaults to 1 when absent. Incremented by
    // advanceEra; entity visibility gating is deferred to v2.
    active_era: v.optional(v.number()),
    // Per-world stat schema (spec/STAT_SCHEMA.md). Pure presentation
    // overlay — never read by modules. Shape matches StatSchema in
    // packages/engine/src/stats. Absent ⇒ engine defaults apply.
    stat_schema: v.optional(v.any()),
    // AI quality preset (spec/CONTEXT_AND_RECALL.md). Swaps Haiku /
    // Sonnet / Opus across narrative call sites. Cheap end-of-flag
    // setting — every call site's assembler preset reads this.
    //   "fast"     — Haiku for everything light; Sonnet for narrate
    //   "standard" — engine defaults (current behavior)
    //   "best"     — Opus for everything narrative; Haiku/Sonnet for
    //                trivial classification only
    ai_quality: v.optional(
      v.union(v.literal("fast"), v.literal("standard"), v.literal("best")),
    ),
    created_at: v.number(),
  })
    .index("by_owner", ["owner_user_id"])
    .index("by_slug", ["slug"]),

  // Membership is the only permission surface. Owner gets a row too.
  world_memberships: defineTable({
    world_id: v.id("worlds"),
    user_id: v.id("users"),
    role: v.union(
      v.literal("owner"),
      v.literal("family_mod"),
      v.literal("player"),
    ),
    created_at: v.number(),
  })
    .index("by_world_user", ["world_id", "user_id"])
    .index("by_user", ["user_id"]),

  branches: defineTable({
    world_id: v.id("worlds"),
    name: v.string(),
    slug: v.string(),
    parent_branch_id: v.optional(v.id("branches")),
    transient: v.boolean(),
    expires_at: v.optional(v.number()),
    // Branch-scoped mutable state: { time: { iso, hhmm, day_of_week,
    // day_counter, week_counter }, turn, weather?, flags? }. Seed on
    // world creation from bible.world_time; tick advanced on every
    // applyOption.
    state: v.optional(v.any()),
    created_at: v.number(),
  })
    .index("by_world", ["world_id"])
    .index("by_world_slug", ["world_id", "slug"]),

  characters: defineTable({
    world_id: v.id("worlds"),
    branch_id: v.id("branches"),
    user_id: v.id("users"),
    name: v.string(),
    pseudonym: v.string(),
    current_location_id: v.optional(v.id("entities")),
    state: v.any(),
    schema_version: v.number(),
    // Preferred art mode when this character views a location.
    // Falls through to top-voted existing mode → `ambient_palette`.
    art_mode_preferred: v.optional(v.string()),
    // Per-character prefetch opt-in/out (spec 04 §Predictive text prefetch).
    // Absent or true = follow the world flag; explicit false opts this
    // character out even when flag.text_prefetch is on.
    prefer_prefetch: v.optional(v.boolean()),
    // Eras v2 — era the character has acknowledged. When worlds.
    // active_era > personal_era, the player sees a catch-up chronicle
    // panel on their next applyOption; acknowledging advances this
    // to match the world. Defaults to 1 when absent.
    personal_era: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_world_user", ["world_id", "user_id"])
    .index("by_branch_user", ["branch_id", "user_id"]),

  // ---------------------------------------------------------------
  // Entity / component / relation store. All indexed by branch_id first.
  entities: defineTable({
    world_id: v.id("worlds"),
    branch_id: v.id("branches"),
    type: v.string(),
    slug: v.string(),
    current_version: v.number(),
    schema_version: v.number(),
    author_user_id: v.optional(v.id("users")),
    author_pseudonym: v.optional(v.string()),
    // Draft = a place the player dreamed up but hasn't pinned to the
    // shared map. Visible/reachable only by the author until saveToMap
    // runs. Absent / false = canonical.
    draft: v.optional(v.boolean()),
    // For drafts: the entity they were expanded from, so saveToMap
    // knows which parent's options to extend.
    expanded_from_entity_id: v.optional(v.id("entities")),
    // First-visit timestamp. Null on prefetched drafts until a character
    // actually lands here. Mark-sweep reclaims draft + visited_at=null
    // entities older than 30 days. Canonical (non-draft) entities get
    // this set once on first author-resolve.
    visited_at: v.optional(v.number()),
    // Eras v2 (spec 25). Era number when this entity first appeared in
    // the world — stamped from worlds.active_era at creation time.
    // Absent = unconstrained (treated as era 1). Used by
    // currentEraFor() / narrative prompt filtering so Opus doesn't
    // reference entities that shouldn't exist yet in the player's
    // personal_era view.
    era_first_established: v.optional(v.number()),
    // If this entity is a prefetched draft, records the parent location
    // and the option label that triggered it — so applyOption can find
    // the pre-warmed draft instead of chaining to expansion.
    prefetched_from_entity_id: v.optional(v.id("entities")),
    prefetched_from_option_label: v.optional(v.string()),
    // Graph-map layout (spec 26). `map_shape` overrides the classifier
    // when present; `subgraph` overrides biome-based implicit clustering;
    // `map_hint` stores the AI's relative-direction suggestion at
    // expansion time so first-render layout has a hint better than
    // pure BFS jitter.
    map_shape: v.optional(
      v.union(
        v.literal("spatial"),
        v.literal("action"),
        v.literal("floating"),
      ),
    ),
    subgraph: v.optional(v.string()),
    map_hint: v.optional(v.any()),
    // Scene / portrait art for this entity — blob hash (stored in R2).
    // Regenerates on explicit user action; otherwise sticky once set.
    art_blob_hash: v.optional(v.string()),
    // Latest art-gen status so the UI can show "forming…" hints.
    art_status: v.optional(
      v.union(
        v.literal("queued"),
        v.literal("generating"),
        v.literal("ready"),
        v.literal("failed"),
      ),
    ),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_branch_type", ["branch_id", "type"])
    .index("by_branch_type_slug", ["branch_id", "type", "slug"])
    .index("by_world_author", ["world_id", "author_user_id"])
    // Prefetch lookup: find a pre-warmed draft for (parent, option label).
    .index("by_prefetch_source", [
      "branch_id",
      "prefetched_from_entity_id",
      "prefetched_from_option_label",
    ]),

  components: defineTable({
    world_id: v.id("worlds"),
    branch_id: v.id("branches"),
    entity_id: v.id("entities"),
    component_type: v.string(),
    blob_hash: v.string(),
    content_type: v.string(),
    schema_version: v.number(),
  })
    .index("by_branch_entity_type", ["branch_id", "entity_id", "component_type"])
    .index("by_branch_type", ["branch_id", "component_type"])
    .index("by_world_blob", ["world_id", "blob_hash"]),

  relations: defineTable({
    world_id: v.id("worlds"),
    branch_id: v.id("branches"),
    subject_id: v.id("entities"),
    predicate: v.string(),
    object_id: v.id("entities"),
    payload: v.optional(v.any()),
    version: v.number(),
  })
    .index("by_branch_subject_pred", ["branch_id", "subject_id", "predicate"])
    .index("by_branch_object_pred", ["branch_id", "object_id", "predicate"])
    .index("by_branch_predicate", ["branch_id", "predicate"]),

  // ---------------------------------------------------------------
  // Content-addressed blob store. Mark-sweep GC (no ref_count).
  blobs: defineTable({
    hash: v.string(),
    size: v.number(),
    content_type: v.string(),
    storage: v.union(v.literal("inline"), v.literal("r2")),
    inline_bytes: v.optional(v.bytes()),
    r2_key: v.optional(v.string()),
    created_at: v.number(),
  }).index("by_hash", ["hash"]),

  // ---------------------------------------------------------------
  // Async art generation queue
  art_queue: defineTable({
    world_id: v.id("worlds"),
    branch_id: v.id("branches"),
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
    result_blob_hash: v.optional(v.string()),
    error: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_world_status", ["world_id", "status", "created_at"])
    .index("by_branch_entity", ["branch_id", "entity_id"]),

  // ---------------------------------------------------------------
  // Durable flow runtime — step-keyed state machines (rule #3).
  flows: defineTable({
    world_id: v.id("worlds"),
    branch_id: v.id("branches"),
    character_id: v.id("characters"),
    module_name: v.string(),
    schema_version: v.number(),
    current_step_id: v.optional(v.string()),
    state_json: v.any(), // the in-flight state machine's state
    status: v.union(
      v.literal("running"),
      v.literal("waiting"),
      v.literal("completed"),
      v.literal("escaped"),
    ),
    stack_depth: v.number(),
    parent_flow_id: v.optional(v.id("flows")),
    throwaway: v.boolean(),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_branch_character", ["branch_id", "character_id"])
    .index("by_world_status", ["world_id", "status"]),

  // ---------------------------------------------------------------
  // Flow transitions — append-only diagnostic trail of every step
  // advance in every flow. When a flow misbehaves, runtime_bugs
  // catches errors but not the SHAPE of the path; this table answers
  // "which steps ran in what order with what effects" for any flow.
  // GC policy: sweep rows older than 14 days weekly.
  flow_transitions: defineTable({
    world_id: v.id("worlds"),
    branch_id: v.id("branches"),
    flow_id: v.id("flows"),
    turn: v.number(),
    from_step_id: v.union(v.string(), v.null()),
    to_step_id: v.union(v.string(), v.null()),
    status: v.union(
      v.literal("running"),
      v.literal("waiting"),
      v.literal("completed"),
      v.literal("escaped"),
    ),
    says_count: v.number(),
    effect_kinds: v.array(v.string()),
    at: v.number(),
  })
    .index("by_flow_time", ["flow_id", "at"])
    .index("by_world_time", ["world_id", "at"]),

  // ---------------------------------------------------------------
  // Chat — reactive, per-world, per-location
  chat_threads: defineTable({
    world_id: v.id("worlds"),
    branch_id: v.id("branches"),
    scope_entity_id: v.id("entities"),
    created_at: v.number(),
  }).index("by_branch_scope", ["branch_id", "scope_entity_id"]),

  chat_messages: defineTable({
    world_id: v.id("worlds"),
    branch_id: v.id("branches"),
    thread_id: v.id("chat_threads"),
    character_id: v.id("characters"),
    pseudonym: v.string(),
    body: v.string(),
    created_at: v.number(),
  }).index("by_thread_time", ["thread_id", "created_at"]),

  // ---------------------------------------------------------------
  // Mentorship log (append-only, per-world)
  mentorship_log: defineTable({
    world_id: v.id("worlds"),
    user_id: v.id("users"),
    scope: v.string(),
    context: v.any(),
    ai_suggestion: v.optional(v.any()),
    human_action: v.any(),
    before: v.optional(v.any()),
    after: v.optional(v.any()),
    note: v.optional(v.string()),
    created_at: v.number(),
  })
    .index("by_world_user_time", ["world_id", "user_id", "created_at"])
    .index("by_world_scope_time", ["world_id", "scope", "created_at"]),

  // ---------------------------------------------------------------
  // Cost ledger (per-world cap enforcement)
  cost_ledger: defineTable({
    world_id: v.id("worlds"),
    branch_id: v.optional(v.id("branches")),
    user_id: v.optional(v.id("users")),
    kind: v.string(),
    cost_usd: v.number(),
    reason: v.string(),
    created_at: v.number(),
  })
    .index("by_world_day", ["world_id", "created_at"])
    .index("by_world_user_day", ["world_id", "user_id", "created_at"]),

  // ---------------------------------------------------------------
  // Themes — per-world
  themes: defineTable({
    world_id: v.id("worlds"),
    branch_id: v.id("branches"),
    spec: v.any(),
    version: v.number(),
    active: v.boolean(),
    created_at: v.number(),
  })
    .index("by_world_active", ["world_id", "active"])
    .index("by_world_branch_active", ["world_id", "branch_id", "active"])
    .index("by_world_branch_version", ["world_id", "branch_id", "version"]),

  // ---------------------------------------------------------------
  // Artifact version history (for rollback), blob-backed
  artifact_versions: defineTable({
    world_id: v.id("worlds"),
    branch_id: v.id("branches"),
    artifact_entity_id: v.id("entities"),
    version: v.number(),
    blob_hash: v.string(),
    content_type: v.string(),
    author_user_id: v.optional(v.id("users")),
    author_pseudonym: v.optional(v.string()),
    edit_kind: v.string(),
    reason: v.optional(v.string()),
    // Eras v2 — era the world was in when this version was written.
    // Enables per-era rewrites: a location can have era-2 and era-3
    // versions and getEntityAtEra() picks the latest <= target era.
    // Absent on legacy rows → treated as era 1.
    era: v.optional(v.number()),
    created_at: v.number(),
  })
    .index("by_artifact_version", ["artifact_entity_id", "version"])
    .index("by_branch_blob", ["branch_id", "blob_hash"])
    .index("by_artifact_era", ["artifact_entity_id", "era"]),

  // ---------------------------------------------------------------
  // Journeys — a run of draft locations between two canonical stops.
  // Opens on first draft entered from canonical, closes on arrival back
  // at canonical. See spec/19_JOURNEYS_AND_JOURNAL.md.
  journeys: defineTable({
    world_id: v.id("worlds"),
    branch_id: v.id("branches"),
    character_id: v.id("characters"),
    user_id: v.id("users"),
    opened_at: v.number(),
    closed_at: v.optional(v.number()),
    // Drafts visited during the journey, in order.
    entity_ids: v.array(v.id("entities")),
    entity_slugs: v.array(v.string()),
    status: v.union(
      v.literal("open"), // in-flight; character is currently on a draft
      v.literal("closed"), // returned to canonical; awaiting user decision
      v.literal("saved"), // user saved at least one draft from this journey
      v.literal("discarded"), // user explicitly declined to save any
      v.literal("dismissed"), // hidden from journal (drafts remain navigable via URL)
    ),
    // Optional AI-generated one-liner shown in the journal + close panel.
    summary: v.optional(v.string()),
  })
    .index("by_world_user", ["world_id", "user_id"])
    .index("by_world_character_status", [
      "world_id",
      "character_id",
      "status",
    ]),

  // ---------------------------------------------------------------
  // Art curation — spec ART_CURATION.md. Multiple renderings per entity
  // per mode; accumulate variants over time via regen.
  entity_art_renderings: defineTable({
    world_id: v.id("worlds"),
    branch_id: v.id("branches"),
    entity_id: v.id("entities"),
    mode: v.string(), // banner | portrait_badge | tarot_card | illumination | ambient_palette | hero_full | ...
    variant_index: v.number(), // 1..N within (entity, mode)
    blob_hash: v.optional(v.string()), // set when ready; absent while queued/generating
    status: v.union(
      v.literal("queued"),
      v.literal("generating"),
      v.literal("ready"),
      v.literal("failed"),
      v.literal("hidden"),
    ),
    prompt_used: v.string(),
    requested_by_user_id: v.id("users"),
    upvote_count: v.number(),
    error: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_entity_mode", ["entity_id", "mode", "upvote_count"])
    .index("by_entity_mode_variant", ["entity_id", "mode", "variant_index"])
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
    comment: v.optional(v.string()),
    created_at: v.number(),
  })
    .index("by_rendering", ["rendering_id"])
    .index("by_world_user", ["world_id", "user_id"]),

  art_reference_board: defineTable({
    world_id: v.id("worlds"),
    rendering_id: v.id("entity_art_renderings"),
    kind: v.string(), // "style" | "character:<slug>" | "biome:<slug>" | "mode:<mode>"
    added_by_user_id: v.id("users"),
    caption: v.optional(v.string()),
    order: v.number(),
    created_at: v.number(),
  }).index("by_world_kind", ["world_id", "kind", "order"]),

  // ---------------------------------------------------------------
  // Expansion streams — progressive text from Opus as it arrives.
  // Client subscribes via convex-svelte useQuery; the action updates
  // `text` in-place every ~200ms. Once `status="done"` the entity is
  // persisted and this row can be discarded. Flag: expansion_streaming.
  expansion_streams: defineTable({
    world_id: v.id("worlds"),
    branch_id: v.id("branches"),
    character_id: v.id("characters"),
    parent_location_slug: v.string(),
    input: v.string(),
    status: v.union(
      v.literal("streaming"),
      v.literal("done"),
      v.literal("failed"),
    ),
    text: v.string(), // accumulating chunks
    // Set when done: the slug that was produced (for navigation), or
    // the narrate text if Opus chose narrate.
    result_kind: v.optional(v.union(v.literal("location"), v.literal("narrate"))),
    result_slug: v.optional(v.string()),
    result_narrate_text: v.optional(v.string()),
    error: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_character_status", ["character_id", "status"])
    .index("by_world_status_time", ["world_id", "status", "created_at"]),

  // ---------------------------------------------------------------
  // Chronicles — era-transition narratives written by Opus. One row
  // per (world, from_era → to_era) event. Rendered in the bible admin
  // + shown in-game when a player crosses the era boundary.
  chronicles: defineTable({
    world_id: v.id("worlds"),
    from_era: v.number(),
    to_era: v.number(),
    title: v.string(),
    body: v.string(),
    written_by_user_id: v.optional(v.id("users")),
    created_at: v.number(),
  }).index("by_world_era", ["world_id", "to_era"]),

  // ---------------------------------------------------------------
  // Tile library — cross-world catalogue of pixellab-generated
  // assets. Each row is one usable asset (a single tile, a building,
  // a portrait, a bridge) at a specific style. Worlds opt into a
  // style_tag and the map/play surfaces pick matching library
  // assets for their biomes/entities. Regeneration bumps version;
  // inactive rows stay discoverable for rollback but aren't
  // auto-picked.
  tile_library: defineTable({
    kind: v.union(
      v.literal("biome_tile"),
      v.literal("building"),
      v.literal("path"),
      v.literal("bridge"),
      v.literal("portrait"),
      v.literal("map_object"),
      v.literal("character_walk"),
      v.literal("misc"),
    ),
    style_tag: v.string(),
    subject_tags: v.array(v.string()),
    name: v.string(),
    blob_hash: v.string(),
    width: v.number(),
    height: v.number(),
    view: v.optional(v.string()),
    pixellab_asset_id: v.optional(v.string()),
    pixellab_parent_id: v.optional(v.string()),
    generation: v.optional(v.any()),
    version: v.number(),
    active: v.boolean(),
    created_by_user_id: v.optional(v.id("users")),
    created_at: v.number(),
  })
    .index("by_kind_style", ["kind", "style_tag"])
    .index("by_style_active", ["style_tag", "active"])
    .index("by_pixellab_asset", ["pixellab_asset_id"])
    .index("by_blob_hash", ["blob_hash"]),

  // Graph-map pins — per-(world, branch, slug). Any family member may
  // drag; the latest drag wins. Absence = force-solved position.
  map_pins: defineTable({
    world_id: v.id("worlds"),
    branch_id: v.id("branches"),
    slug: v.string(),
    x: v.number(),
    y: v.number(),
    pinned_by_user_id: v.id("users"),
    pinned_at: v.number(),
  })
    .index("by_world_branch", ["world_id", "branch_id"])
    .index("by_world_slug", ["world_id", "slug"]),

  // Graph-map edge traffic — how often players cross a given edge. Used
  // to render busier paths with higher stroke opacity. Cheap counter;
  // weekly GC sweeps rows with crossings=0 older than 60 days.
  edge_traffic: defineTable({
    world_id: v.id("worlds"),
    branch_id: v.id("branches"),
    from_slug: v.string(),
    to_slug: v.string(),
    crossings: v.number(),
    last_crossed_at: v.number(),
  })
    .index("by_branch_edge", ["branch_id", "from_slug", "to_slug"])
    .index("by_branch_time", ["branch_id", "last_crossed_at"]),

  // Per-world style binding + pinned overrides. One row per world;
  // absence = use the static palette swatches (pre-library fallback).
  world_style_bindings: defineTable({
    world_id: v.id("worlds"),
    style_tag: v.string(),
    // biome_slug → tile_library id; overrides the deterministic pick
    // for every location in that biome.
    biome_overrides: v.any(), // Record<string, Id<"tile_library">>
    // entity_slug → tile_library id; pin a specific place or
    // character to a specific asset.
    entity_overrides: v.any(), // Record<string, Id<"tile_library">>
    updated_at: v.number(),
  }).index("by_world", ["world_id"]),

  // ---------------------------------------------------------------
  // Runtime bugs — invariant violations caught by sanitizers on the
  // hot path. Rate-limited per (code, world): the same code for the
  // same world increments seen_count rather than inserting a new row.
  runtime_bugs: defineTable({
    world_id: v.optional(v.id("worlds")),
    branch_id: v.optional(v.id("branches")),
    character_id: v.optional(v.id("characters")),
    severity: v.union(v.literal("info"), v.literal("warn"), v.literal("error")),
    code: v.string(),
    message: v.string(),
    context: v.optional(v.any()),
    seen_count: v.number(),
    first_seen_at: v.number(),
    last_seen_at: v.number(),
  })
    .index("by_world_severity_time", ["world_id", "severity", "last_seen_at"])
    .index("by_world_code", ["world_id", "code"])
    .index("by_severity_time", ["severity", "last_seen_at"]),

  // ---------------------------------------------------------------
  // Feature flags — one row per (key, scope). Resolution char→user→world→global.
  // See packages/engine/src/flags/index.ts for the resolver.
  feature_flags: defineTable({
    flag_key: v.string(), // e.g. "flag.biome_rules"
    scope_kind: v.union(
      v.literal("character"),
      v.literal("user"),
      v.literal("world"),
      v.literal("global"),
    ),
    // Absent for global. When scope_kind != "global" we always write a real id.
    scope_id: v.optional(v.string()),
    enabled: v.boolean(),
    set_by_user_id: v.optional(v.id("users")),
    set_at: v.number(),
    notes: v.optional(v.string()),
  })
    .index("by_key_scope", ["flag_key", "scope_kind", "scope_id"])
    .index("by_key", ["flag_key"]),

  // ---------------------------------------------------------------
  // Atlases — spec/ATLASES_AND_MAPS.md. Per-world creative-layer maps.
  // Coexist with the auto-graph; never replace it. Each atlas is one
  // artist's canvas; multiple atlases per world is normal. Owner of
  // the world gates create+delete; atlas owner gates style + writes.
  atlases: defineTable({
    world_id: v.id("worlds"),
    slug: v.string(), // unique within world
    name: v.string(),
    description: v.optional(v.string()),
    layer_mode: v.union(
      v.literal("stack"), // smooth vertical scroll between layers
      v.literal("toggle"), // composable semantic overlays
      v.literal("solo"), // one layer only; hand-drawn single-image
    ),
    style_anchor: v.optional(v.string()),
    placement_mode: v.union(v.literal("freeform"), v.literal("grid")),
    grid_cols: v.optional(v.number()),
    grid_rows: v.optional(v.number()),
    owner_user_id: v.id("users"),
    published: v.boolean(),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_world", ["world_id", "created_at"])
    .index("by_world_slug", ["world_id", "slug"])
    .index("by_world_owner", ["world_id", "owner_user_id"]),

  // Layers within an atlas. order_index is significant only for
  // layer_mode = "stack". Kind is a hint for the viewer (what icons +
  // basemap defaults are appropriate); free-form "other" is fine.
  map_layers: defineTable({
    world_id: v.id("worlds"),
    atlas_id: v.id("atlases"),
    slug: v.string(), // unique within atlas
    name: v.string(),
    kind: v.string(), // physical | spiritual | political | seasonal | dream | caves | peaks | coast | other
    order_index: v.number(),
    basemap_blob_hash: v.optional(v.string()),
    basemap_prompt: v.optional(v.string()),
    notes: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_atlas_order", ["atlas_id", "order_index"])
    .index("by_atlas_slug", ["atlas_id", "slug"])
    .index("by_world", ["world_id"]),

  // Placements — landmarks anchored on a layer. entity_id is optional
  // (decorative landmarks like "Here be dragons" have only
  // custom_label). visibility decides what the viewer renders:
  //   icon  — full landmark with art
  //   line  — unmarked curve linking to connection_to (a fork, no node)
  //   hidden — omitted from view; kept in author tooling
  map_placements: defineTable({
    world_id: v.id("worlds"),
    atlas_id: v.id("atlases"),
    layer_id: v.id("map_layers"),
    entity_id: v.optional(v.id("entities")),
    custom_label: v.optional(v.string()),
    // Freeform coords in [0..1] so basemap resizes don't move pins.
    x: v.optional(v.number()),
    y: v.optional(v.number()),
    // Grid-mode coords; only meaningful when atlas.placement_mode = grid.
    grid_col: v.optional(v.number()),
    grid_row: v.optional(v.number()),
    visibility: v.union(
      v.literal("icon"),
      v.literal("line"),
      v.literal("hidden"),
    ),
    icon_blob_hash: v.optional(v.string()),
    icon_prompt: v.optional(v.string()),
    icon_style: v.optional(v.string()), // sticker | emblem | inkwash | photoreal | flat
    // For visibility="line": where the curve goes.
    connection_to_entity_slug: v.optional(v.string()),
    // For vertical links: clicking jumps to another layer in the atlas.
    connection_to_layer_slug: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_layer", ["layer_id"])
    .index("by_atlas_entity", ["atlas_id", "entity_id"])
    .index("by_world", ["world_id"]),

  // ---------------------------------------------------------------
  // Module overrides — spec/MODULE_AND_CODE_PROPOSALS.md. Per-world
  // tuning of declared slots on a flow module (combat, dialogue, …).
  // One row per (world_id, module_name). Monotonic `version` is used
  // by applyModuleEdit for optimistic concurrency. Flow runtime looks
  // up this row once per step dispatch and passes `overrides_json`
  // into ModuleCtx.tune / ModuleCtx.template.
  module_overrides: defineTable({
    world_id: v.id("worlds"),
    module_name: v.string(),
    overrides_json: v.any(),
    version: v.number(),
    updated_by_user_id: v.id("users"),
    updated_at: v.number(),
  }).index("by_world_module", ["world_id", "module_name"]),

  // Module proposals — the workflow rows driving the admin UI.
  // Every suggest writes one row; apply patches status + applied_*.
  // Never deleted (dismiss moves status to "dismissed" instead) so the
  // mentorship trail stays intact.
  module_proposals: defineTable({
    world_id: v.id("worlds"),
    module_name: v.string(),
    feedback_text: v.string(),
    // JSON snapshot of the overrides_json at suggest time — the UI
    // diffs against this, and audit readers don't have to reconstruct
    // history from module_overrides' mutating row.
    current_overrides_snapshot: v.any(),
    // Opus's proposed overrides — may be a subset of declared slots.
    suggested_overrides: v.any(),
    rationale: v.string(),
    // module_overrides.version at suggest time.
    expected_version: v.number(),
    status: v.union(
      v.literal("draft"),
      v.literal("applied"),
      v.literal("dismissed"),
    ),
    // Populated only when status = "applied".
    applied_at: v.optional(v.number()),
    applied_version: v.optional(v.number()),
    applied_by_user_id: v.optional(v.id("users")),
    author_user_id: v.id("users"),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_world_module_time", ["world_id", "module_name", "created_at"])
    .index("by_world_status", ["world_id", "status"]),

  // ---------------------------------------------------------------
  // Code-change proposals — spec/MODULE_AND_CODE_PROPOSALS.md. Owner
  // types feedback → Opus drafts a plan (no code) → owner opens a
  // GitHub issue assigned to lilith. Keeps "trusted TS only" posture
  // intact: no runtime code execution, every code change lands via the
  // normal PR → CI → merge → Pages-deploy path.
  code_proposals: defineTable({
    world_id: v.id("worlds"),
    feedback_text: v.string(),
    // The Opus-drafted plan: { title, summary, rationale,
    // suggested_changes: [{file, what}], new_tests: [], open_questions:
    // [], estimated_size }. Validated at suggest time.
    plan_json: v.any(),
    status: v.union(
      v.literal("draft"),
      v.literal("opened"),
      v.literal("closed"),
      v.literal("dismissed"),
    ),
    // Populated when the GitHub issue is created.
    github_issue_number: v.optional(v.number()),
    github_issue_url: v.optional(v.string()),
    github_issue_created_at: v.optional(v.number()),
    // Populated on dismiss.
    dismissed_at: v.optional(v.number()),
    author_user_id: v.id("users"),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_world_status_time", ["world_id", "status", "created_at"])
    .index("by_world_time", ["world_id", "created_at"]),

  // ---------------------------------------------------------------
  // Events — append-only log of everything narrative-significant.
  // Spec: spec/CONTEXT_AND_RECALL.md.
  //
  // Two truths kept separate: this table is "what happened" (world
  // truth) AND "what each character witnessed" — for single-player
  // characters they're the same row; for async-sync (future) we'll
  // split witnesses[] off. The tiered context assembler reads slabs
  // from here for every Opus/Sonnet call.
  //
  // Each row is sparse: most events touch only 2-3 of the optional
  // foreign-key columns. The compound indexes below give O(log n)
  // lookups for the common recall shapes (here / her / this thing /
  // us together / in this thread) without a single table scan.
  events: defineTable({
    world_id: v.id("worlds"),
    branch_id: v.id("branches"),
    // Acting character — who triggered / received the event. Null for
    // ambient world events like era advancement.
    character_id: v.optional(v.id("characters")),
    // Location the event occurred at (entity of type "location").
    location_id: v.optional(v.id("entities")),
    // NPC referenced in / present at the event.
    npc_entity_id: v.optional(v.id("entities")),
    // Item involved in the event (slug, not id — items aren't always
    // first-class entities).
    item_slug: v.optional(v.string()),
    // Timeline-thread id for sims that branch through eras / sessions.
    // Null = canonical "main" thread.
    thread_id: v.optional(v.string()),
    // Discriminator: "narrate" | "dialogue" | "option_pick" |
    // "expansion" | "give_item" | "take_item" | "use_item" |
    // "damage" | "heal" | "era_advance" | "world_seed" | etc.
    kind: v.string(),
    // The text the player saw — full prose for narrate/dialogue,
    // short label for option_pick, etc. This is what the assembler
    // re-feeds into the prompt as "recent verbatim".
    body: v.string(),
    // Anything kind-specific (option_index, damage_amount, item.qty…).
    payload: v.optional(v.any()),
    // Salience drives compression: low → folded early, high → kept
    // verbatim across many turns. Defaults to "medium".
    salience: v.union(
      v.literal("low"),
      v.literal("medium"),
      v.literal("high"),
    ),
    // World-clock turn at write time — lets the assembler order events
    // even if `at` ms-clocks tie or drift across actions.
    turn: v.number(),
    at: v.number(),
    // Forward-compat: vector embedding for semantic recall (v2). Stored
    // as float[] when present; the assembler uses cosine-sim in the
    // action when set. Reserved here so we don't need a migration.
    embedding: v.optional(v.array(v.number())),
  })
    .index("by_branch_location_time", ["branch_id", "location_id", "at"])
    .index("by_branch_npc_time", ["branch_id", "npc_entity_id", "at"])
    .index("by_branch_item_time", ["branch_id", "item_slug", "at"])
    .index("by_branch_character_npc_time", [
      "branch_id",
      "character_id",
      "npc_entity_id",
      "at",
    ])
    .index("by_branch_character_thread_time", [
      "branch_id",
      "character_id",
      "thread_id",
      "at",
    ])
    .index("by_branch_kind_time", ["branch_id", "kind", "at"]),

  // ---------------------------------------------------------------
  // Event summaries — the compressed-history tier for the prompt
  // assembler. Two kinds of rows:
  //
  //   kind = "rebuild"  — Sonnet 1M reads the entire raw event log
  //     for (character?, thread?) up to covers_until_turn, plus
  //     bible + voice_samples, and writes one in-voice memory-book
  //     entry from scratch. Lossless rebuilds beat rolling Haiku
  //     summaries-of-summaries for voice fidelity. Triggered on era
  //     advance, session boundary, or every N turns since the last
  //     rebuild.
  //
  //   kind = "delta"    — Haiku summarizes events between the last
  //     rebuild and now. Smaller window; written explicitly in voice
  //     (sensory + emotional, not bullet recall). The assembler
  //     concatenates the most-recent rebuild + most-recent delta as
  //     the "summary" tier.
  //
  // Append-only — both old rows stay for audit. The assembler picks
  // the latest of each kind via index.
  event_summaries: defineTable({
    world_id: v.id("worlds"),
    branch_id: v.id("branches"),
    // Optional scope. Null character_id ⇒ world-level summary.
    character_id: v.optional(v.id("characters")),
    thread_id: v.optional(v.string()),
    kind: v.union(v.literal("rebuild"), v.literal("delta")),
    body: v.string(), // the prose summary itself
    // Through what turn this summary covers. Assembler uses this to
    // know which raw events are NEWER than the summary (and thus go
    // in the verbatim tier).
    covers_until_turn: v.number(),
    // Which model produced this. Diagnostic + cost accounting.
    model: v.string(),
    // For rebuilds, the hash of the source event-id list — lets us
    // dedupe on retries without scanning bodies.
    source_signature: v.optional(v.string()),
    created_at: v.number(),
  })
    .index("by_branch_character_thread_kind_time", [
      "branch_id",
      "character_id",
      "thread_id",
      "kind",
      "created_at",
    ])
    .index("by_branch_character_kind_time", [
      "branch_id",
      "character_id",
      "kind",
      "created_at",
    ])
    .index("by_branch_kind_time", ["branch_id", "kind", "created_at"]),

  // ---------------------------------------------------------------
  // NPC memory — spec 24 Ask 4. Rows per (npc_entity, world, branch)
  // with salience + event_type + summary + turn count. Compaction job
  // folds low-salience rows into weekly summaries.
  npc_memory: defineTable({
    world_id: v.id("worlds"),
    branch_id: v.id("branches"),
    npc_entity_id: v.id("entities"),
    // For player-subject memories (e.g., who did the thing). Optional —
    // initial seed entries from bible have no player.
    about_character_id: v.optional(v.id("characters")),
    event_type: v.string(), // "dialogue_turn", "the_player_visited", custom
    summary: v.string(),
    salience: v.union(v.literal("low"), v.literal("medium"), v.literal("high")),
    turn: v.number(), // world-clock turn count at write
    created_at: v.number(),
    // When rows are compacted, the originals are deleted and a new row
    // with is_compacted=true carries the roll-up summary.
    is_compacted: v.optional(v.boolean()),
  })
    .index("by_branch_npc_turn", ["branch_id", "npc_entity_id", "turn"])
    .index("by_branch_npc_salience", ["branch_id", "npc_entity_id", "salience"])
    .index("by_branch_npc_event", ["branch_id", "npc_entity_id", "event_type"]),

  // ---------------------------------------------------------------
  // Auth (pre-world)
  auth_tokens: defineTable({
    token_hash: v.string(),
    email: v.string(),
    expires_at: v.number(),
    consumed_at: v.optional(v.number()),
    created_at: v.number(),
  })
    .index("by_hash", ["token_hash"])
    .index("by_email", ["email"]),

  sessions: defineTable({
    user_id: v.id("users"),
    token_hash: v.string(),
    expires_at: v.number(),
    created_at: v.number(),
    last_used_at: v.number(),
  })
    .index("by_hash", ["token_hash"])
    .index("by_user", ["user_id"]),
});
