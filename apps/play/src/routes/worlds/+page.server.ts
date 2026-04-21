import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { convexServer } from "$lib/convex";
import { api } from "$convex/_generated/api";

export const load: PageServerLoad = async ({ locals, parent }) => {
	const { user } = await parent();
	if (!user) throw redirect(303, "/");
	const session_token = locals.session_token;
	if (!session_token) throw redirect(303, "/");
	const client = convexServer();
	const worlds = await client.query(api.worlds.listMine, { session_token });
	return { user, worlds };
};
