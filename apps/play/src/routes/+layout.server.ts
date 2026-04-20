import type { LayoutServerLoad } from "./$types";
import { convexServer } from "$lib/convex";
import { api } from "$convex/_generated/api";

export const load: LayoutServerLoad = async ({ locals }) => {
	const session_token = locals.session_token;
	if (!session_token) return { user: null };
	const client = convexServer();
	const user = await client.query(api.auth.getSessionUser, { session_token });
	return { user };
};
