// Minimal magic-link auth (Wave 0).
// Flow:
//   1. client → requestMagicLink({ email }) — Convex action, sends email via Resend
//   2. user clicks link → /auth/verify?token=<plaintext>
//   3. client → verifyMagicLink({ token }) — mutation, creates user if new, issues session
//   4. client stores session cookie, passes session token on subsequent queries
//
// Tokens are 32 bytes of random, hex-encoded (64 chars). Only the BLAKE3 hash
// of each token is stored server-side.

import { action, mutation, query, internalMutation } from "./_generated/server.js";
import { v } from "convex/values";
import { Resend } from "resend";
import { internal } from "./_generated/api.js";
import { hashString, bytesToHex } from "@weaver/engine/blobs";

const MAGIC_LINK_TTL_MS = 15 * 60 * 1000; // 15 minutes
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export const requestMagicLink = action({
  args: {
    email: v.string(),
    origin: v.string(), // e.g. "https://theweaver.quest" or "http://localhost:5173"
  },
  handler: async (ctx, { email, origin }) => {
    const normalized = email.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(normalized)) {
      throw new Error("invalid email");
    }
    const token = randomToken();
    const token_hash = hashString(token);
    const now = Date.now();

    await ctx.runMutation(internal.auth.storeAuthToken, {
      token_hash,
      email: normalized,
      expires_at: now + MAGIC_LINK_TTL_MS,
      created_at: now,
    });

    const url = `${origin}/auth/verify?token=${token}`;
    const resendKey = process.env.RESEND_API_KEY;
    const from = process.env.RESEND_FROM_EMAIL ?? "Weaver <noreply@theweaver.quest>";
    if (!resendKey) throw new Error("RESEND_API_KEY not configured");
    const resend = new Resend(resendKey);
    const { error } = await resend.emails.send({
      from,
      to: normalized,
      subject: "Sign in to Weaver",
      text: `Click to sign in: ${url}\n\nThis link expires in 15 minutes. If you didn't request it, ignore this email.`,
      html: `<p>Click to sign in to Weaver:</p><p><a href="${url}">${url}</a></p><p>This link expires in 15 minutes. If you didn't request it, ignore this email.</p>`,
    });
    if (error) throw new Error(`email send failed: ${JSON.stringify(error)}`);
    return { ok: true };
  },
});

export const storeAuthToken = internalMutation({
  args: {
    token_hash: v.string(),
    email: v.string(),
    expires_at: v.number(),
    created_at: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("auth_tokens", args);
  },
});

export const verifyMagicLink = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const token_hash = hashString(token);
    const row = await ctx.db
      .query("auth_tokens")
      .withIndex("by_hash", (q) => q.eq("token_hash", token_hash))
      .first();
    if (!row) throw new Error("invalid or expired link");
    if (row.consumed_at) throw new Error("link already used");
    if (row.expires_at < Date.now()) throw new Error("link expired");

    await ctx.db.patch(row._id, { consumed_at: Date.now() });

    // Find or create user.
    let user = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", row.email))
      .first();
    if (!user) {
      const userId = await ctx.db.insert("users", {
        email: row.email,
        display_name: row.email.split("@")[0],
        is_minor: false,
        guardian_user_ids: [],
        created_at: Date.now(),
      });
      user = (await ctx.db.get(userId))!;
    }

    // Issue session.
    const sessionToken = randomToken();
    const session_token_hash = hashString(sessionToken);
    const now = Date.now();
    await ctx.db.insert("sessions", {
      user_id: user._id,
      token_hash: session_token_hash,
      expires_at: now + SESSION_TTL_MS,
      created_at: now,
      last_used_at: now,
    });
    return {
      session_token: sessionToken,
      user_id: user._id,
      email: user.email,
      display_name: user.display_name,
    };
  },
});

export const getSessionUser = query({
  args: { session_token: v.string() },
  handler: async (ctx, { session_token }) => {
    if (!session_token) return null;
    const token_hash = hashString(session_token);
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_hash", (q) => q.eq("token_hash", token_hash))
      .first();
    if (!session) return null;
    if (session.expires_at < Date.now()) return null;
    const user = await ctx.db.get(session.user_id);
    if (!user) return null;
    return {
      user_id: user._id,
      email: user.email,
      display_name: user.display_name,
      is_minor: user.is_minor,
    };
  },
});

export const logout = mutation({
  args: { session_token: v.string() },
  handler: async (ctx, { session_token }) => {
    const token_hash = hashString(session_token);
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_hash", (q) => q.eq("token_hash", token_hash))
      .first();
    if (session) await ctx.db.delete(session._id);
    return { ok: true };
  },
});

/** Periodic sweep of expired tokens and sessions. Run via a scheduled action. */
export const sweepExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const expiredTokens = await ctx.db
      .query("auth_tokens")
      .filter((q) => q.lt(q.field("expires_at"), now))
      .collect();
    for (const t of expiredTokens) await ctx.db.delete(t._id);
    const expiredSessions = await ctx.db
      .query("sessions")
      .filter((q) => q.lt(q.field("expires_at"), now))
      .collect();
    for (const s of expiredSessions) await ctx.db.delete(s._id);
    return { tokens_deleted: expiredTokens.length, sessions_deleted: expiredSessions.length };
  },
});
