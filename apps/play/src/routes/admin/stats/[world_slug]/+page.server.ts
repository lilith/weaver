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
	if (world.role !== "owner")
		throw error(403, "stat schema is owner-only");
	const schema = await client.query(api.stats.getStatSchema, {
		session_token: locals.session_token,
		world_slug: params.world_slug,
	});
	return { world, schema: schema?.schema ?? null };
};

export const actions: Actions = {
	suggest: async ({ params, request, locals }) => {
		if (!locals.session_token) return fail(401, { error: "not signed in" });
		const form = await request.formData();
		const feedback = String(form.get("feedback") ?? "").trim();
		if (feedback.length < 4)
			return fail(400, { error: "tell me what to change (a sentence)" });
		const client = convexServer();
		try {
			const r = await client.action(api.stats.suggestStatSchema, {
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
				},
			};
		} catch (e) {
			return fail(500, { error: (e as Error).message });
		}
	},
	apply: async ({ params, request, locals }) => {
		if (!locals.session_token) return fail(401, { error: "not signed in" });
		const form = await request.formData();
		const schema_json = String(form.get("schema_json") ?? "");
		const reason = String(form.get("reason") ?? "").trim() || undefined;
		if (!schema_json) return fail(400, { error: "schema_json required" });
		const client = convexServer();
		try {
			await client.mutation(api.stats.applyStatSchema, {
				session_token: locals.session_token,
				world_slug: params.world_slug,
				schema_json,
				reason,
			});
			return { applied: true };
		} catch (e) {
			return fail(500, { error: (e as Error).message });
		}
	},
	reset: async ({ params, locals }) => {
		if (!locals.session_token) return fail(401, { error: "not signed in" });
		const client = convexServer();
		try {
			await client.mutation(api.stats.resetStatSchema, {
				session_token: locals.session_token,
				world_slug: params.world_slug,
			});
			return { reset: true };
		} catch (e) {
			return fail(500, { error: (e as Error).message });
		}
	},
};
