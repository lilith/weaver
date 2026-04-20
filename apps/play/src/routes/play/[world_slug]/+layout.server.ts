import { error, redirect } from "@sveltejs/kit";
import type { LayoutServerLoad } from "./$types";
import { convexServer } from "$lib/convex";
import { api } from "$convex/_generated/api";

export const load: LayoutServerLoad = async ({ params, locals, parent }) => {
	const { user } = await parent();
	if (!user) throw redirect(303, "/");
	const session_token = locals.session_token;
	if (!session_token) throw redirect(303, "/");

	const client = convexServer();
	const world = await client.query(api.worlds.getBySlugForMe, {
		session_token,
		slug: params.world_slug
	});
	if (!world) throw error(404, "World not found or you're not a member.");

	const character = await client.query(api.characters.getMineInWorld, {
		session_token,
		world_id: world._id
	});
	if (!character) throw error(404, "You have no character in this world.");

	return { user, world, character };
};
