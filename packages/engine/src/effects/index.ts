// Effect types + pure helpers. The actual DB-side dispatcher lives at
// convex/effects.ts — this file defines the grammar and the shape of
// the execution context.
//
// Effect kinds at Wave 2 (all flag-gated beyond the Wave 0 set):
//
//   Wave 0 (always available):
//     say          — append to scene narration
//     goto         — move character to target location
//     inc          — character.<path> += by (numeric)
//     set          — character.<path> = value (scalar)
//
//   Wave 2 (flag-gated):
//     give_item    — add item to character.inventory       (flag.item_taxonomy)
//     take_item    — remove item from inventory            (flag.item_taxonomy)
//     use_item     — consume a charge, fire on_use chain   (flag.item_taxonomy)
//     crack_orb    — fire on_crack then on_absorb chain    (flag.item_taxonomy)
//     narrate      — Sonnet-generated flavor prose         (flag.item_taxonomy)
//     damage       — alias: inc character.hp by -amount    (flag.biome_rules)
//     heal         — alias: inc character.hp by +amount    (—)
//     add_predicate — relation insert between entities     (—)
//     advance_time — delta_minutes past normal tick        (flag.world_clock)
//     emit         — append an event (flag.flows)
//     flow_start   — start a durable step-keyed flow       (flag.flows)
//     flow_send    — dispatch input to active flow         (flag.flows)
//     spawn_from_biome — roll a spawn table               (flag.biome_rules)

export type Effect =
  | { kind: "say"; text: string }
  | { kind: "goto"; target: string }
  | { kind: "inc"; path: string; by: number }
  | { kind: "set"; path: string; value: unknown }
  | { kind: "give_item"; slug: string; qty?: number; payload?: Record<string, unknown> }
  | { kind: "take_item"; slug: string; qty?: number }
  | { kind: "use_item"; slug: string }
  | { kind: "crack_orb"; slug: string }
  | {
      kind: "narrate";
      prompt: string;
      speaker?: string; // npc/character slug; used for <speaker_memory>
      salience?: "low" | "medium" | "high";
      memory_event_type?: string;
    }
  | { kind: "damage"; amount: number; damage_kind?: string }
  | { kind: "heal"; amount: number }
  | { kind: "add_predicate"; subject: string; predicate: string; object: string; payload?: unknown }
  | { kind: "advance_time"; delta_minutes: number }
  | { kind: "emit"; event_type: string; payload?: unknown }
  | { kind: "flow_start"; module: string; initial_state?: unknown }
  | { kind: "flow_send"; flow_id?: string; input: unknown }
  | { kind: "spawn_from_biome"; bucket: string; chance: number };

export type EffectKind = Effect["kind"];

export const ALL_EFFECT_KINDS: EffectKind[] = [
  "say",
  "goto",
  "inc",
  "set",
  "give_item",
  "take_item",
  "use_item",
  "crack_orb",
  "narrate",
  "damage",
  "heal",
  "add_predicate",
  "advance_time",
  "emit",
  "flow_start",
  "flow_send",
  "spawn_from_biome",
];

/** Quick type guard — does this object look like an Effect? */
export function isEffect(x: unknown): x is Effect {
  return (
    x != null &&
    typeof x === "object" &&
    typeof (x as any).kind === "string" &&
    ALL_EFFECT_KINDS.includes((x as any).kind)
  );
}

// ---------------------------------------------------------------
// Inventory shape (spec 22 Ask 2).
//
// Stored as `character.state.inventory` — a map keyed by slug. Each entry
// carries the core metadata an option condition might need to query
// (kind, qty, charges, color, size) without a full item-lookup roundtrip.
// The authoritative item payload lives in entities(type="item") and is
// loaded lazily when a use_item/crack_orb effect fires.
//
// Example shape:
//   inventory: {
//     "yellow-orb": { qty: 2, kind: "orb", color: "yellow", size: 1 },
//     "aspirin":    { qty: 5, kind: "consumable", charges: 5 },
//     "decoder-ring": { qty: 1, kind: "gear", slot: "hand" },
//   }

export type InventoryEntry = {
  qty: number;
  kind?: string;
  // Kind-specific hints, snapshotted on give_item for quick condition reads.
  color?: string;
  size?: number;
  slot?: string;
  charges?: number;
  [k: string]: unknown;
};

export type Inventory = Record<string, InventoryEntry>;

/** True when the character carries at least qty of slug. */
export function inventoryHas(inv: Inventory | undefined, slug: string, qty = 1): boolean {
  const e = inv?.[slug];
  return (e?.qty ?? 0) >= qty;
}

/** True when the character carries any item of the given kind. */
export function inventoryHasKind(inv: Inventory | undefined, kind: string): boolean {
  if (!inv) return false;
  return Object.values(inv).some((e) => e.kind === kind && (e.qty ?? 0) > 0);
}

/** Add a qty of slug to the inventory, creating the entry if missing.
 *  Pure — returns a new object. */
export function inventoryAdd(
  inv: Inventory | undefined,
  slug: string,
  qty: number,
  extra?: Partial<InventoryEntry>,
): Inventory {
  const next = { ...(inv ?? {}) };
  const cur = next[slug];
  if (cur) {
    next[slug] = { ...cur, ...extra, qty: (cur.qty ?? 0) + qty };
  } else {
    next[slug] = { qty, ...extra };
  }
  return next;
}

/** Remove up to qty of slug. Returns { inv, removed } where removed is
 *  the actual count removed (≤ qty; may be less if we didn't have enough). */
export function inventoryRemove(
  inv: Inventory | undefined,
  slug: string,
  qty: number,
): { inv: Inventory; removed: number } {
  const next = { ...(inv ?? {}) };
  const cur = next[slug];
  if (!cur || (cur.qty ?? 0) <= 0) return { inv: next, removed: 0 };
  const removed = Math.min(cur.qty, qty);
  const newQty = cur.qty - removed;
  if (newQty <= 0) delete next[slug];
  else next[slug] = { ...cur, qty: newQty };
  return { inv: next, removed };
}

/** Current qty of a slug (0 if absent). */
export function inventoryCount(inv: Inventory | undefined, slug: string): number {
  return inv?.[slug]?.qty ?? 0;
}

/** All distinct item slugs currently held. */
export function inventorySlugs(inv: Inventory | undefined): string[] {
  if (!inv) return [];
  return Object.keys(inv).filter((k) => (inv[k]?.qty ?? 0) > 0);
}
