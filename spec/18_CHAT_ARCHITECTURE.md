# Weaver — Chat Architecture

*Light spec for Wave 1 in-process chat and the identity model it rides on. Ancestry from `weaver-chat` (prior project). Revisit when chat needs to split out as its own service.*

## Scope

Per-location chat threads for family play. Every location with `tags: [has_chat]` has a `chat_thread_id` attached; players at that location can post messages visible to all players currently there.

Wave 1 is **in-process chat**: chat runs inside the main Convex deployment, no separate service, no signed transport, no cross-world federation. This document specifies the identity model (which is permanent) and the in-process implementation (which Wave 1 ships), and notes the Wave 2+ extraction path (which is optional).

## Identity model — user → profile → display

This is the durable part. The layering matters because chat shows *who said what*, and the chain from wire-identity to display-identity must be unambiguous.

```
users                    = auth identity, 1 per human
  ↓ linked 1:many via characters.user_id
characters               = in-world identity, 1+ per user per (world, branch)
  ↓ embeds
characters.pseudonym     = display handle for this character in this branch
  ↓ shown as
chat.pseudonym           = snapshot of pseudonym at post time
```

Key rules:

1. **`user_id` never appears in chat UI.** It's the join key to permissions and moderation; it stays server-side.
2. **`pseudonym` is per-character-per-branch.** A player can have a different pseudonym in different branches or different characters in the same world. Chat shows the one belonging to the character who posted.
3. **Pseudonyms are mutable. Posted messages are not.** When a character renames from "Stardust" to "Nova," new messages post as "Nova" but past messages stay attributed to "Stardust." The `pseudonym` field on `chat_messages` is a snapshot, not a foreign key.
4. **Display name can diverge from pseudonym.** A character may eventually have a nickname pattern ("Stardust of the Vale") rendered in chat; the authoritative underlying identity is the character row.

### Schema reminder

From `09_TECH_STACK.md`:

```ts
chat_threads: {
  scope_entity_id: Id<"entities">,  // typically a location
  world_id, branch_id, created_at,
}

chat_messages: {
  thread_id: Id<"chat_threads">,
  character_id: Id<"characters">,
  pseudonym: string,                // SNAPSHOT at post time; see rule 3
  body: string,
  created_at: number,
}
```

`pseudonym` being a snapshot is the single design decision that makes rename-safe chat trivial.

## Wave 1 in-process implementation

Everything happens inside the same Convex deployment. No separate chat service, no auth bridge.

### Post flow

```
client (optimistic) → Convex mutation postMessage(thread_id, body)
  ↓
verify: ctx.auth.userId matches a character with access to the thread
  ↓
insert chat_messages row (pseudonym = character.pseudonym at post time)
  ↓
reactive subscribers to the thread re-render
```

### Read flow

Reactive Convex query subscribes to `chat_messages` where `thread_id = X`, ordered by `created_at`, paginated. Svelte component binds to it and renders.

### Thread lifecycle

- Created lazily on first post to a location with `has_chat` tag. No thread row exists until there's a message.
- Scoped to `(world, branch, location)` triple via `scope_entity_id` pointing at the location entity.
- Archived (read-only) if the scope entity is marked `deleted` (rare in practice; Weaver doesn't really delete entities — versioning preserves history).

### Mute / ignore

Client-side only in Wave 1. A character's settings carry a `muted_character_ids: []` list; the chat view filters client-side. Server still stores all messages; mute is a rendering choice. No server-side suppression needed at family scale.

### Chat in the expansion loop

A chat message is **not** the same as a free-text input to the expansion loop. They look similar to users ("I type something") but the system routes them differently:

- **Free-text input** on the location view → intent classifier → atom dispatch (see `04_EXPANSION_LOOP.md`).
- **Chat message** in the chat panel → no classifier, just post. Chat is player-to-player, not player-to-world.

The UI distinguishes visually: chat panel has a send icon, the location input has a wand icon.

## Cross-branch visibility

A character can exist in multiple branches (see `13_FORKING_AND_BRANCHES.md` cross-branch character portability). Their chat history does **not** follow them across branches — chat is branch-scoped. This is deliberate: a branch is "what if," and conversations in the "what if" aren't canonical in the parent branch.

If a fork operation copies a character into a new branch, their chat in the parent branch is unaffected; in the new branch, they start fresh. This falls out naturally from `chat_threads.branch_id`.

## Wave 2+ extraction path (optional, not committed)

If chat ever splits out as its own service — for horizontal scaling, for federation across family instances, for a public-worlds deployment (Wave 4+) — the pieces that change are:

1. **Transport.** A signed, authenticated wire protocol between the main app and the chat service. `weaver-chat` used HMAC-signed JSON over WebSocket; that pattern is still viable. The SDK on the main-app side hides the signing.
2. **Identity bridge.** The chat service doesn't know what a `user_id` is. The main app issues short-lived signed tokens binding `(user_id, character_id, pseudonym, thread_permissions)` that the chat service validates without a database lookup.
3. **Moderation surface.** Cross-family requires real moderation (see `16_PRIVACY_AND_MINORS.md` §Wave 4+). That's where a separate chat service starts paying for itself — moderation tooling lives on the chat service side.

What stays unchanged in an extraction:
- The identity model above (user → character → pseudonym).
- The pseudonym-snapshot-at-post rule.
- Per-branch scoping.
- The distinction between chat message and free-text game input.

**Don't build for this in Wave 1.** Build the schema and the identity model correctly; let extraction be a refactor when (if) it's needed.

## Open questions

- **Chat on non-location entities.** Encounters? The world itself? Wave 1 only attaches chat to locations. If combat encounters want chat ("the fight raged for an hour, here's the play-by-play"), the scope_entity_id generalization covers it — no schema change needed. Whether the UI surfaces it is a product decision for Wave 2.
- **Longform chat history export.** For family keepsake purposes, an "export our chats from the Vale" action might be valuable. Not in Wave 1; consider during `AUTHORING_AND_SYNC.md` extensions.
- **Ephemeral chat.** "Whispered" private messages between two characters at the same location? Fun. Wave 3+ if at all.
- **Voice messages.** `15_VOICE_INPUT.md` handles voice-to-text for inputs. Chat via voice (audio bubble, transcript underneath) is a separate affordance. Wave 3+.
