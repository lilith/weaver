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
	const bible = await client.query(api.worlds.getBible, {
		session_token: locals.session_token,
		world_id: world._id,
	});
	return { world, bible };
};

export const actions: Actions = {
	suggest: async ({ params, request, locals }) => {
		if (!locals.session_token) return fail(401, { error: "not signed in" });
		const form = await request.formData();
		const feedback = String(form.get("feedback") ?? "").trim();
		if (feedback.length < 4)
			return fail(400, { error: "tell me more (a sentence at least)" });
		const client = convexServer();
		try {
			const r = await client.action(api.worlds.suggestBibleEdit, {
				session_token: locals.session_token,
				world_slug: params.world_slug,
				feedback,
			});
			return {
				suggestion: {
					feedback,
					current: r.current,
					suggested: r.suggested,
					rationale: r.rationale,
					bible_entity_id: r.bible_entity_id,
					current_version: r.current_version,
				},
			};
		} catch (e) {
			return fail(500, { error: (e as Error).message });
		}
	},
	apply: async ({ params, request, locals }) => {
		if (!locals.session_token) return fail(401, { error: "not signed in" });
		const form = await request.formData();
		const new_bible_json = String(form.get("new_bible_json") ?? "");
		const expected_version = Number(form.get("expected_version") ?? -1);
		const reason = String(form.get("reason") ?? "").trim() || undefined;
		if (!new_bible_json)
			return fail(400, { error: "new_bible_json required" });
		const client = convexServer();
		try {
			const r = await client.mutation(api.worlds.applyBibleEdit, {
				session_token: locals.session_token,
				world_slug: params.world_slug,
				new_bible_json,
				expected_version,
				reason,
			});
			return { applied: { version: r.version } };
		} catch (e) {
			return fail(500, { error: (e as Error).message });
		}
	},
};
