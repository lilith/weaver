// World-creation presets — shared client/server. Each preset names a
// set of flags to enable at world scope. Flags not in the preset fall
// through to REGISTRY_DEFAULTS (which is where the foundational
// always-on flags like flag.expansion, flag.journeys, flag.world_clock
// live; those don't need per-world overrides).
//
// Keep these lists small and purposeful — every flag here shows up in
// the "customize" disclosure as a checkbox, so churn is expensive.

export type PresetId = "cozy-narrative" | "balanced" | "grim-litrpg";

export type PresetDef = {
	id: PresetId;
	name: string;
	tagline: string;
	blurb: string;
	/** Explicit flag-on list. World-scoped flag.set(enabled=true). */
	flags: string[];
	/** Explicit flag-off list. Used when a flag's registry default is ON
	 *  but this preset wants it OFF for its world. World-scoped flag.set(enabled=false). */
	flags_off?: string[];
	suggested_style_tag: string | null;
};

export const PRESETS: PresetDef[] = [
	{
		id: "cozy-narrative",
		name: "Cozy narrative",
		tagline: "Soft stakes, rich prose, no combat.",
		blurb:
			"Biome moods, streaming prose, predictive prefetch, NPC memory. Characters don't fight; they talk, listen, notice. No HP or gold. For readers and bedtime storytellers.",
		flags: [
			"flag.biome_rules",
			"flag.expansion_streaming",
			"flag.text_prefetch",
			"flag.art_curation",
			"flag.npc_memory",
			"flag.graph_map",
		],
		flags_off: ["flag.litrpg_stats"],
		suggested_style_tag: "cozy-watercolor-pixel",
	},
	{
		id: "balanced",
		name: "Balanced",
		tagline: "Talk, trade, gather, wander. Small mechanics.",
		blurb:
			"Everything in Cozy plus an item taxonomy (orbs, keys, food), authored dialogue flows, and light structured play. No forced combat.",
		flags: [
			"flag.biome_rules",
			"flag.expansion_streaming",
			"flag.text_prefetch",
			"flag.art_curation",
			"flag.npc_memory",
			"flag.graph_map",
			"flag.item_taxonomy",
			"flag.module_dialogue",
			"flag.flows",
		],
		suggested_style_tag: "cozy-watercolor-pixel",
	},
	{
		id: "grim-litrpg",
		name: "Grim LitRPG",
		tagline: "HP, combat, eras, sharper mechanics.",
		blurb:
			"All of Balanced plus combat, era advancement, and the effect-router v2. Death, stakes, stat rows. For players who want the gameplay to bite back.",
		flags: [
			"flag.biome_rules",
			"flag.expansion_streaming",
			"flag.text_prefetch",
			"flag.art_curation",
			"flag.npc_memory",
			"flag.graph_map",
			"flag.item_taxonomy",
			"flag.module_dialogue",
			"flag.flows",
			"flag.module_combat",
			"flag.eras",
			"flag.effect_router_v2",
		],
		suggested_style_tag: "grim-corporate-pixel",
	},
];

/** The full set of flags that appear as checkboxes in the "customize"
 *  disclosure. Union of every preset, stable order. Foundational flags
 *  (expansion, journeys, world_clock, import_cli) are omitted — they're
 *  already default-on and users shouldn't disable them per-world. */
export const CUSTOMIZABLE_FLAGS: Array<{ key: string; label: string; hint: string }> = [
	{ key: "flag.biome_rules", label: "Biome rules", hint: "time dilation, on_enter/leave hooks, spawn tables" },
	{ key: "flag.expansion_streaming", label: "Expansion streaming", hint: "prose streams token-by-token from Opus" },
	{ key: "flag.text_prefetch", label: "Predictive prefetch", hint: "pre-warm expansions on unresolved options" },
	{ key: "flag.art_curation", label: "Art curation", hint: "wardrobe of modes + per-entity renderings" },
	{ key: "flag.npc_memory", label: "NPC memory", hint: "NPCs remember what you told them and when" },
	{ key: "flag.graph_map", label: "Graph map", hint: "force-directed world map (instead of grid)" },
	{ key: "flag.item_taxonomy", label: "Item taxonomy", hint: "kind-tagged items, orbs, crackable things" },
	{ key: "flag.module_dialogue", label: "Dialogue flows", hint: "structured NPC conversations with branches" },
	{ key: "flag.flows", label: "Flow runtime", hint: "step-keyed state machines for multi-turn beats" },
	{ key: "flag.module_combat", label: "Combat", hint: "HP, attacks, enemies — opt-in, never auto-triggered" },
	{ key: "flag.eras", label: "Eras", hint: "per-entity × per-era state; world can advance in time" },
	{ key: "flag.effect_router_v2", label: "Effect router v2", hint: "central dispatcher for give/take/use/narrate" },
	{ key: "flag.litrpg_stats", label: "LitRPG stats", hint: "show HP / gold / energy numbers on the inventory panel" },
];

/** Style-tag options for the pixel tile library binding. None = the
 *  graph/map view falls back to biome palette swatches only. */
export const STYLE_TAGS: Array<{ id: string | null; name: string; blurb: string }> = [
	{ id: null, name: "No pixel art", blurb: "Palette swatches only. Fast, minimal." },
	{
		id: "cozy-watercolor-pixel",
		name: "Cozy watercolor",
		blurb: "Warm, painterly, hopeful. Villages, forests, taverns.",
	},
	{
		id: "grim-corporate-pixel",
		name: "Grim corporate",
		blurb: "Sickly fluorescent, worn, 90s office dread. Cubicles, server rooms.",
	},
];

export function presetById(id: string | null | undefined): PresetDef | null {
	if (!id) return null;
	return PRESETS.find((p) => p.id === id) ?? null;
}
