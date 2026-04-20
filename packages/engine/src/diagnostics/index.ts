// Runtime diagnostics — pure invariant checkers + sanitizers.
//
// These run on the hot path (every applyOption persist) so they have
// to be cheap. No Zod; inline validation. When a violation is found:
//   1. the sanitizer returns a healed copy with the violation fixed,
//   2. the list of `fixes` is returned alongside so the caller can
//      log it to the runtime_bugs table + surface via `weaver bugs`.
//
// Principle: never crash the player. Corrupted state is fixed in
// place, bug is logged, gameplay continues.

export type RuntimeBug = {
	code: string; // short machine-readable code; groups bugs for rate-limit
	severity: "info" | "warn" | "error";
	message: string; // human-readable
	context?: Record<string, unknown>;
};

// ---------------------------------------------------------------
// Character state — the hottest invariant surface.

export type CharacterSanitize = {
	state: Record<string, unknown>;
	fixes: RuntimeBug[];
};

export function sanitizeCharacterState(
	state: unknown,
): CharacterSanitize {
	const fixes: RuntimeBug[] = [];
	const safe: Record<string, unknown> =
		state && typeof state === "object" && !Array.isArray(state)
			? { ...(state as Record<string, unknown>) }
			: (fixes.push({
					code: "char.state.not_object",
					severity: "warn",
					message: "character.state was not an object; reset to defaults",
					context: { got: typeof state },
				}),
				{});

	// Numeric stats: if present, must be finite.
	for (const k of ["hp", "gold", "energy"]) {
		const v = safe[k];
		if (v === undefined) continue; // absent is fine
		if (typeof v !== "number" || !Number.isFinite(v)) {
			fixes.push({
				code: `char.state.${k}.not_finite`,
				severity: "warn",
				message: `character.state.${k} was not a finite number; coerced to 0`,
				context: { got: v },
			});
			safe[k] = 0;
		}
	}

	// Inventory: must be object-map (Wave 2) OR array (legacy). Anything
	// else resets to {}.
	const inv = safe.inventory;
	if (inv !== undefined) {
		if (typeof inv === "string") {
			fixes.push({
				code: "char.state.inventory.string",
				severity: "error",
				message: "inventory was a string; reset to {}",
				context: { got: inv },
			});
			safe.inventory = {};
		} else if (typeof inv === "object" && inv !== null && !Array.isArray(inv)) {
			// Check each entry.
			const healed: Record<string, unknown> = {};
			for (const [slug, entry] of Object.entries(inv as Record<string, unknown>)) {
				if (!slug || slug === "undefined") {
					fixes.push({
						code: "char.state.inventory.bad_slug",
						severity: "error",
						message: `inventory had invalid slug "${slug}"; dropped`,
						context: { slug, entry },
					});
					continue;
				}
				if (!entry || typeof entry !== "object") {
					fixes.push({
						code: "char.state.inventory.bad_entry",
						severity: "warn",
						message: `inventory[${slug}] was not an object; dropped`,
						context: { slug, entry },
					});
					continue;
				}
				const e = entry as Record<string, unknown>;
				const qty = e.qty;
				if (typeof qty !== "number" || !Number.isFinite(qty) || qty < 0) {
					// A NaN/missing qty: treat as 1 and keep.
					fixes.push({
						code: "char.state.inventory.bad_qty",
						severity: "warn",
						message: `inventory[${slug}].qty was invalid; set to 1`,
						context: { slug, got: qty },
					});
					healed[slug] = { ...e, qty: 1 };
				} else {
					healed[slug] = e;
				}
			}
			safe.inventory = healed;
		} else if (Array.isArray(inv)) {
			// Legacy array is OK; no-op. Entries can be strings or objects.
		} else {
			fixes.push({
				code: "char.state.inventory.not_object",
				severity: "warn",
				message: "inventory was neither object nor array; reset to {}",
				context: { got: typeof inv },
			});
			safe.inventory = {};
		}
	}

	// `this` scope: must be an object.
	const thisScope = safe.this;
	if (thisScope !== undefined) {
		if (typeof thisScope !== "object" || thisScope === null || Array.isArray(thisScope)) {
			fixes.push({
				code: "char.state.this.not_object",
				severity: "warn",
				message: "character.state.this was not an object; reset to {}",
				context: { got: typeof thisScope },
			});
			safe.this = {};
		}
	}

	// pending_says: if present, must be an array of strings; coerce.
	const pending = safe.pending_says;
	if (pending !== undefined) {
		if (!Array.isArray(pending)) {
			fixes.push({
				code: "char.state.pending_says.not_array",
				severity: "warn",
				message: "pending_says was not an array; reset to []",
				context: { got: typeof pending },
			});
			safe.pending_says = [];
		} else {
			const coerced = pending.map((x) => String(x ?? ""));
			const changed = coerced.some((s, i) => s !== pending[i]);
			if (changed) {
				fixes.push({
					code: "char.state.pending_says.coerced",
					severity: "info",
					message: "pending_says contained non-strings; coerced",
					context: { count: pending.length },
				});
			}
			safe.pending_says = coerced.filter((s) => s.length > 0);
		}
	}

	return { state: safe, fixes };
}

