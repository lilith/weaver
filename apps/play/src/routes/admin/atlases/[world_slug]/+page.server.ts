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
	const [atlases, flag] = await Promise.all([
		client.query(api.atlases.listAtlasesForWorld, {
			session_token: locals.session_token,
			world_slug: params.world_slug,
		}),
		client.query(api.flags.resolve, {
			session_token: locals.session_token,
			flag_key: "flag.atlases",
			world_slug: params.world_slug,
		}),
	]);
	return { world, atlases, flag };
};

export const actions: Actions = {
	create: async ({ params, request, locals }) => {
		if (!locals.session_token) return fail(401, { error: "not signed in" });
		const form = await request.formData();
		const name = String(form.get("name") ?? "").trim();
		const layer_mode = String(form.get("layer_mode") ?? "solo").trim();
		if (name.length < 1)
			return fail(400, { error: "give your atlas a name" });
		const client = convexServer();
		try {
			const r = await client.mutation(api.atlases.createAtlas, {
				session_token: locals.session_token,
				world_slug: params.world_slug,
				name,
				layer_mode,
			});
			throw redirect(303, `/admin/atlases/${params.world_slug}/${r.slug}`);
		} catch (e) {
			// SvelteKit redirects throw — let them through.
			if ((e as any)?.status === 303) throw e;
			return fail(500, { error: (e as Error).message });
		}
	},
};
