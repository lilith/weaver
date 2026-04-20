import { redirect, error } from "@sveltejs/kit";
import type { LayoutServerLoad } from "./$types";
import { convexServer } from "$lib/convex";
import { api } from "$convex/_generated/api";

export const load: LayoutServerLoad = async ({ parent }) => {
	const { user } = await parent();
	if (!user) throw redirect(303, "/");

	const client = convexServer();

	// Wave 0: one world, one branch, one character per player.
	const worlds = await client.query(api.worlds.listForUser, { user_id: user.user_id });
	const world = worlds[0];
	if (!world) throw error(500, "No world seeded. Run `npx convex run seed:seedTinyWorld`.");
	if (!world.current_branch_id) throw error(500, "World missing current branch.");

	const character = await client.query(api.characters.getCurrentForUser, {
		user_id: user.user_id,
		world_id: world._id
	});
	if (!character) throw error(500, `No character for ${user.email} in this world.`);

	const bible = await client.query(api.worlds.getBible, {
		branch_id: world.current_branch_id
	});

	return { user, world, character, bible };
};
