import { error, fail, redirect } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { convexServer } from "$lib/convex";
import { api } from "$convex/_generated/api";

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.session_token) throw redirect(303, "/");
	const client = convexServer();
	const world = await client.query(api.worlds.getBySlugForMe, {
		session_token: locals.session_token,
		slug: params.world_slug,
	});
	if (!world) throw error(404, "world not found");
	const data = await client.query(api.worlds.listChronicles, {
		session_token: locals.session_token,
		world_slug: params.world_slug,
	});
	return { world, era_state: data };
};

export const actions: Actions = {
	advance: async ({ params, request, locals }) => {
		if (!locals.session_token) return fail(401, { error: "not signed in" });
		const form = await request.formData();
		const hint = (form.get("hint") as string | null)?.trim() || undefined;
		const client = convexServer();
		try {
			const r = await client.action(api.worlds.advanceEra, {
				session_token: locals.session_token,
				world_slug: params.world_slug,
				hint,
			});
			return { advanced: r };
		} catch (e) {
			return fail(500, { error: (e as Error).message });
		}
	},
};
