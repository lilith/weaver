// Feature flag runtime.
//
// Resolution order (per FEATURE_REGISTRY.md §"Resolution order"):
//   1. character-scoped override
//   2. user-scoped override
//   3. world-scoped override
//   4. global override
//   5. registry default
//
// Every level can override the level above. Default state for a new flag
// is off unless the registry marks it `shipped` (in which case default is on).
//
// One seam per user-visible interaction: call `isFeatureEnabled` once per
// code path. See FEATURE_REGISTRY.md §"Seam discipline rule."

export type FlagScopeKind = "character" | "user" | "world" | "global";

export type FlagScope = {
	world_id?: string;
	user_id?: string;
	character_id?: string;
};

/** Authoritative default state per flag. Source of truth — if a flag is not
 *  in this map its default is `off`. Mirrors FEATURE_REGISTRY.md table. */
export const REGISTRY_DEFAULTS: Record<string, boolean> = {
	// Foundational — always on; flags exist only as kill-switches.
	"flag.expansion": true,
	"flag.journeys": true,
	"flag.world_clock": true,
	"flag.import_cli": true,

	// Wave 2+ — default off; flip on per-world at playtest.
	"flag.flows": false,
	"flag.expression_grammar_v2": false,
	"flag.effect_router_v2": false,
	"flag.biome_rules": false,
	"flag.item_taxonomy": false,
	"flag.npc_memory": false,
	"flag.art_curation": false,
	"flag.expansion_streaming": false,
	"flag.text_prefetch": false,
	"flag.campaign_events": false,
	"flag.eras": false,
	"flag.chat": false,
	"flag.theme_gen": false,
	"flag.biome_palette_gen": false,
	"flag.module_dialogue": false,
	"flag.module_combat": false,
};

/** A feature_flags row shape. Matches the Convex schema at
 *  convex/schema.ts `feature_flags`. */
export type FeatureFlagRow = {
	flag_key: string;
	scope_kind: FlagScopeKind;
	scope_id?: string; // absent for global
	enabled: boolean;
};

/** Pure resolution: given the set of rows that possibly match this flag
 *  and scope, pick the most specific one. Exposed separately so callers
 *  can test the logic without a DB. */
export function resolveFlag(
	flag_key: string,
	rows: FeatureFlagRow[],
	scope: FlagScope,
): boolean {
	const matching = rows.filter((r) => r.flag_key === flag_key);
	// Most specific first.
	if (scope.character_id) {
		const hit = matching.find(
			(r) => r.scope_kind === "character" && r.scope_id === scope.character_id,
		);
		if (hit) return hit.enabled;
	}
	if (scope.user_id) {
		const hit = matching.find(
			(r) => r.scope_kind === "user" && r.scope_id === scope.user_id,
		);
		if (hit) return hit.enabled;
	}
	if (scope.world_id) {
		const hit = matching.find(
			(r) => r.scope_kind === "world" && r.scope_id === scope.world_id,
		);
		if (hit) return hit.enabled;
	}
	const global = matching.find((r) => r.scope_kind === "global");
	if (global) return global.enabled;
	return REGISTRY_DEFAULTS[flag_key] ?? false;
}

/** The list of scope candidates to query for a given scope. Useful for
 *  batching the DB query — queries just the 4 relevant rows. */
export function scopeCandidates(
	scope: FlagScope,
): Array<{ scope_kind: FlagScopeKind; scope_id?: string }> {
	const out: Array<{ scope_kind: FlagScopeKind; scope_id?: string }> = [];
	if (scope.character_id) out.push({ scope_kind: "character", scope_id: scope.character_id });
	if (scope.user_id) out.push({ scope_kind: "user", scope_id: scope.user_id });
	if (scope.world_id) out.push({ scope_kind: "world", scope_id: scope.world_id });
	out.push({ scope_kind: "global" });
	return out;
}
