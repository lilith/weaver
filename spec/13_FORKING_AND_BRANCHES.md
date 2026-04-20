# Weaver — Forking and Branches

## Feasibility: yes

Full forking is not just feasible — with the blob architecture from `12_BLOB_STORAGE.md`, it's architecturally the simplest feature in the system. A branch is a set of entity heads pointing at blobs. Forking duplicates heads rows; blob store unchanged. A million-location world forks in milliseconds.

This doc specifies the forking model, the handling of in-flight state (event logs, active flows, chat), and the four user-facing features that ride on top of it: **branches**, **dreams**, **state-fork testing**, and **cross-branch character portability**.

## What a branch is

A branch is a named slice of the universe. It has:

- An id and name.
- An optional parent branch id (root branches have none).
- A world id (branches always belong to a world).
- A creation timestamp and creator.
- A set of entity rows (locations, characters, NPCs, items, refs, etc.) scoped to this branch via `branch_id`.
- A per-branch event log for its active and completed flows.
- A per-branch chat thread set.

Branches are cheap. All content (JSON payloads, scripts, images, etc.) lives in the shared blob store. Forking a branch copies metadata rows (entities, components, relations, characters) with a new `branch_id`, but the `blob_hash` references point at the same content. Divergence happens lazily: only when someone edits in one branch does a new blob get written.

## Fork operation

```
fork_branch(source_branch_id, new_name, character_policy, options) → new_branch_id
```

The fork operation creates a new branch and duplicates the heads-level state. It does NOT copy the blob store (references are shared). It does NOT copy the event log (see below).

### Implementation sketch

```ts
export const forkBranch = mutation({
  args: {
    source_branch_id: v.id("branches"),
    new_name: v.string(),
    character_policy: v.union(v.literal("same"), v.literal("fresh"), v.literal("select")),
    selected_characters: v.optional(v.array(v.id("characters"))),
    fork_at: v.optional(v.number()),  // timestamp for point-in-time fork; defaults to now
  },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.source_branch_id)
    const world_id = source.world_id
    const fork_at = args.fork_at ?? Date.now()

    // 1. Resolve active flows in source branch at fork_at (fire escape handlers).
    //    Captures a clean "settled" state for the fork.
    await settleActiveFlows(ctx, args.source_branch_id, fork_at)

    // 2. Create the new branch row.
    const new_branch_id = await ctx.db.insert("branches", {
      world_id,
      name: args.new_name,
      parent_branch_id: args.source_branch_id,
      fork_point_timestamp: fork_at,
      created_at: Date.now(),
      created_by: ctx.auth.userId,
    })

    // 3. Copy entity heads.
    // For each entity in source branch, create a new entity row in new branch
    // with current_version = version-that-was-current-at-fork_at.
    await copyEntityHeads(ctx, args.source_branch_id, new_branch_id, fork_at)

    // 4. Copy components at fork_at version.
    await copyComponents(ctx, args.source_branch_id, new_branch_id, fork_at)

    // 5. Copy relations at fork_at version.
    await copyRelations(ctx, args.source_branch_id, new_branch_id, fork_at)

    // 6. Copy character rows per policy.
    await copyCharacters(ctx, args.source_branch_id, new_branch_id, args.character_policy, args.selected_characters, fork_at)

    // 7. Fresh chat threads: for each location in new branch, create an empty chat_thread.
    //    (See "Chat on fork" below for reasoning.)
    await createFreshChatThreads(ctx, new_branch_id)

    return new_branch_id
  },
})
```

Because everything references blobs by hash, the whole copy is a metadata operation. No bytes move. For a world with 10,000 locations + 500 NPCs + 100 characters, the fork runs in well under a second on Convex.

### Fork at time T

If `fork_at` is in the past, the copy queries `artifact_versions` for each entity to find the latest version with `created_at ≤ fork_at`, and uses that as the new branch's current_version. This is how point-in-time forks ("let's fork from the state we were in three days ago") work.

