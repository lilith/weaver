// Smoke tests for each shipped module: slots are declared for every
// key referenced by step handlers; defaults pass their own validators;
// templates render with the expected placeholders.

import { describe, expect, it } from "vitest";
import {
	validateOverride,
	makeOverrideAccessors,
	type ModuleDef,
	type OverridableSlot,
} from "@weaver/engine/flows";
import { counterModule } from "../../convex/modules/counter.js";
import { dialogueModule } from "../../convex/modules/dialogue.js";
import { combatModule } from "../../convex/modules/combat.js";

const ALL: ModuleDef[] = [counterModule, dialogueModule, combatModule];

describe.each(ALL.map((m) => [m.name, m] as const))(
	"module %s",
	(_name, mod) => {
		it("has at least one declared overridable slot", () => {
			expect(Object.keys(mod.overridable ?? {}).length).toBeGreaterThan(0);
		});

		it("every slot's default passes validateOverride", () => {
			for (const [key, slot] of Object.entries(mod.overridable ?? {})) {
				const err = validateOverride(slot, slot.default);
				expect(err, `${mod.name}.${key}: ${err}`).toBeNull();
			}
		});

		it("every declared slot has a non-empty description", () => {
			for (const [key, slot] of Object.entries(mod.overridable ?? {})) {
				expect(
					(slot.description ?? "").length,
					`${mod.name}.${key} missing description`,
				).toBeGreaterThan(0);
			}
		});

		it("tune returns slot defaults through a fresh accessor", () => {
			const { tune } = makeOverrideAccessors(mod, {});
			for (const [key, slot] of Object.entries(mod.overridable ?? {})) {
				expect(tune(key)).toEqual(slot.default);
			}
		});
	},
);

describe("combat opening line interpolates", () => {
	it("renders with player + enemy", () => {
		const { template } = makeOverrideAccessors(combatModule, {});
		expect(template("opening_line", { player: "Mara", enemy: "Goblin" })).toBe(
			"Combat begins. Mara faces Goblin.",
		);
	});

	it("applies a world override when provided", () => {
		const { template } = makeOverrideAccessors(combatModule, {
			opening_line: "⚔ {{player}} vs {{enemy}}.",
		});
		expect(template("opening_line", { player: "Mara", enemy: "Goblin" })).toBe(
			"⚔ Mara vs Goblin.",
		);
	});
});

describe("counter tick_label interpolates", () => {
	it("renders with n + target", () => {
		const { template } = makeOverrideAccessors(counterModule, {});
		expect(template("tick_label", { n: 3, target: 5 })).toBe("Count: 3/5");
	});
});

describe("dialogue greet_prompt interpolates", () => {
	it("renders with speaker + player", () => {
		const { template } = makeOverrideAccessors(dialogueModule, {});
		const out = template("greet_prompt", { speaker: "Mara", player: "Gen" });
		expect(out).toContain("Mara");
		expect(out).toContain("Gen");
	});

	it("rejects templates with undeclared placeholders at apply time", () => {
		const slot = dialogueModule.overridable!.greet_prompt as OverridableSlot;
		const err = validateOverride(slot, "Hey {{mystery}}");
		expect(err).toMatch(/not declared/);
	});
});
