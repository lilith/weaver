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
    .index("by_world_author", ["world_id", "author_user_id"]),

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
  }).index("by_world_active", ["world_id", "active"]),

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
    created_at: v.number(),
  })
    .index("by_artifact_version", ["artifact_entity_id", "version"])
    .index("by_branch_blob", ["branch_id", "blob_hash"]),

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
