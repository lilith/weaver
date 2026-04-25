// Canonical stats — the engine's frozen vocabulary.
//
// Modules (combat, dialogue, effects, expressions) read and write
// these keys directly: `character.state.hp`, `character.state.gold`,
// `character.state.energy`, `character.state.inventory`. The keys are
// constants in the engine. New modules introduce new canonical keys
// (e.g. a future spellcasting module would add `mana`); the engine
// migrates on add.
//
// Per-world *display* (label, icon, format, hide/show) lives entirely
// in `worlds.stat_schema` — the renderer relabels at present time
// without ever touching storage. This keeps modules world-agnostic and
// keeps localization a UI concern, not a runtime one.
//
// The split (per spec/STAT_SCHEMA.md):
//   - canonical key  =  storage path; stable across worlds; engine-known
//   - StatDisplay     =  per-world overlay; how a key is shown
//   - custom stats    =  display-only stats backed by arbitrary state.* paths;
//                        engine never writes them
//
// What does NOT belong here:
//   - module tunables (those are `flag.module_overrides` slots)
//   - structural/game-rule changes (those are code proposals)
//   - per-character mutations of state (still done via game effects)

/** Canonical keys the engine knows about. Modules import these
 *  constants instead of bare strings, so a refactor is one symbol
 *  rename rather than a regex grep. */
export const CANONICAL_STATS = {
	HP: "hp",
	GOLD: "gold",
	ENERGY: "energy",
	INVENTORY: "inventory",
} as const;

export type CanonicalStatKey = (typeof CANONICAL_STATS)[keyof typeof CANONICAL_STATS];

/** Numeric scalar canonical keys — a useful type for "any HP/gold/energy". */
export const CANONICAL_NUMERIC_STATS: readonly CanonicalStatKey[] = [
	CANONICAL_STATS.HP,
	CANONICAL_STATS.GOLD,
	CANONICAL_STATS.ENERGY,
] as const;

// --------------------------------------------------------------------
// Per-world display schema

/** Per-key display config. Pure presentation — never read by modules. */
export type StatDisplay = {
	/** Label rendered in the inventory panel. Defaults to the canonical
	 *  key uppercased ("HP", "GOLD", "ENERGY"). */
	label?: string;
	/** Single-glyph icon shown before the label. Optional. */
	icon?: string;
	/** Color hint — a CSS color or token name like "candle-300". */
	color?: string;
	/** Render style. "bar" needs `max`; "value" shows the number;
	 *  "fraction" shows N/M when max is set; "tally" shows pips. */
	format?: "value" | "fraction" | "bar" | "tally";
	/** Cap for bar/fraction rendering. Engine doesn't enforce; this is
	 *  a presentation hint only. */
	max?: number;
	/** Hide this stat from the panel even when non-zero. The value still
	 *  exists in storage and is still mutable by game effects. */
	hidden?: boolean;
	/** Sort priority. Lower = earlier. Defaults vary by key. */
	order?: number;
};

/** A display-only custom stat. Backed by an arbitrary state.* path; the
 *  engine never writes to it. Useful for surfacing a relationship
 *  count, a streak, an authored counter, etc. */
export type CustomStat = {
	/** Stable id for ordering / dedup. */
	key: string;
	/** Dotted path under `character.state` to read the value from. */
	source: string;
	label: string;
	icon?: string;
	color?: string;
	format?: StatDisplay["format"];
	max?: number;
	hidden?: boolean;
	order?: number;
};

/** Per-world schema. Stored at `worlds.stat_schema` (optional). The
 *  absence of a schema is treated as "use defaults". */
export type StatSchema = {
	/** Per-canonical-key overrides. */
	canonical?: Partial<Record<CanonicalStatKey, StatDisplay>>;
	/** Display-only custom stats. */
	custom?: CustomStat[];
	/** Per-kind item display overlay. Inventory chips render with this
	 *  applied when the kind matches. Same hidden + label + color rules. */
	item_kinds?: Record<
		string,
		{ label?: string; icon?: string; color?: string; hidden?: boolean }
	>;
	/** Default heading shown above the inventory chips. */
	inventory_label?: string;
	/** "Preset" hint — purely a UX label so the admin UI knows which
	 *  preset card was last applied. Ignored at runtime. */
	preset?: "litrpg" | "standard-fantasy" | "cozy" | "custom";
};

