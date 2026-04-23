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
	// Module & code proposals — spec/MODULE_AND_CODE_PROPOSALS.md. Admin
	// UIs at /admin/modules/<slug> and /admin/code/<slug> refuse
	// suggest+apply unless the respective flag is on for the world.
	// Runtime override lookup in flows.ts also gates on
	// flag.module_overrides — when off, modules run against declared
	// defaults only (no per-step DB read).
	"flag.module_overrides": false,
	"flag.code_proposals": false,
	"flag.graph_map": false,
	// Stat-row visibility on the inventory panel. Default on for
	// back-compat (pre-flag worlds); cozy-narrative explicitly off.
	"flag.litrpg_stats": true,
};

/** Flags the world owner can legitimately toggle from the admin UI.
 *  Grouped for rendering. Foundational flags (flag.expansion,
 *  flag.journeys, flag.world_clock) are omitted on purpose — they're
 *  kill-switches only and flipping them off breaks the core loop. The
 *  admin settings page renders whatever's in this map; add an entry
 *  to ship a flag to family self-service. */
export type OwnerFlippableFlag = {
	key: string;
	label: string;
	description: string;
	group: "game" | "ai" | "admin" | "ui";
	// When on, what breaks / what needs setup. Surfaced as a small
	// caveat under the toggle — not a hard block.
	caveat?: string;
};

export const OWNER_FLIPPABLE_FLAGS: OwnerFlippableFlag[] = [
	// Game modules + mechanics
	{
		key: "flag.flows",
		label: "Step-keyed flow runtime",
		description:
			"Turn on to let modules (combat, dialogue) actually run. Core of every module-based feature.",
		group: "game",
	},
	{
		key: "flag.biome_rules",
		label: "Biome rules",
		description:
			"Per-biome time dilation, on-enter hooks, ambient spawn tables.",
		group: "game",
	},
	{
		key: "flag.item_taxonomy",
		label: "Item taxonomy + effects",
		description:
			"Structured inventory, kind-discriminated items (consumables, tools, orbs), give/take/use/crack effects.",
		group: "game",
	},
	{
		key: "flag.eras",
		label: "Eras + chronicles",
		description:
			"Active-era counter, Opus-written chronicle on advance, per-character catch-up panel.",
		group: "game",
	},
	{
		key: "flag.litrpg_stats",
		label: "Stat row on inventory panel",
		description:
			"Numeric HP / stamina / etc. Default on for back-compat; flip off for cozy-narrative worlds.",
		group: "ui",
	},

	// AI-assisted surfaces
	{
		key: "flag.npc_memory",
		label: "NPC memory",
		description:
			"NPCs remember prior dialogue with each player; auto-injected into narrative prompts.",
		group: "ai",
	},
	{
		key: "flag.art_curation",
		label: "Art curation (wardrobe)",
		description:
			"Eye-icon reveal, mode picker, reference-board-driven regens. Needs fal.ai key + R2.",
		group: "ai",
		caveat: "Uses fal.ai credits per regen.",
	},
	{
		key: "flag.biome_palette_gen",
		label: "Biome palette auto-gen",
		description:
			"Opus generates per-biome color palettes from the world bible.",
		group: "ai",
		caveat: "One Opus call per biome on first gen.",
	},
	{
		key: "flag.expansion_streaming",
		label: "Streaming expansion prose",
		description:
			"Live prose chunks as Opus writes new locations — feels alive instead of load-then-jump.",
		group: "ai",
		caveat: "Requires streaming-capable client.",
	},
	{
		key: "flag.text_prefetch",
		label: "Text prefetch",
		description:
			"Speculatively expand unresolved options so a click lands instantly.",
		group: "ai",
		caveat: "Uses extra Opus tokens on never-clicked options.",
	},

	// Admin / authoring
	{
		key: "flag.module_overrides",
		label: "Module overrides (admin)",
		description:
			"Enables the /admin/modules surface — propose tuning changes to flow modules without a deploy.",
		group: "admin",
		caveat: "Uses Opus tokens per suggestion.",
	},
	{
		key: "flag.code_proposals",
		label: "Code proposals (admin)",
		description:
			"Enables the /admin/code surface — draft a plan, open a GitHub issue.",
		group: "admin",
		caveat: "Needs GITHUB_REPO_PAT in Convex env before `open issue` works.",
	},
];

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
