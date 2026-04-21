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
 * Resolve the final enabled-flag set from form data:
 *   - If `customize=on`, trust the explicit `flag.*` checkboxes.
 *   - Else, use the preset's `flags` list verbatim.
 * Anything not in CUSTOMIZABLE_KEYS is ignored (defence in depth
 * against a tampered form posting flag.is_admin or similar).
 */
function resolveFlags(form: FormData): string[] {
	const customize = form.get("customize") === "on";
	if (customize) {
		const explicit: string[] = [];
		for (const key of CUSTOMIZABLE_KEYS) {
			if (form.get(key) === "on") explicit.push(key);
		}
		return explicit;
	}
	const presetId = form.get("preset") as string | null;
	const preset = presetById(presetId);
	return preset ? preset.flags : [];
}

function resolveStyleTag(form: FormData): string | null {
	const raw = form.get("style_tag") as string | null;
	if (!raw || raw === "") return null;
	return STYLE_IDS.has(raw) ? raw : null;
}

async function applyPostSeedConfig(
	session_token: string,
	world_slug: string,
	flags: string[],
	style_tag: string | null,
): Promise<void> {
	const client = convexServer();
	// Fire flag.set calls in parallel. Each is idempotent — server
	// inserts or patches the (key, scope_kind, scope_id) row.
	await Promise.all(
		flags.map((flag_key) =>
			client
				.mutation(api.flags.set, {
					session_token,
					flag_key,
					scope_kind: "world",
					scope_id: world_slug,
					enabled: true,
					notes: "set at world creation via /worlds/new preset",
				})
				.catch((e) => {
					// Swallow individual flag failures — the world itself is
					// already created, and the user can toggle flags later
					// in /admin. Log to stderr so operator can see.
					console.error(`[worlds/new] flag ${flag_key} failed:`, (e as Error).message);
				}),
		),
	);
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
		await applyPostSeedConfig(
			locals.session_token,
			slug,
			resolveFlags(form),
			resolveStyleTag(form),
		);
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
		await applyPostSeedConfig(
			locals.session_token,
			slug,
			resolveFlags(form),
			resolveStyleTag(form),
		);
		throw redirect(303, `/play/${slug}`);
	},
};
