import { fail, redirect } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { convexServer } from "$lib/convex";
import { api } from "$convex/_generated/api";
import {
	PRESETS,
	presetById,
	CUSTOMIZABLE_FLAGS,
	STYLE_TAGS,
} from "@weaver/engine/flags/presets";

export const load: PageServerLoad = async ({ locals, parent }) => {
	const { user } = await parent();
	if (!user) throw redirect(303, "/");
	if (!locals.session_token) throw redirect(303, "/");
	return {
		user,
		presets: PRESETS,
		flag_options: CUSTOMIZABLE_FLAGS,
		style_tags: STYLE_TAGS,
	};
};

type Rating = "family" | "teen" | "adult";
const RATINGS: Rating[] = ["family", "teen", "adult"];

const CUSTOMIZABLE_KEYS = new Set(CUSTOMIZABLE_FLAGS.map((f) => f.key));
const STYLE_IDS = new Set(
	STYLE_TAGS.map((s) => s.id).filter((s): s is string => s !== null),
);

/**
 * Resolve {on, off} flag sets from form data:
 *   - customize=on: for each customizable flag, checkbox-checked goes
 *     on; unchecked stays at registry default (no explicit off — users
 *     who want to force-off can just uncheck, relying on default).
 *   - else: preset.flags → on; preset.flags_off → off.
 * Anything not in CUSTOMIZABLE_KEYS is ignored (defence in depth).
 */
function resolveFlags(form: FormData): { on: string[]; off: string[] } {
	const customize = form.get("customize") === "on";
	if (customize) {
		const on: string[] = [];
		const off: string[] = [];
		for (const key of CUSTOMIZABLE_KEYS) {
			// Customize is bidirectional: explicit checked → on, explicit
			// unchecked → off (overriding registry default). The
			// checkboxes all submit present-or-absent, so an unchecked
			// key simply won't be in the form.
			if (form.get(key) === "on") on.push(key);
			else off.push(key);
		}
		return { on, off };
	}
	const presetId = form.get("preset") as string | null;
	const preset = presetById(presetId);
	return preset
		? { on: preset.flags, off: preset.flags_off ?? [] }
		: { on: [], off: [] };
}

function resolveStyleTag(form: FormData): string | null {
	const raw = form.get("style_tag") as string | null;
	if (!raw || raw === "") return null;
	return STYLE_IDS.has(raw) ? raw : null;
}

async function applyPostSeedConfig(
	session_token: string,
	world_slug: string,
	flagsOn: string[],
	flagsOff: string[],
	style_tag: string | null,
): Promise<void> {
	const client = convexServer();
	const setOne = (flag_key: string, enabled: boolean) =>
		client
			.mutation(api.flags.set, {
				session_token,
				flag_key,
				scope_kind: "world",
				scope_id: world_slug,
				enabled,
				notes: `set at world creation via /worlds/new (preset, enabled=${enabled})`,
			})
			.catch((e) => {
				console.error(`[worlds/new] flag ${flag_key} failed:`, (e as Error).message);
			});
	await Promise.all([
		...flagsOn.map((k) => setOne(k, true)),
		...flagsOff.map((k) => setOne(k, false)),
	]);
	if (style_tag) {
		try {
			await client.mutation(api.tile_library.setWorldStyle, {
				session_token,
				world_slug,
				style_tag,
			});
		} catch (e) {
			console.error(`[worlds/new] setWorldStyle ${style_tag} failed:`, (e as Error).message);
		}
	}
}

export const actions: Actions = {
	seed: async ({ locals, request }) => {
		if (!locals.session_token) return fail(401, { error: "not signed in" });
		const form = await request.formData();
		const character_name = (form.get("character_name") as string | null) ?? undefined;
		const client = convexServer();
		let slug: string;
		try {
			const result = await client.mutation(api.seed.seedStarterWorld, {
				session_token: locals.session_token,
				template: "quiet-vale",
				character_name: character_name?.trim() || undefined,
			});
			slug = result.slug;
		} catch (e) {
			return fail(500, { error: (e as Error).message });
		}
		{
			const { on, off } = resolveFlags(form);
			await applyPostSeedConfig(
				locals.session_token,
				slug,
				on,
				off,
				resolveStyleTag(form),
			);
		}
		throw redirect(303, `/play/${slug}`);
	},

	custom_seed: async ({ locals, request }) => {
		if (!locals.session_token) return fail(401, { error: "not signed in" });
		const form = await request.formData();
		const description = (form.get("description") as string | null)?.trim();
		const character_name = (form.get("character_name") as string | null) ?? undefined;
		const ratingRaw = (form.get("content_rating") as string | null) ?? "family";
		const content_rating: Rating = RATINGS.includes(ratingRaw as Rating)
			? (ratingRaw as Rating)
			: "family";
		const presetId = (form.get("preset") as string | null) ?? "";
		const customize = form.get("customize") === "on";

		if (!description || description.length < 8) {
			return fail(400, {
				error: "describe your world in a sentence or two (min ~8 chars)",
				description,
				character_name,
				content_rating,
				preset: presetId,
				customize,
			});
		}

		const client = convexServer();
		let slug: string;
		try {
			const result = await client.action(api.worlds.seedFromDescription, {
				session_token: locals.session_token,
				description,
				character_name: character_name?.trim() || undefined,
				content_rating,
			});
			slug = result.slug;
		} catch (e) {
			return fail(500, {
				error: (e as Error).message || "couldn't weave a new world — try again?",
				description,
				character_name,
				content_rating,
				preset: presetId,
				customize,
			});
		}
		{
			const { on, off } = resolveFlags(form);
			await applyPostSeedConfig(
				locals.session_token,
				slug,
				on,
				off,
				resolveStyleTag(form),
			);
		}
		throw redirect(303, `/play/${slug}`);
	},
};
