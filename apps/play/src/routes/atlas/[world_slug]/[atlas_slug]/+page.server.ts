import { error, redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
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
	const atlas = await client.query(api.atlases.getAtlas, {
		session_token: locals.session_token,
		world_slug: params.world_slug,
		atlas_slug: params.atlas_slug,
	});
	if (!atlas) throw error(404, "atlas not found");
	const map = await client.query(api.map.loadWorldMap, {
		session_token: locals.session_token,
		world_slug: params.world_slug,
	});
	return { world, atlas, map };
};
