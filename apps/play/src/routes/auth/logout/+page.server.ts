import { redirect } from "@sveltejs/kit";
import type { Actions } from "./$types";
import { convexServer } from "$lib/convex";
import { api } from "$convex/_generated/api";

export const actions: Actions = {
	default: async ({ cookies, locals }) => {
		if (locals.session_token) {
			const client = convexServer();
			try {
				await client.mutation(api.auth.logout, { session_token: locals.session_token });
			} catch {
				/* best effort */
			}
		}
		cookies.delete("weaver_session", { path: "/" });
		throw redirect(303, "/");
	}
};
