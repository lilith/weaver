// Pure-logic tests for the module-override primitives. No Convex, no
// network — just the helpers exported from @weaver/engine/flows.
//
// Covers:
//   - interpolateTemplate: happy path, missing placeholder, multiple markers
//   - validateOverride:   per-kind validation; bounds; declared placeholders
//   - mergeOverrides:     defaults fallback, unknown-key drop, bad-value drop
//   - makeOverrideAccessors: typed ctx.tune / ctx.template; loud failure on
//                            undeclared keys; template kind check

import { describe, expect, it } from "vitest";
import {
	interpolateTemplate,
	makeOverrideAccessors,
	mergeOverrides,
	validateOverride,
	type ModuleDef,
	type OverridableSlot,
} from "@weaver/engine/flows";

describe("interpolateTemplate", () => {
	it("substitutes declared placeholders", () => {
		expect(
			interpolateTemplate("{{a}} + {{b}} = {{c}}", { a: 1, b: 2, c: 3 }),
		).toBe("1 + 2 = 3");
	});

	it("leaves missing placeholders literally so the break is visible", () => {
		expect(interpolateTemplate("{{a}} + {{b}}", { a: 1 })).toBe("1 + {{b}}");
	});

	it("handles boolean and string values", () => {
		expect(interpolateTemplate("{{on}} / {{name}}", { on: true, name: "Mara" })).toBe(
			"true / Mara",
		);
	});

	it("supports whitespace inside markers", () => {
		expect(interpolateTemplate("{{ x }}", { x: 42 })).toBe("42");
	});

	it("ignores invalid identifiers (no substitution)", () => {
		expect(interpolateTemplate("{{2bad}}", { "2bad": "nope" })).toBe(
			"{{2bad}}",
		);
	});
});

describe("validateOverride", () => {
	it("accepts in-range numbers", () => {
		const slot: OverridableSlot = {
			kind: "number",
			default: 5,
			min: 1,
			max: 10,
			description: "",
		};
		expect(validateOverride(slot, 7)).toBeNull();
		expect(validateOverride(slot, 1)).toBeNull();
		expect(validateOverride(slot, 10)).toBeNull();
	});

	it("rejects out-of-range numbers", () => {
		const slot: OverridableSlot = {
			kind: "number",
			default: 5,
			min: 1,
			max: 10,
			description: "",
		};
		expect(validateOverride(slot, 0)).toMatch(/minimum/);
		expect(validateOverride(slot, 11)).toMatch(/maximum/);
		expect(validateOverride(slot, Infinity)).toMatch(/finite/);
		expect(validateOverride(slot, "7")).toMatch(/number/);
	});

	it("enforces max_len on strings", () => {
		const slot: OverridableSlot = {
			kind: "string",
			default: "hi",
			max_len: 4,
			description: "",
		};
		expect(validateOverride(slot, "hi")).toBeNull();
		expect(validateOverride(slot, "hello")).toMatch(/max_len/);
		expect(validateOverride(slot, 42)).toMatch(/string/);
	});

	it("accepts templates with declared placeholders only", () => {
		const slot: OverridableSlot = {
			kind: "template",
			default: "{{who}} waves",
			placeholders: ["who"],
			description: "",
		};
		expect(validateOverride(slot, "hello {{who}}")).toBeNull();
		expect(validateOverride(slot, "hi")).toBeNull();
		expect(validateOverride(slot, "{{mystery}}")).toMatch(/not declared/);
	});

	it("checks boolean types", () => {
		const slot: OverridableSlot = {
			kind: "boolean",
			default: false,
			description: "",
		};
		expect(validateOverride(slot, true)).toBeNull();
		expect(validateOverride(slot, "true")).toMatch(/boolean/);
	});
});

describe("mergeOverrides", () => {
	const slots: Record<string, OverridableSlot> = {
		hp: { kind: "number", default: 10, description: "" },
		line: {
			kind: "template",
			default: "{{who}} waves",
			placeholders: ["who"],
			description: "",
		},
		mode: { kind: "string", default: "cozy", description: "" },
	};

	it("returns defaults when no overrides", () => {
		expect(mergeOverrides(slots, undefined)).toEqual({
			hp: 10,
			line: "{{who}} waves",
			mode: "cozy",
		});
	});

	it("lets valid overrides win over defaults", () => {
		expect(mergeOverrides(slots, { hp: 20, mode: "spooky" })).toEqual({
			hp: 20,
			line: "{{who}} waves",
			mode: "spooky",
		});
	});

	it("ignores undeclared keys", () => {
		const out = mergeOverrides(slots, { hp: 20, xp: 999 });
		expect(out).toEqual({ hp: 20, line: "{{who}} waves", mode: "cozy" });
		expect(out).not.toHaveProperty("xp");
	});

	it("drops invalid values and falls back to default", () => {
		const slotsWithBounds: Record<string, OverridableSlot> = {
			hp: { kind: "number", default: 10, min: 1, max: 99, description: "" },
		};
		expect(mergeOverrides(slotsWithBounds, { hp: 500 })).toEqual({ hp: 10 });
		expect(mergeOverrides(slotsWithBounds, { hp: "nope" })).toEqual({ hp: 10 });
	});

	it("returns {} when no slots are declared", () => {
		expect(mergeOverrides(undefined, { anything: 1 })).toEqual({});
	});
});

describe("makeOverrideAccessors", () => {
	const mod: ModuleDef = {
		name: "testmod",
		schema_version: 1,
		steps: { open: { terminal: true } },
		overridable: {
			dc: { kind: "number", default: 5, min: 1, max: 10, description: "" },
			hit: {
				kind: "template",
				default: "{{who}} hits for {{n}}",
				placeholders: ["who", "n"],
				description: "",
			},
		},
	};

	it("tune returns merged value", () => {
		const { tune } = makeOverrideAccessors(mod, { dc: 8 });
		expect(tune<number>("dc")).toBe(8);
	});

	it("tune returns default when not overridden", () => {
		const { tune } = makeOverrideAccessors(mod, {});
		expect(tune<number>("dc")).toBe(5);
	});

	it("tune throws on undeclared key (loud typo failure)", () => {
		const { tune } = makeOverrideAccessors(mod, {});
		expect(() => tune("typo")).toThrow(/no such overridable slot/);
	});

	it("template interpolates declared placeholders", () => {
		const { template } = makeOverrideAccessors(mod, {});
		expect(template("hit", { who: "Mara", n: 3 })).toBe("Mara hits for 3");
	});

	it("template throws when used on non-template slot", () => {
		const { template } = makeOverrideAccessors(mod, {});
		expect(() => template("dc")).toThrow(/not "template"/);
	});

	it("invalid override value falls through to default (safe)", () => {
		const { tune } = makeOverrideAccessors(mod, { dc: 999 });
		// 999 > max=10 → validation fails → default used.
		expect(tune<number>("dc")).toBe(5);
	});
});
