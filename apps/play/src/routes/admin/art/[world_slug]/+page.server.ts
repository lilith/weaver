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
	const board = await client.query(api.art_curation.listReferenceBoard, {
		session_token: locals.session_token,
		world_slug: params.world_slug,
	});
	if (!board) throw error(403, "art admin is owner-only");
	const all = await client.query(api.art_curation.listAllRenderings, {
		session_token: locals.session_token,
		world_slug: params.world_slug,
	});
	return {
		world,
		board,
		renderings: all ?? [],
		r2_public_url: process.env.PUBLIC_R2_IMAGES_URL ?? "",
	};
};

export const actions: Actions = {
	remove_from_board: async ({ params, request, locals }) => {
		if (!locals.session_token) return fail(401, { error: "not signed in" });
		const form = await request.formData();
		const board_id = form.get("board_id") as string | null;
		if (!board_id) return fail(400, { error: "board_id required" });
		const client = convexServer();
		try {
			await client.mutation(api.art_curation.removeFromReferenceBoard, {
				session_token: locals.session_token,
				world_slug: params.world_slug,
				board_id: board_id as any,
			});
			return { removed: true };
		} catch (e) {
			return fail(500, { error: (e as Error).message });
		}
	},

	add_to_board: async ({ params, request, locals }) => {
		if (!locals.session_token) return fail(401, { error: "not signed in" });
		const form = await request.formData();
		const rendering_id = form.get("rendering_id") as string | null;
		const kind = (form.get("kind") as string | null)?.trim();
		const caption = (form.get("caption") as string | null)?.trim() || undefined;
		if (!rendering_id || !kind)
			return fail(400, { error: "rendering_id and kind required" });
		const client = convexServer();
		try {
			await client.mutation(api.art_curation.addToReferenceBoard, {
				session_token: locals.session_token,
				world_slug: params.world_slug,
				rendering_id: rendering_id as any,
				kind,
				caption,
			});
			return { added: true };
		} catch (e) {
			return fail(500, { error: (e as Error).message });
		}
	},
};