// ---------------------------------------------------------------
// Location payload — run on insert (expansion + import), catch
// garbage before it goes to disk.

export type LocationSanitize = {
	payload: Record<string, unknown>;
	fixes: RuntimeBug[];
};

export function sanitizeLocationPayload(
	payload: unknown,
): LocationSanitize {
	const fixes: RuntimeBug[] = [];
	const safe: Record<string, unknown> =
		payload && typeof payload === "object" && !Array.isArray(payload)
			? { ...(payload as Record<string, unknown>) }
			: (fixes.push({
					code: "loc.payload.not_object",
					severity: "error",
					message: "location payload was not an object; reset to defaults",
					context: { got: typeof payload },
				}),
				{});

	if (typeof safe.name !== "string" || !safe.name) {
		fixes.push({
			code: "loc.payload.name.missing",
			severity: "warn",
			message: "location missing name; set placeholder",
			context: {},
		});
		safe.name = "(unnamed)";
	}
	if (typeof safe.biome !== "string" || !safe.biome) {
		fixes.push({
			code: "loc.payload.biome.missing",
			severity: "warn",
			message: "location missing biome; set to 'unset'",
		});
		safe.biome = "unset";
	}
	if (typeof safe.description_template !== "string") {
		if (typeof (safe as any).description === "string") {
			// author used `description:` instead of description_template
			safe.description_template = (safe as any).description;
			fixes.push({
				code: "loc.payload.description_template.from_description",
				severity: "info",
				message: "coerced `description` → `description_template`",
			});
		} else {
			safe.description_template = "";
			fixes.push({
				code: "loc.payload.description_template.missing",
				severity: "warn",
				message: "location missing description_template; empty string",
			});
		}
	}
	if (!Array.isArray(safe.options)) {
		safe.options = [];
		fixes.push({
			code: "loc.payload.options.not_array",
			severity: "warn",
			message: "options was not an array; reset to []",
		});
	} else {
		const healed: any[] = [];
		const raw = safe.options as any[];
		for (let i = 0; i < raw.length; i++) {
			const o = raw[i];
			if (!o || typeof o !== "object") {
				fixes.push({
					code: "loc.payload.options.bad_option",
					severity: "warn",
					message: `option[${i}] was not an object; dropped`,
				});
				continue;
			}
			if (typeof o.label !== "string" || !o.label.trim()) {
				fixes.push({
					code: "loc.payload.options.no_label",
					severity: "warn",
					message: `option[${i}] missing label; dropped`,
				});
				continue;
			}
			// Effects: must be array of objects with a `kind` field.
			if (o.effect !== undefined) {
				if (!Array.isArray(o.effect)) {
					fixes.push({
						code: "loc.payload.options.effect.not_array",
						severity: "warn",
						message: `option[${i}].effect was not an array; dropped`,
						context: { label: o.label },
					});
					o.effect = [];
				} else {
					o.effect = o.effect.filter((e: any) => {
						if (!e || typeof e !== "object" || typeof e.kind !== "string") {
							fixes.push({
								code: "loc.payload.options.effect.malformed",
								severity: "warn",
								message: `option "${o.label}" had a malformed effect; dropped`,
								context: { effect: e },
							});
							return false;
						}
						// Slug-requiring effects must have non-empty slug.
						const needsSlug = [
							"give_item",
							"take_item",
							"use_item",
							"crack_orb",
						];
						if (needsSlug.includes(e.kind) && !e.slug) {
							fixes.push({
								code: "loc.payload.options.effect.missing_slug",
								severity: "warn",
								message: `option "${o.label}" had ${e.kind} without slug; dropped`,
							});
							return false;
						}
						return true;
					});
				}
			}
			healed.push(o);
		}
		safe.options = healed;
	}

	// slug: kebab-case-ish. If missing, leave null — caller handles.
	if (safe.slug !== undefined && typeof safe.slug !== "string") {
		fixes.push({
			code: "loc.payload.slug.not_string",
			severity: "error",
			message: "location slug was not a string; cleared",
			context: { got: typeof safe.slug },
		});
		delete safe.slug;
	}

	return { payload: safe, fixes };
}