If `fork_at` is now (the default), the currently-active version of each entity is used.

The blob store makes this essentially free. A version that was current three days ago is still addressable by its blob hash; the blob is still there; the artifact_versions row points at it. All we do is set `entity.current_version = that_older_version` in the new branch.

## Event log handling

When a fork happens, what becomes of in-flight flows (active fights, open dialogues, mid-turn quest state)?

**Default policy: fresh event log in the new branch.**

Before the fork completes, the runtime calls each active flow's `escape_handler` in the source branch. Each flow resolves gracefully ("the scene ended quietly") against the source. The source branch continues normally; the new branch starts with no active flows.

This is the cleanest semantic: forks are "from this settled moment onward." Players in the new branch don't inherit mid-fight state from the source branch.

Rationale:
- Mid-state transfer across forks is a source of bugs we don't need.
- In-game, a fork is conceptually "going back and trying again from a safe point."
- If a family really wants to carry a specific in-flight encounter across, they can do it manually via the prompt-edit tooling (rare).

### Advanced: `--preserve-flows` option

For specific use cases (debugging, competitive play where forking mid-action matters), a power-user option preserves flow event logs. Each active flow's events are duplicated with new flow_ids in the new branch; flows continue running in both branches independently. This is NOT the default, requires world-owner permission, and is flagged in the branch metadata.

## Character handling

Three policies when forking:

| Policy | Behavior |
|---|---|
| `same` | Each character is duplicated into the new branch with identical state at fork_at. Players can play in both branches simultaneously. |
| `fresh` | Characters reset to starter state in the new branch. Inventory, level, relationships, memory — blank slate. Same pseudonyms available. |
| `select` | Prompt for each character: keep current state, or reset. Useful when some family members want to continue and others want a fresh start. |

The character's user_id link is preserved in all cases. The new character row is a new entity with the same user_id; forking doesn't create new users.

## Chat on fork

**Chat threads are always fresh in a new branch.** Chat is scoped to `(branch_id, location_id)`, and a new branch gets new threads.

Rationale:
- Chat is ephemeral conversation, not world-canon.
- Copying chat feels weird: "why did Stardust say something about a fight we didn't have?"
- Per-branch chat threads let branches have distinct social flavor.

Opt-out: world owner can enable "inherit chat history" per-fork for continuity worlds. Defaults off.

## The four features built on forking

### 1. Named branches (Wave 3 primary feature)

User-facing: "Create a branch." A family may want to explore alternative paths ("what if we never crossed the bridge?"), try creative experiments ("what if we reset the weather to winter?"), or split the world for two play styles.

UI entry point: world settings → Branches → "New branch." Asks for name, character policy, and optional fork point (default: now).

Switching branches: each user picks which branch they're playing in at any time. Characters are per-branch, so switching means playing a different version of your character in a different timeline.

Branch navigation: displayed as a tree rooted at the world's initial branch. Active branch highlighted. Click to switch.

### 2. Dreaming (Wave 3)

Weaver's original concept: a throwaway execution context. State changes during the dream are discarded when the dream ends.

Implementation via forking:

```
enter_dream(character_id) →
  // Create a transient branch.
  dream_branch = forkBranch(source=character.branch_id, 
                             policy="same", 
                             transient=true)
  // Move character to dream branch.
  character.branch_id = dream_branch
  character.in_dream = true
  
  // Dream plays out normally in the dream branch.
  // Any blob writes go to shared store; any heads updates in dream_branch only.

exit_dream(character_id) →
  // Return character to source branch, at source branch's current state of that character.
  character.branch_id = dream_branch.parent_branch_id
  character.in_dream = false
  
  // Schedule dream_branch for deletion (24h grace period in case of "remember this").
  mark_transient_expiry(dream_branch, +24h)
```

The dream leaves no trace in the source branch. Optionally, a `remember_from_dream` action writes a specific event from the dream into the source branch's event log as a memory — this is opt-in, gated by UI.

