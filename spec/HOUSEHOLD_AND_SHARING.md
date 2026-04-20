# Weaver — Household and World Sharing

## What this covers

The per-family-instance deployment model (see `16_PRIVACY_AND_MINORS.md`, `00_OVERVIEW.md` principle #9) assumed a single household — but within a household, 2-5 people may want to share world(s), fork their own, or co-author a single shared one. This spec covers the membership and sharing primitives that make that work.

**Scope:** within-one-instance, within-one-household sharing. Cross-family sharing is Wave 4+.

## The shape

- **One Convex deployment per household.** All family members log in to the same instance.
- **`users` rows** per human. Magic-link email per person; no shared accounts.
- **`worlds` rows** are owned by one user (the `owner_user_id`). Ownership is transferable (`reseatPrimaryOwner`).
- **`world_memberships` rows** grant role-scoped access (`owner | family_mod | player | guardian`). A world's owner has an implicit `owner` membership.
- **Per-user characters.** Each member who plays a world gets their own `characters` row for that world. Characters are not shared — two family members playing "Quiet Vale" each have their own character with their own inventory, pseudonym, and draft-set.

This means a household can host:
- **Personal worlds** — owner only; no other memberships. Like a personal notebook.
- **Shared worlds** — owner + memberships for other family members. The typical case. Each player plays with their own character.
- **Family-mod-gated worlds** — owner designates one or more `family_mod` members who can invite others / moderate content. In practice at family scale this is optional; the owner does these actions directly.

## Shipped primitives (Wave 0)

### `_dev.preauthorizeHousehold` (commit `b4e4520`)

```ts
// Internal mutation — not exposed to the player UI.
// Usage (from the Convex CLI, as the primary):
// npx convex run '_dev:preauthorizeHousehold' '{
//   "primary_email": "lilith@example.com",
//   "member_emails": ["jason@example.com", "gen@example.com", ...],
//   "role": "player"
// }'
```

Behavior:
1. Ensures a `users` row exists for every listed email (creates placeholders if missing — auth still requires magic-link sign-in).
2. For every world owned by `primary_email`, grants a `world_memberships` row with the given role for each `member_emails` entry.
3. Idempotent: skips existing memberships, patches role in place if already granted.
4. Audit-logged: every grant produces an `audit_log` entry with `action: "role_grant"`.

**Forward-only.** The mutation seats current worlds. When the primary creates a new world after running it, the mutation must be re-run to include the new world. An `auto-share-on-seed` refinement (below) is future work.

### `_dev.reseatPrimaryOwner` (commit `58d4f28`)

```ts
// Used 2026-04-20 to move The Quiet Vale from genandlilith@gmail.com
// to river.lilith@gmail.com as the canonical household primary.
```

Behavior:
1. For every world currently owned by `from_email`, patches `worlds.owner_user_id` to the `to_email` user's id.
2. The former primary is demoted to `role: "player"` on each transferred world (keeps access, loses ownership).
3. Idempotent: worlds already owned by the new primary are skipped.
4. Audit-logged: `action: "role_revoke"` and `"role_grant"` paired.

Use case: the family has drifted which email they consider primary; move ownership without losing data.

## Shared-world conventions (today)

The pattern for Lilith's family (as of 2026-04-20):

1. **Primary seeds a world** via `seedStarterWorld(session_token, template, character_name)` — creates `worlds/<slug>`, `main` branch, owner membership, starter character at the first `safe_anchor`.
2. **Primary re-runs `preauthorizeHousehold`** with the updated family email list and `role: "player"`. Every member now has access to the world.
3. **Each member signs in** (magic link) and creates their own character via the world's character-creation flow (or `seedStarterWorld` on an already-existing world, which creates the caller's character and leaves the world alone — check whether this matches the shipped semantics).
4. **Gameplay is concurrent** — multiple characters can be in the same world; see `01_ARCHITECTURE.md` §"Multi-player sync" for how state syncs (at-transition durable, reactive chat).

The **household** itself is not modeled as a first-class entity. No `households` table. The shape emerges from: one user is the primary, they own N worlds, every other family user has memberships on those worlds. If the household changes (someone leaves, a new member joins), the primary re-runs `preauthorizeHousehold`.

## Invites vs. preauth

Two ways to grant a new user access to a world:

- **Preauth (today):** primary runs `preauthorizeHousehold` with the new email; a `users` row is created with no auth credential. The new user signs up via magic link using that email; their existing memberships are attached automatically by email match.
- **Invite (future):** world owner clicks "invite" in the UI, enters an email; system emails a magic-link-with-pre-granted-membership. Same end state, better UX for non-technical family members.

The invite-UI path is a Wave 1 task (fold into C5 auth or C7 isolation). Preauth remains as the programmatic escape hatch for bulk cases.

## Future: auto-share-on-seed

When `seedStarterWorld` creates a new world, the owner's "default household membership list" is automatically seated on it. Requires:

