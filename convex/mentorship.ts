// Mentorship log — append-only record of AI-assisted edits across the
// product. Each row captures the scope (which artifact was edited),
// the AI's suggestion, the human's final action (accept / modify /
// reject), and before/after snapshots. Used by future style-steering
// passes to learn what the author consistently overrides or keeps.
//
// Spec 08 Wave-1 MVP called for this; the table was defined months
// ago but nothing wrote to it. Writes land now via prompt-edit
// surfaces (applyBibleEdit + applyLocationEdit + art reference-board
// accepts) once each.

import type { Id } from "./_generated/dataModel.js";

export type MentorshipScope =
  | "bible.edit"
  | "location.edit"
  | "npc.edit"
  | "item.edit"
  | "art.reference_board_add"
  | "art.regen_requested"
  | `module.apply.${string}`
  | "code.issue.opened"
  | "stat_schema.apply"
  | "other";

export type MentorshipRow = {
  world_id: Id<"worlds">;
  user_id: Id<"users">;
  scope: MentorshipScope;
  context?: Record<string, unknown>;
  ai_suggestion?: Record<string, unknown>;
  human_action: Record<string, unknown>;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  note?: string;
};

/** Append a mentorship-log row. Silently skips if args are malformed —
 *  we never want a logging failure to block the user's actual edit. */
export async function appendMentorship(ctx: any, row: MentorshipRow): Promise<void> {
  try {
    await ctx.db.insert("mentorship_log", {
      world_id: row.world_id,
      user_id: row.user_id,
      scope: row.scope,
      context: row.context,
      ai_suggestion: row.ai_suggestion,
      human_action: row.human_action,
      before: row.before,
      after: row.after,
      note: row.note,
      created_at: Date.now(),
    });
  } catch {
    /* log-write best-effort; never block the caller */
  }
}
