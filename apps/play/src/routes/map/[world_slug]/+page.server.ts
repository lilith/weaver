import { error, redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { convexServer } from "$lib/convex";
import { api } from "$convex/_generated/api";

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.session_token) throw redirect(303, "/");
	const client = convexServer();
	const map = await client.query(api.map.loadWorldMap, {
		session_token: locals.session_token,
		world_slug: params.world_slug
	});
	if (!map) throw error(404, `World "${params.world_slug}" not found.`);
	return {
		world: map.world,
		nodes: map.nodes,
		world_slug: params.world_slug
	};
};
