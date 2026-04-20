// Weaver schema — entity/component/relation store, content-addressed payloads
// via blob hashes. Shape from spec/09_TECH_STACK.md with Wave-0 amendments
// from spec/12_BLOB_STORAGE.md (blob table + blob_hash on components and
// artifact_versions + entities.current_version) and spec/16_PRIVACY_AND_MINORS.md
// (user privacy fields).

import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // ---------------------------------------------------------------
  // Identity
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
    slug: v.string(),
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

  branches: defineTable({
    world_id: v.id("worlds"),
    name: v.string(),
    slug: v.string(),
    parent_branch_id: v.optional(v.id("branches")),
    transient: v.boolean(),
    expires_at: v.optional(v.number()),
    created_at: v.number(),
  })
    .index("by_world", ["world_id"])
    .index("by_world_slug", ["world_id", "slug"]),

  characters: defineTable({
    user_id: v.id("users"),
    world_id: v.id("worlds"),
    branch_id: v.id("branches"),
    name: v.string(),
    pseudonym: v.string(),
    current_location_id: v.optional(v.id("entities")),
    // Per-player state scope: { inventory: [], hp, gold, energy, location_visits, ... }
    state: v.any(),
    schema_version: v.number(),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_user_world", ["user_id", "world_id"])
    .index("by_branch", ["branch_id"]),

  // ---------------------------------------------------------------
  // Entity / component / relation store. Entity is the head pointer;
  // components carry authored payload (via blob_hash); relations carry
  // predicates between entities.
  entities: defineTable({
    type: v.string(), // "location" | "character" | "npc" | "item" | "encounter" | "ref" | "theme" | "biome" | "bible"
    slug: v.string(), // authoring-stable id, unique per (branch, type)
    branch_id: v.id("branches"),
    world_id: v.id("worlds"),
    current_version: v.number(), // points at artifact_versions.version
    schema_version: v.number(),
    author_user_id: v.optional(v.id("users")),
    author_pseudonym: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_branch_type", ["branch_id", "type"])
    .index("by_branch_type_slug", ["branch_id", "type", "slug"])
    .index("by_world_type", ["world_id", "type"])
    .index("by_author", ["author_user_id"]),

  // Components carry a typed slice of entity state. Payload bytes are
  // blob-referenced; canonicalized JSON in most cases, text for scripts.
  components: defineTable({
    entity_id: v.id("entities"),
    component_type: v.string(), // "location_data" | "character_ref" | "inline_script" | "bible" | "biome" | ...
    blob_hash: v.string(),
    content_type: v.string(), // "application/json" | "text/weaver-script" | ...
    schema_version: v.number(),
  })
    .index("by_entity_type", ["entity_id", "component_type"])
    .index("by_type", ["component_type"])
    .index("by_blob", ["blob_hash"]),

  // Relations: typed predicates between entities. Small structured
  // payloads stay inline (bonds, counters); larger ones would go via blob.
  relations: defineTable({
    subject_id: v.id("entities"),
    predicate: v.string(), // "fed_doe" | "owns" | "knows_secret" | ...
    object_id: v.id("entities"),
    payload: v.optional(v.any()),
    version: v.number(),
  })
    .index("by_subject_pred", ["subject_id", "predicate"])
    .index("by_object_pred", ["object_id", "predicate"])
    .index("by_predicate", ["predicate"]),

  // ---------------------------------------------------------------
  // Auth — Wave 0 minimal magic-link flow. Swap to @convex-dev/better-auth
  // when OAuth / password / 2FA are actually needed.
  auth_tokens: defineTable({
    token_hash: v.string(), // hex hash of the random token (never store plaintext)
    email: v.string(),
    expires_at: v.number(),
    consumed_at: v.optional(v.number()),
    created_at: v.number(),
  })
    .index("by_hash", ["token_hash"])
    .index("by_email", ["email"]),

  sessions: defineTable({
    user_id: v.id("users"),
    token_hash: v.string(), // hex hash of the session token
    expires_at: v.number(),
    created_at: v.number(),
    last_used_at: v.number(),
  })
    .index("by_hash", ["token_hash"])
    .index("by_user", ["user_id"]),

  // ---------------------------------------------------------------
  // Content-addressed blob store. Small payloads (<4KB) live inline
  // in Convex; larger ones in R2 at blob/<aa>/<bb>/<full-hash>.
  blobs: defineTable({
    hash: v.string(), // BLAKE3 hex (32 bytes, 64 chars)
    size: v.number(),
    content_type: v.string(),
    storage: v.union(v.literal("inline"), v.literal("r2")),
    inline_bytes: v.optional(v.bytes()),
    r2_key: v.optional(v.string()),
    first_referenced_at: v.number(),
    last_referenced_at: v.number(),
    ref_count: v.number(),
  }).index("by_hash", ["hash"]),

  // ---------------------------------------------------------------
  // Async art generation queue
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
    result_blob_hash: v.optional(v.string()),
    error: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_status", ["status", "created_at"])
    .index("by_entity", ["entity_id"]),

  // ---------------------------------------------------------------
  // Durable flow runtime
  flows: defineTable({
    module_name: v.string(),
    schema_version: v.number(),
    character_id: v.id("characters"),
    state: v.union(
      v.literal("running"),
      v.literal("waiting"),
      v.literal("completed"),
      v.literal("escaped"),
    ),
    stack_depth: v.number(),
    parent_flow_id: v.optional(v.id("flows")),
    throwaway: v.boolean(), // dream flows
    created_at: v.number(),
    updated_at: v.number(),
  }).index("by_character", ["character_id"]),

  events: defineTable({
    flow_id: v.id("flows"),
    op_index: v.number(),
    op: v.any(), // { kind, args }
    result: v.optional(v.any()),
    seed: v.string(),
    created_at: v.number(),
  }).index("by_flow_index", ["flow_id", "op_index"]),

  // ---------------------------------------------------------------
  // Chat
  chat_threads: defineTable({
    scope_entity_id: v.id("entities"),
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

  // ---------------------------------------------------------------
  // Mentorship log (append-only)
  mentorship_log: defineTable({
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
    .index("by_user_time", ["user_id", "created_at"])
    .index("by_scope_time", ["scope", "created_at"]),

  // ---------------------------------------------------------------
  // Cost ledger
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
    .index("by_user_day", ["user_id", "created_at"]),

  // ---------------------------------------------------------------
  // Theme (active spec lives here; regenerations insert new rows
  // and flip .active)
  themes: defineTable({
    world_id: v.id("worlds"),
    branch_id: v.id("branches"),
    spec: v.any(),
    version: v.number(),
    active: v.boolean(),
    created_at: v.number(),
  }).index("by_world_active", ["world_id", "active"]),

  // ---------------------------------------------------------------
  // Artifact version history (for rollback). Payload is blob-referenced.
  artifact_versions: defineTable({
    artifact_entity_id: v.id("entities"),
    version: v.number(),
    blob_hash: v.string(),
    content_type: v.string(),
    author_user_id: v.optional(v.id("users")),
    author_pseudonym: v.optional(v.string()),
    edit_kind: v.string(), // "create" | "edit_prompt" | "edit_direct" | "restore"
    reason: v.optional(v.string()),
    created_at: v.number(),
  })
    .index("by_artifact_version", ["artifact_entity_id", "version"])
    .index("by_blob", ["blob_hash"]),
});
