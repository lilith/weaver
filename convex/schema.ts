// Weaver schema — entity/component/relation store plus supporting tables.
// Full shape from spec/09_TECH_STACK.md §Convex schema (Wave 0 starter).
// Schemaless `payload` fields are validated at the module boundary by Zod.

import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

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
    content_rating: v.union(
      v.literal("family"),
      v.literal("teen"),
      v.literal("adult"),
    ),
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

  // Entity / component / relation store
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

  // Chat
  chat_threads: defineTable({
    scope_entity_id: v.id("entities"), // location, world, etc.
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
    scope: v.string(), // "world_bible_edit" | "location_edit" | "rejection" | ...
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
    kind: v.string(), // "opus" | "haiku" | "sonnet" | "fal" | ...
    cost_usd: v.number(),
    reason: v.string(),
    created_at: v.number(),
  })
    .index("by_world_day", ["world_id", "created_at"])
    .index("by_user_day", ["user_id", "created_at"]),

  // Theme
  themes: defineTable({
    world_id: v.id("worlds"),
    branch_id: v.id("branches"),
    spec: v.any(), // ThemeSchema (see spec/10_THEME_GENERATION.md)
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
    edit_kind: v.string(), // "create" | "edit_prompt" | "edit_direct" | "restore"
    reason: v.optional(v.string()),
    created_at: v.number(),
  }).index("by_artifact_version", ["artifact_entity_id", "version"]),
});