Transient branches are marked `transient: true, expires_at: number` on the branches row. A nightly action deletes expired transient branches (deletes heads rows only; blobs unchanged, garbage-collectable later if ref count drops).

### 3. State-fork testing (developer tool)

Lilith's original design from `todo.mdown`. Purpose: compare outcomes of multiple action sequences from the same starting state.

Implementation:

```ts
// packages/test/stateFork.ts
export async function stateFork(
  initial_state: BranchSnapshot,
  experiments: Array<{ name: string, actions: Action[] }>,
): Promise<ExperimentResults[]> {
  const results = []
  for (const exp of experiments) {
    // Create ephemeral branch from snapshot.
    const branch = await createEphemeralBranch(initial_state)
    try {
      const trace = []
      let state = await readBranchState(branch)
      for (const action of exp.actions) {
        state = await applyAction(branch, state, action)
        trace.push({ action, state_hash: hashBranchState(state) })
      }
      results.push({ name: exp.name, final_state: state, trace })
    } finally {
      await deleteEphemeralBranch(branch)
    }
  }
  return results
}
```

Each experiment runs in isolation. Shared blob store makes fork + teardown nearly free (just metadata). Results compared by state hash or by domain-specific predicates ("did the player end with the key?" "what's the final HP?").

Use cases:
- Unit-like tests that assert specific action sequences yield specific states.
- Regression tests: replay the same experiments after a code change, diff results.
- Pre-merge invariant checks: run a canonical experiment suite on every PR.
- Player-visible "simulate this choice" feature (later waves).

Cheap enough to run thousands per test suite. Deterministic RNG + cached AI ensures reproducibility.

### 4. Cross-branch character portability (Wave 3)

A player builds up a character in Branch A, wants to visit Branch B (run by another family, say) with the same character.

Flow:
1. Player initiates "port character to branch B."
2. System exports character state as a blob (already a blob, actually — character state is stored via blob hash).
3. Branch B's owner reviews the import request (permission check).
4. On accept: new character row in Branch B with `user_id=player_user_id`, state blob = same hash.
5. Character is now live in Branch B, playable there. Original character in Branch A unchanged.

Because state is content-addressed, the "port" operation is metadata-only. The same blob is now referenced by two characters in two branches. Zero data transfer.

