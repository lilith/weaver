import { redirect } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { convexServer } from "$lib/convex";
import { api } from "$convex/_generated/api";

export const load: PageServerLoad = async ({ parent }) => {
	const { user } = await parent();
	return { user };
};

export const actions: Actions = {
	request: async ({ request, url }) => {
		const form = await request.formData();
		const email = String(form.get("email") ?? "").trim();
		if (!email) return { ok: false, error: "Email required." };
		const client = convexServer();
		try {
			await client.action(api.auth.requestMagicLink, {
				email,
				origin: url.origin
			});
		} catch (e) {
			return { ok: false, error: (e as Error).message };
		}
		return { ok: true, email };
	}
};