// --------------------------------------------------------------------
// Defaults + resolution

/** Out-of-the-box display for canonical keys. Worlds that don't set a
 *  stat_schema use these directly; world overrides merge on top. */
export const DEFAULT_STAT_DISPLAY: Record<CanonicalStatKey, StatDisplay> = {
	[CANONICAL_STATS.HP]: { label: "hp", color: "rose-400", order: 10 },
	[CANONICAL_STATS.GOLD]: { label: "gold", color: "candle-300", order: 20 },
	[CANONICAL_STATS.ENERGY]: { label: "energy", color: "teal-400", order: 30 },
	[CANONICAL_STATS.INVENTORY]: { label: "inventory", order: 100 },
};

/** Resolve the effective display for a canonical key, merging the
 *  world override on top of the engine default. Hidden stays falsy
 *  unless the schema explicitly hides it. */
export function resolveStatDisplay(
	key: CanonicalStatKey,
	schema: StatSchema | undefined,
): StatDisplay {
	const base = DEFAULT_STAT_DISPLAY[key] ?? { label: key };
	const override = schema?.canonical?.[key];
	if (!override) return base;
	return { ...base, ...override };
}

/** Format a numeric value according to a display config. Returns just
 *  the value-portion (no label) so the caller can compose with their
 *  own label/icon styling. */
export function formatStatValue(
	value: number | undefined | null,
	display: StatDisplay,
): string {
	if (typeof value !== "number" || !Number.isFinite(value)) return "—";
	switch (display.format ?? "value") {
		case "value":
			return String(value);
		case "fraction":
			return display.max != null ? `${value}/${display.max}` : String(value);
		case "bar":
			// Caller renders the bar; we just return the numeric for a11y text.
			return display.max != null ? `${value}/${display.max}` : String(value);
		case "tally": {
			const n = Math.max(0, Math.min(value, display.max ?? value));
			return "●".repeat(Math.round(n));
		}
		default:
			return String(value);
	}
}

/** Walk a dotted path on a state object — `"foo.bar.baz"` →
 *  `state.foo.bar.baz`. Used by custom stats that point at arbitrary
 *  state subtrees. Returns undefined on any miss. */
export function readStatePath(
	state: Record<string, unknown> | undefined,
	path: string,
): unknown {
	if (!state) return undefined;
	const parts = path.split(".").filter((p) => p.length > 0);
	let cur: unknown = state;
	for (const p of parts) {
		if (cur == null || typeof cur !== "object") return undefined;
		cur = (cur as Record<string, unknown>)[p];
	}
	return cur;
}

/** Build the ordered list of stat tiles to render — canonical first,
 *  then custom, sorted by `order` (defaulting to insertion order). The
 *  caller still renders; this is just the "what to show, in what
 *  order" decision concentrated in one place so the same logic powers
 *  the play page, the admin preview, and any future export. */
export type StatTile =
	| {
			kind: "canonical";
			key: CanonicalStatKey;
			display: StatDisplay;
			value: unknown;
	  }
	| {
			kind: "custom";
			key: string;
			display: StatDisplay;
			value: unknown;
	  };

export function buildStatTiles(
	state: Record<string, unknown> | undefined,
	schema: StatSchema | undefined,
	opts: { include_inventory?: boolean } = {},
): StatTile[] {
	const tiles: StatTile[] = [];
	for (const key of CANONICAL_NUMERIC_STATS) {
		const display = resolveStatDisplay(key, schema);
		if (display.hidden) continue;
		const value = state?.[key];
		// Only render numeric canonical stats when there's a number to show
		// — keeps the cozy default tidy.
		if (typeof value !== "number" || !Number.isFinite(value)) continue;
		tiles.push({ kind: "canonical", key, display, value });
	}
	for (const c of schema?.custom ?? []) {
		if (c.hidden) continue;
		const value = readStatePath(state, c.source);
		if (value == null) continue;
		tiles.push({
			kind: "custom",
			key: c.key,
			display: {
				label: c.label,
				icon: c.icon,
				color: c.color,
				format: c.format,
				max: c.max,
				order: c.order,
			},
			value,
		});
	}
	tiles.sort(
		(a, b) => (a.display.order ?? 1000) - (b.display.order ?? 1000),
	);
	return tiles;
}
