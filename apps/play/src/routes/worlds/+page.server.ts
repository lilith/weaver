import { error, fail, redirect } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { convexServer } from "$lib/convex";
import { api } from "$convex/_generated/api";

export const load: PageServerLoad = async ({ locals, parent }) => {
	const { user } = await parent();
	if (!user) throw redirect(303, "/");
	const session_token = locals.session_token;
	if (!session_token) throw redirect(303, "/");
	const client = convexServer();
	const worlds = await client.query(api.worlds.listMine, { session_token });
	return { user, worlds };
};

export const actions: Actions = {
	seed: async ({ locals, request }) => {
		if (!locals.session_token) return fail(401, { error: "not signed in" });
		const form = await request.formData();
		const character_name = (form.get("character_name") as string | null) ?? undefined;
		const client = convexServer();
		try {
			const result = await client.mutation(api.seed.seedStarterWorld, {
				session_token: locals.session_token,
				template: "quiet-vale",
				character_name: character_name?.trim() || undefined
			});
			throw redirect(303, `/play/${result.slug}`);
		} catch (e) {
			if ((e as any)?.status === 303) throw e;
			return fail(500, { error: (e as Error).message });
		}
	}
};
