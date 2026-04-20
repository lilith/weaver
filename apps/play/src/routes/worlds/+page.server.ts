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
	// Quiet Vale starter template — unchanged.
	seed: async ({ locals, request }) => {
		if (!locals.session_token) return fail(401, { error: "not signed in" });
		const form = await request.formData();
		const character_name = (form.get("character_name") as string | null) ?? undefined;
		const client = convexServer();
		let result;
		try {
			result = await client.mutation(api.seed.seedStarterWorld, {
				session_token: locals.session_token,
				template: "quiet-vale",
				character_name: character_name?.trim() || undefined
			});
		} catch (e) {
			return fail(500, { error: (e as Error).message });
		}
		redirect(303, `/play/${result.slug}`);
	},

	// Custom seed — Opus generates a minimal bible + biome + starter
	// location from a short user description. ~$0.02-0.04 per call.
	custom_seed: async ({ locals, request }) => {
		if (!locals.session_token) return fail(401, { error: "not signed in" });
		const form = await request.formData();
		const description = (form.get("description") as string | null)?.trim();
		const character_name = (form.get("character_name") as string | null) ?? undefined;
		if (!description || description.length < 8) {
			return fail(400, {
				error: "describe your world in a sentence or two (min ~8 chars)"
			});
		}
		const client = convexServer();
		let result;
		try {
			result = await client.action(api.worlds.seedFromDescription, {
				session_token: locals.session_token,
				description,
				character_name: character_name?.trim() || undefined
			});
		} catch (e) {
			return fail(500, {
				error: (e as Error).message || "couldn't weave a new world — try again?"
			});
		}
		redirect(303, `/play/${result.slug}`);
	}
};
