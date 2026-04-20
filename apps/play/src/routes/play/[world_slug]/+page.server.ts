import { error, redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { convexServer } from "$lib/convex";
import { api } from "$convex/_generated/api";

export const load: PageServerLoad = async ({ params, locals, parent }) => {
	const { character, world } = await parent();
	if (!character.current_location_id) {
		throw error(500, "Character has no current location.");
	}
	if (!locals.session_token) throw redirect(303, "/");
	const client = convexServer();
	const result = await client.query(api.locations.getSlugById, {
		session_token: locals.session_token,
		world_id: world._id,
		entity_id: character.current_location_id
	});
	if (!result) throw error(500, "Current location not found.");
	throw redirect(303, `/play/${params.world_slug}/${result.slug}`);
};
