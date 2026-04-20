import { redirect, fail } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { convexServer } from "$lib/convex";
import { api } from "$convex/_generated/api";

const THIRTY_DAYS = 60 * 60 * 24 * 30;

export const load: PageServerLoad = async ({ url, cookies }) => {
	const token = url.searchParams.get("token");
	if (!token) return { error: "Missing token." };
	const client = convexServer();
	try {
		const result = await client.mutation(api.auth.verifyMagicLink, { token });
		cookies.set("weaver_session", result.session_token, {
			path: "/",
			httpOnly: true,
			sameSite: "lax",
			secure: url.protocol === "https:",
			maxAge: THIRTY_DAYS
		});
	} catch (e) {
		return { error: (e as Error).message };
	}
	throw redirect(303, "/play");
};
