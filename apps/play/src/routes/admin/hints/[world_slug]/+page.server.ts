import { error, fail, redirect } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { convexServer } from "$lib/convex";
import { api } from "$convex/_generated/api";

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.session_token) throw redirect(303, "/");
	const client = convexServer();
	let data;
	try {
		data = await client.query(api.tile_picker.listHintsForWorld, {
			session_token: locals.session_token,
			world_slug: params.world_slug,
		});
	} catch (e) {
		throw error(403, (e as Error).message);
	}
	if (!data) throw error(404, "world not found");
	return { ...data, world_slug: params.world_slug };
};

export const actions: Actions = {
	save: async ({ locals, params, request }) => {
		if (!locals.session_token) return fail(401, { error: "not signed in" });
		const form = await request.formData();
		const entity_slug = (form.get("entity_slug") as string | null) ?? "";
		const descriptor = ((form.get("descriptor") as string | null) ?? "").trim();
		const kind = ((form.get("kind") as string | null) ?? "portrait").trim();
		const relative_direction = ((form.get("relative_direction") as string | null) ?? "").trim();
		const relative_distance = ((form.get("relative_distance") as string | null) ?? "").trim();
		if (!entity_slug) return fail(400, { error: "missing entity_slug" });
		if (!descriptor) return fail(400, { error: "descriptor cannot be empty — use Clear instead" });
		const client = convexServer();
		try {
			await client.mutation(api.tile_picker.setMapHint, {
				session_token: locals.session_token,
				world_slug: params.world_slug,
				entity_slug,
				descriptor,
				kind: kind || undefined,
				relative_direction: relative_direction || undefined,
				relative_distance: relative_distance || undefined,
			});
			return { ok: true, saved_slug: entity_slug };
		} catch (e) {
			return fail(500, { error: (e as Error).message });
		}
	},
	clear: async ({ locals, params, request }) => {
		if (!locals.session_token) return fail(401, { error: "not signed in" });
		const form = await request.formData();
		const entity_slug = (form.get("entity_slug") as string | null) ?? "";
		if (!entity_slug) return fail(400, { error: "missing entity_slug" });
		const client = convexServer();
		try {
			await client.mutation(api.tile_picker.clearMapHint, {
				session_token: locals.session_token,
				world_slug: params.world_slug,
				entity_slug,
			});
			return { ok: true, cleared_slug: entity_slug };
		} catch (e) {
			return fail(500, { error: (e as Error).message });
		}
	},
};