- A `users.default_household_members: v.array(v.id("users"))` field, populated by the primary once and re-used on every new world.
- Mutation hook in `seedStarterWorld` that inserts memberships for each default-household entry.
- Invalidation: if the household changes, the primary updates their `default_household_members` list; subsequent worlds inherit the new list.

Not urgent. The current preauth flow works; auto-share is convenience. File as a Wave 1 polish task.

## Character ownership and visibility

- A **character** row belongs to exactly one `user_id` and one `world_id`.
- One user may have many characters (across worlds, or multiple in one world if the world allows).
- Character state — inventory, HP, gold, relationships, position — is never shared with other users, even within the same world. Each player's state is their own.
- Characters' **pseudonym** is the only facet visible to other players in chat / location bylines / journey summaries.

This means "playing the same world together" means sharing the **world map and canonical content**, not sharing a character. A character is the per-player lens on the shared world.

## Drafts and shared worlds

Per `ISOLATION_AND_SECURITY.md` §"Draft/canon visibility":

- Drafts are **per-character**, not per-world. Mara's drafts are visible to Mara's character only.
- When a character `saveToMap`s a draft, it becomes canonical — visible to every other character in the world.
- World owner does not automatically see another player's drafts. Owner wants to browse another's drafts? They ask.

This keeps wandering private until the player commits.

## Ownership transfer — when and why

`reseatPrimaryOwner` is a deliberate action. Cases where it makes sense:

- Primary email changed (new address, personal-to-shared, etc.).
- Primary stepped back; another family member takes over.
- Account closed / migrated.

It is **not** automatic. The mutation runs explicitly with both emails named.

## Backup and data longevity

### Quiet Vale backup to a separate repo (user-flagged 2026-04-20)

The family's active shared world is only in Convex. A disk failure, an accidental `_dev.deleteWorld`, or a Convex incident could lose everything. The plan:

- A `scripts/backup-world.mjs` that exports one world (entities, components, artifact_versions, chat_threads, chat_messages, journeys, blobs referenced by any of those) to a tarball.
- Push the tarball to a dedicated private git repo `weaver-family-worlds` (separate from this public repo).
- Restore is either `npx convex import` (Pro plan) or a custom import mutation that recreates entities from blob hashes.
- See `12_BLOB_STORAGE.md` §"Periodic snapshot" for the current shape of this idea.

**Do not delete or overwrite Quiet Vale** until backup lands.

Timing: before any destructive refactor touching world content. Ideally before the first family-playable-for-real milestone.

### Nightly export

`AUTHORING_AND_SYNC.md` describes a `weaver export` CLI + nightly cron. Neither is shipped yet. When built:

- Cron runs nightly, writes per-world snapshot directories to `WEAVER_BACKUP_DIR`.
- Snapshots are file-layout-per-world so Claude Code can work against them offline.
- Snapshots do NOT include blob bytes by default (blob hashes are stable; bytes are implicitly backed up via R2's durability).

Once the export CLI ships, the backup-world.mjs path collapses into "export + tarball + push."

## Access-control matrix (for reference)

| Action | Owner | Family-mod | Player | Guardian (of linked minor) | Non-member |
|---|---|---|---|---|---|
| Read any canonical location | ✓ | ✓ | ✓ | ✓ | ✗ |
| Read own drafts | ✓ | ✓ | ✓ | ✓ | ✗ |
| Read another member's drafts | ✗ | ✗ | ✗ | ✓ (linked minor's) | ✗ |
| Create/edit own characters | ✓ | ✓ | ✓ | ✓ | — |
| Edit canonical location | ✓ | ✓ | ✓ (if author) | ✗ | ✗ |
| Save draft to map | ✓ (own) | ✓ (own) | ✓ (own) | ✓ (linked minor's) | — |
| Invite new user | ✓ | ✓ (if UI ships) | ✗ | ✗ | — |
| Transfer ownership | ✓ | ✗ | ✗ | ✗ | — |
| Delete world | ✓ | ✗ | ✗ | ✗ | — |

## Integration into other specs

- **`09_TECH_STACK.md`** — `world_memberships` table already documented.
- **`ISOLATION_AND_SECURITY.md`** — rules 14 (per-world memberships, no global roles), 16 (auth token doesn't embed world auth), 17 (character selection per-world), 18 (pseudonym uniqueness per branch) already cover the security posture.
- **`19_JOURNEYS_AND_JOURNAL.md`** — assumes the character-per-user model; drafts per character aligns with the visibility rules above.
- **`CLAUDE.md` known bugs** — references this spec for the Quiet Vale backup plan and the preauth forward-only limitation.

## Open questions

- **Household as a first-class entity?** If the family grows beyond one home (grown kids with their own households using the same instance), `users.household_id` + a `households` table would become useful. For now: single household = the instance.
- **Auto-invite on seed.** Defer until manual preauth feels tedious.
- **Guardian role semantics.** `16_PRIVACY_AND_MINORS.md` collapsed the COPPA apparatus. Guardian role survives in schema but has no UI surface today. Wave 4+ when cross-family deployment lands.
