// Eras v2 helpers (spec 25). The era world-index:
//
//   currentEraFor(world, character?)
//     returns the era that should filter what the caller sees:
//       character.personal_era when it lags world.active_era
//       world.active_era otherwise
//     Null character ⇒ world.active_era.
//
//   stampEraOnCreate(ctx, world_id)
//     resolves world.active_era at write time — new entities +
//     artifact_versions stamp this so later era filtering works.
//
//   getEntityAtEra(ctx, entity, era)
//     picks the authored artifact_version with the highest era <=
//     target. Falls back to entity.current_version when no era-
//     stamped versions exist (pre-v2 content).
//
//   isVisibleAtEra(entity, era)
//     true when entity.era_first_established <= era (or absent, which
//     treats the entity as era-1 canonical).

import type { Doc, Id } from "./_generated/dataModel.js";
import { readJSONBlob } from "./blobs.js";

export async function currentEraFor(
  ctx: any,
  world_id: Id<"worlds">,
  character_id?: Id<"characters">,
): Promise<number> {
  const world = (await ctx.db.get(world_id)) as Doc<"worlds"> | null;
  const active = world?.active_era ?? 1;
  if (!character_id) return active;
  const c = (await ctx.db.get(character_id)) as Doc<"characters"> | null;
  const personal = (c as any)?.personal_era ?? active;
  // Character view lags the world until they acknowledge the catch-up —
  // if personal < active they see the world as-of personal_era.
  return Math.min(active, Math.max(1, Number(personal)));
}

export async function stampEraOnCreate(
  ctx: any,
  world_id: Id<"worlds">,
): Promise<number> {
  const world = (await ctx.db.get(world_id)) as Doc<"worlds"> | null;
  return world?.active_era ?? 1;
}

export function isVisibleAtEra(
  entity: Doc<"entities"> | null | undefined,
  era: number,
): boolean {
  if (!entity) return false;
  const est = (entity as any).era_first_established;
  if (est == null) return true; // pre-v2 entities unconstrained
  return Number(est) <= era;
}

/** Return the authored payload for an entity AS OF a target era. Picks
 *  the artifact_version with the highest era <= target; falls back to
 *  current_version when no era-stamped versions exist. */
export async function getEntityAtEra<T = Record<string, unknown>>(
  ctx: any,
  entity: Doc<"entities">,
  era: number,
): Promise<T | null> {
  // Fast path: look up all versions of this entity, pick the best.
  const all = await ctx.db
    .query("artifact_versions")
    .withIndex("by_artifact_version", (q: any) =>
      q.eq("artifact_entity_id", entity._id),
    )
    .collect();
  if (all.length === 0) return null;
  // Prefer era-stamped versions with era <= target, highest era wins;
  // then highest version. Fall back to the latest unstamped version.
  const eligibleStamped = all
    .filter((v: any) => typeof v.era === "number" && v.era <= era)
    .sort((a: any, b: any) => b.era - a.era || b.version - a.version);
  const pick =
    eligibleStamped[0] ??
    all
      .slice()
      .sort((a: any, b: any) => b.version - a.version)[0];
  if (!pick) return null;
  try {
    return (await readJSONBlob<T>(ctx, pick.blob_hash)) as T;
  } catch {
    return null;
  }
}
