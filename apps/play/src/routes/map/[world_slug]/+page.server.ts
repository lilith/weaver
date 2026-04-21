import { error, redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { convexServer } from "$lib/convex";
import { api } from "$convex/_generated/api";

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.session_token) throw redirect(303, "/");
	const client = convexServer();
	// Resolve graph_map flag; if on load the new bundle, else the grid map.
	const graphFlag = await client.query(api.flags.resolve, {
		session_token: locals.session_token,
		flag_key: "flag.graph_map",
		world_slug: params.world_slug
	});
	if (graphFlag.enabled) {
		const bundle = await client.query(api.graph.loadGraphMap, {
			session_token: locals.session_token,
			world_slug: params.world_slug
		});
		if (!bundle) throw error(404, `World "${params.world_slug}" not found.`);
		return {
			graph_enabled: true as const,
			world: bundle.world,
			bundle,
			world_slug: params.world_slug,
			session_token: locals.session_token
		};
	}
	const map = await client.query(api.map.loadWorldMap, {
		session_token: locals.session_token,
		world_slug: params.world_slug
	});
	if (!map) throw error(404, `World "${params.world_slug}" not found.`);
	return {
		graph_enabled: false as const,
		world: map.world,
		nodes: map.nodes,
		world_slug: params.world_slug
	};
};
