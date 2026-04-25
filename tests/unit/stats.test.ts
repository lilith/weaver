// Pure-logic tests for @weaver/engine/stats. No Convex, no DB — just
// the resolver/formatter helpers and the buildStatTiles ordering.
//
// Covers:
//   - resolveStatDisplay: world overrides on top of engine defaults
//   - formatStatValue: each format mode + finite-number guard
//   - readStatePath: dotted path lookups + missing-segment safety
//   - buildStatTiles: hidden filtering, custom-stat sourcing, sort order

import { describe, expect, it } from "vitest";
import {
	CANONICAL_STATS,
	DEFAULT_STAT_DISPLAY,
	buildStatTiles,
	formatStatValue,
	readStatePath,
	resolveStatDisplay,
	type StatSchema,
} from "@weaver/engine/stats";

describe("resolveStatDisplay", () => {
	it("returns default when schema absent", () => {
		expect(resolveStatDisplay(CANONICAL_STATS.HP, undefined)).toEqual(
			DEFAULT_STAT_DISPLAY[CANONICAL_STATS.HP],
		);
	});

	it("merges world override on top of default", () => {
		const schema: StatSchema = {
			canonical: { hp: { label: "wellbeing", format: "fraction", max: 10 } },
		};
		const out = resolveStatDisplay(CANONICAL_STATS.HP, schema);
		expect(out.label).toBe("wellbeing");
		expect(out.format).toBe("fraction");
		expect(out.max).toBe(10);
		// Color from default still wins when override doesn't set it.
		expect(out.color).toBe(DEFAULT_STAT_DISPLAY[CANONICAL_STATS.HP].color);
	});

	it("hidden flag carries through", () => {
		const schema: StatSchema = { canonical: { hp: { hidden: true } } };
		expect(resolveStatDisplay(CANONICAL_STATS.HP, schema).hidden).toBe(true);
	});
});

describe("formatStatValue", () => {
	it("renders raw values by default", () => {
		expect(formatStatValue(7, {})).toBe("7");
	});
	it("returns em-dash for missing/non-numeric", () => {
		expect(formatStatValue(undefined, {})).toBe("—");
		expect(formatStatValue(null, {})).toBe("—");
		expect(formatStatValue(NaN, {})).toBe("—");
		expect(formatStatValue(Infinity, {})).toBe("—");
	});
	it("formats fraction when max is set", () => {
		expect(formatStatValue(7, { format: "fraction", max: 10 })).toBe("7/10");
	});
	it("falls through to raw when fraction lacks max", () => {
		expect(formatStatValue(7, { format: "fraction" })).toBe("7");
	});
	it("renders tally pips clamped to max", () => {
		expect(formatStatValue(3, { format: "tally", max: 5 })).toBe("●●●");
		expect(formatStatValue(99, { format: "tally", max: 3 })).toBe("●●●");
	});
});

describe("readStatePath", () => {
	const state = {
		hp: 8,
		nested: { level: 3, deep: { mood: "wistful" } },
	};
	it("reads top-level keys", () => {
		expect(readStatePath(state, "hp")).toBe(8);
	});
	it("reads nested paths", () => {
		expect(readStatePath(state, "nested.level")).toBe(3);
		expect(readStatePath(state, "nested.deep.mood")).toBe("wistful");
	});
	it("returns undefined on missing segments", () => {
		expect(readStatePath(state, "missing.path")).toBeUndefined();
		expect(readStatePath(undefined, "hp")).toBeUndefined();
	});
});

describe("buildStatTiles", () => {
	it("renders canonical numeric stats only when present", () => {
		const tiles = buildStatTiles({ hp: 7, gold: 3 }, undefined);
		expect(tiles.map((t) => t.key)).toEqual(["hp", "gold"]);
		expect(tiles[0].value).toBe(7);
	});

	it("hides stats marked hidden in schema", () => {
		const schema: StatSchema = { canonical: { gold: { hidden: true } } };
		const tiles = buildStatTiles({ hp: 7, gold: 3, energy: 5 }, schema);
		expect(tiles.map((t) => t.key)).toEqual(["hp", "energy"]);
	});

	it("includes custom stats sourced from arbitrary paths", () => {
		const schema: StatSchema = {
			custom: [
				{
					key: "cat_bond",
					source: "relationships.cat",
					label: "cat",
					order: 5,
				},
			],
		};
		const state = { hp: 7, relationships: { cat: 3 } };
		const tiles = buildStatTiles(state, schema);
		expect(tiles.map((t) => t.key)).toEqual(["cat_bond", "hp"]);
		// custom appears first because order=5 < hp default order=10
		const custom = tiles[0];
		expect(custom.kind).toBe("custom");
		expect(custom.value).toBe(3);
	});

	it("sorts by order, then by stable canonical sequence", () => {
		const schema: StatSchema = {
			canonical: { gold: { order: 1 }, hp: { order: 2 } },
		};
		const tiles = buildStatTiles({ hp: 7, gold: 3, energy: 5 }, schema);
		expect(tiles.map((t) => t.key)).toEqual(["gold", "hp", "energy"]);
	});

	it("skips custom stats whose source is missing", () => {
		const schema: StatSchema = {
			custom: [{ key: "ghost", source: "missing.path", label: "ghost" }],
		};
		const tiles = buildStatTiles({ hp: 1 }, schema);
		expect(tiles.map((t) => t.key)).toEqual(["hp"]);
	});
});
