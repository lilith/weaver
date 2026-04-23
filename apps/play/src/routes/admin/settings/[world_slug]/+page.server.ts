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
		throw error(403, "settings are owner-only");
	const flags = await client.query(api.flags.listOwnerFlippable, {
		session_token: locals.session_token,
		world_slug: params.world_slug,
	});
	return { world, flags: flags.flags };
};

export const actions: Actions = {
	toggle: async ({ params, request, locals }) => {
		if (!locals.session_token) return fail(401, { error: "not signed in" });
		const form = await request.formData();
		const flag_key = String(form.get("flag_key") ?? "");
		const next = String(form.get("next") ?? "") === "on";
		if (!flag_key) return fail(400, { error: "flag_key required" });
		const client = convexServer();
		try {
			await client.mutation(api.flags.set, {
				session_token: locals.session_token,
				flag_key,
				scope_kind: "world",
				scope_id: params.world_slug,
				enabled: next,
				notes: `admin settings toggle`,
			});
			return { toggled: { flag_key, enabled: next } };
		} catch (e) {
			return fail(500, { error: (e as Error).message });
		}
	},
	clear: async ({ params, request, locals }) => {
		if (!locals.session_token) return fail(401, { error: "not signed in" });
		const form = await request.formData();
		const flag_key = String(form.get("flag_key") ?? "");
		if (!flag_key) return fail(400, { error: "flag_key required" });
		const client = convexServer();
		try {
			await client.mutation(api.flags.unset, {
				session_token: locals.session_token,
				flag_key,
				scope_kind: "world",
				scope_id: params.world_slug,
			});
			return { cleared: { flag_key } };
		} catch (e) {
			return fail(500, { error: (e as Error).message });
		}
	},
};
