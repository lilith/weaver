import { fail, redirect } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { convexServer } from "$lib/convex";
import { api } from "$convex/_generated/api";

export const load: PageServerLoad = async ({ locals, parent }) => {
	const { user } = await parent();
	if (!user) throw redirect(303, "/");
	if (!locals.session_token) throw redirect(303, "/");
	return { user };
};

type Rating = "family" | "teen" | "adult";
const RATINGS: Rating[] = ["family", "teen", "adult"];

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
		if (!description || description.length < 8) {
			return fail(400, {
				error: "describe your world in a sentence or two (min ~8 chars)",
				description,
				character_name,
				content_rating
			});
		}
		const client = convexServer();
		try {
			const result = await client.action(api.worlds.seedFromDescription, {
				session_token: locals.session_token,
				description,
				character_name: character_name?.trim() || undefined,
				content_rating
			});
			throw redirect(303, `/play/${result.slug}`);
		} catch (e) {
			if ((e as any)?.status === 303) throw e;
			return fail(500, {
				error: (e as Error).message || "couldn't weave a new world — try again?",
				description,
				character_name,
				content_rating
			});
		}
	}
};
