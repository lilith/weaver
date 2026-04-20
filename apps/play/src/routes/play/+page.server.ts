import { redirect, error } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { convexServer } from "$lib/convex";
import { api } from "$convex/_generated/api";

export const load: PageServerLoad = async ({ parent }) => {
	const { character } = await parent();
	if (!character.current_location_id) {
		throw error(500, "Character has no current location.");
	}
	const client = convexServer();
	const location = await client.query(api.locations.getLocationByEntityId, {
		entity_id: character.current_location_id
	});
	if (!location) throw error(500, "Current location missing from DB.");
	throw redirect(303, `/play/${location.slug}`);
};
