// Session + membership helpers. Every world-scoped query/mutation runs
// through resolveSession() + requireMembership() — rule #1 from CLAUDE.md
// (`session_token` is the interim trusted identity source until we
// integrate Convex ctx.auth).

import type { Doc, Id } from "./_generated/dataModel.js";
import { hashString } from "@weaver/engine/blobs";

export type ResolvedSession = { user: Doc<"users">; user_id: Id<"users"> };

type BaseCtx = {
  db: {
    query: (name: any) => any;
    get: (id: any) => Promise<any>;
  };
};

export async function resolveSession(
  ctx: BaseCtx,
  session_token: string,
): Promise<ResolvedSession> {
  if (!session_token) throw new Error("unauthenticated: no session token");
  const token_hash = hashString(session_token);
  const row = await ctx.db
    .query("sessions")
    .withIndex("by_hash", (q: any) => q.eq("token_hash", token_hash))
    .first();
  if (!row) throw new Error("unauthenticated: session not found");
  if ((row as Doc<"sessions">).expires_at < Date.now())
    throw new Error("unauthenticated: session expired");
  const user = (await ctx.db.get((row as Doc<"sessions">).user_id)) as
    | Doc<"users">
    | null;
  if (!user) throw new Error("unauthenticated: user deleted");
  // Note: last_used_at touch skipped — can't patch from query ctx. When a
  // mutation resolves the session it can opt into patching separately.
  return { user, user_id: user._id };
}

export async function requireMembership(
  ctx: BaseCtx,
  user_id: Id<"users">,
  world_id: Id<"worlds">,
): Promise<Doc<"world_memberships">> {
  const m = (await ctx.db
    .query("world_memberships")
    .withIndex("by_world_user", (q: any) =>
      q.eq("world_id", world_id).eq("user_id", user_id),
    )
    .first()) as Doc<"world_memberships"> | null;
  if (!m) throw new Error("forbidden: not a member of this world");
  return m;
}

/** Convenience: resolve + require in one call. */
export async function resolveMember(
  ctx: BaseCtx,
  session_token: string,
  world_id: Id<"worlds">,
): Promise<ResolvedSession & { membership: Doc<"world_memberships"> }> {
  const s = await resolveSession(ctx, session_token);
  const membership = await requireMembership(ctx, s.user_id, world_id);
  return { ...s, membership };
}