Edge cases:
- Inventory items that are branch-specific (a named NPC's quest reward) may or may not make sense in the target branch. Port-time validation flags items whose referenced entities don't exist in the target branch; player chooses to drop them or keep as "lore" items.
- Level / abilities port as-is.
- Relationships to NPCs in source branch are dropped (the NPCs don't exist in target branch).

## Era / chronicle handling

Eras are chronological chapters within a branch, not separate branches. An era transition:
- Writes a chronicle entry (Opus-narrated summary of the era) into the branch's permanent lore.
- Locks prior-era artifacts as read-only.
- Advances world time.

Eras do NOT use forking. They advance linearly within a branch. But a fork from an era-N point into a new branch starts that branch in era-N, with era history inherited.

When a branch forks, the era history is copied by reference (chronicle entries are blobs, so "copying" is just pointing at the same blobs).

## Permissions

Who can fork?

- **World owner**: always.
- **Family-mod**: yes, unless owner restricts.
- **Player**: can fork *for personal branches* (their own tree), not alter main branches. Personal branches are visible only to the player unless shared.

Who can delete a branch?

- **World owner**: any branch.
- **Family-mod**: any non-root branch.
- **Player**: their own personal branches.

Deletion is soft by default: branch marked `deleted_at`, heads rows kept for 30 days in case of undo, then hard-deleted. Blobs referenced only by the deleted branch remain until GC (default disabled; effectively permanent).

## Schema additions

```ts
// Addition to branches table
branches: defineTable({
  world_id: v.id("worlds"),
  name: v.string(),
  parent_branch_id: v.optional(v.id("branches")),
  fork_point_timestamp: v.optional(v.number()),    // null for root branches
  transient: v.boolean(),                          // true for dreams, test forks
  expires_at: v.optional(v.number()),              // for transient branches
  created_at: v.number(),
  created_by: v.id("users"),
  deleted_at: v.optional(v.number()),
}).index("by_world", ["world_id"])
  .index("by_parent", ["parent_branch_id"])
  .index("by_expiry", ["expires_at"]),
```

No other schema changes. Entity/component/relation tables already carry `branch_id`; the fork operation just duplicates rows with new branch_id.

## Cost

- **Fork operation:** O(entities + components + relations). For a 10k-entity world, ~30-60 seconds of Convex write throughput. Cost: a few cents per fork.
- **Ongoing cost of maintaining branches:** linear in branch count. Each branch adds the Convex metadata footprint of its entity rows. Blobs shared.
- **Transient branch teardown:** O(entities). Similar to fork, runs during nightly GC.

A family that creates 10 named branches over a year spends a few dollars in fork operations and adds maybe 500MB of Convex metadata. Trivial.

## Implementation sequencing

**Wave 1** (closed beta):
- Schema additions above.
- Blob storage integration complete.
- State-fork testing implemented as a test harness utility.
- No user-facing branch UI.

**Wave 3** (main branches feature):
- User-facing branch management UI.
- Fork flow with character policy selection.
- Dreams.
- Cross-branch character portability.
- Era chronicle integration.

## Edge cases and gotchas

- **Deterministic RNG across forks:** RNG seed derives from `(branch_id, turn, flow_id, op_index)`. After a fork, the new branch has a different branch_id, so RNG streams diverge naturally. No risk of lockstep coincidence.
- **AI response cache across forks:** cache key is `(prompt_hash, seed, model_version)`. Since seed includes branch_id, AI responses don't cross-contaminate across branches by default. This is usually what you want (each branch gets fresh AI). A specific "share AI cache across branches" option exists for the special case of "I want this branch to have identical generated content to the parent."
- **Mentorship log on fork:** the mentorship log is per-user, not per-branch. An edit a user made in Branch A doesn't re-fire in Branch B. The style profile trained from it applies everywhere.
- **Cost ledger on fork:** also per-user and per-world, not per-branch. Forking doesn't duplicate historical costs; new activity in the new branch accumulates normally.
- **External refs (generated images):** shared blobs, shared R2 objects. Deleting a branch doesn't risk deleting art that's shared with another branch. Ref counts protect against that.

## Test coverage

- Unit: fork produces correct entity / component / relation counts.
- Unit: entity heads in new branch point at correct versions per fork_at.
- Unit: transient branch expires and is deleted by GC.
- Property: fork(X) then fork(X) produces two independent, non-interfering branches.
- Integration: play 10 actions in Branch A, fork, play 10 more in Branch A and 10 different in Branch B, verify final states diverge as expected and blob store contains only the distinct-content blobs.
- Load: 1000 simultaneous forks against a single source branch.

## Integration into existing specs

- **`01_ARCHITECTURE.md`** — add §"Branches and forking" pointing here.
- **`06_TESTING.md`** — rewrite §"Seed states" to describe state-fork testing as the harness primitive; remove the old in-memory snapshot/restore sketch.
- **`09_TECH_STACK.md`** — add scheduled action for transient branch GC.

## Summary

Forking is a first-class operation built atop immutable blobs. Its feasibility at every scale Weaver will ever see is not in question. The design above handles the four concrete use cases (branches, dreams, testing, portability) with one primitive and clean semantics for the hard parts (event logs, chat, characters).

The hardest implementation work is the event log settlement logic (invoking escape handlers correctly, cleanly handing off to the fresh branch). That's a Wave 3 concern. Wave 1 implements the primitive, uses it only for testing, and proves correctness before exposing it to users.
