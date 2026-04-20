import { error, fail, redirect } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { convexServer } from "$lib/convex";
import { api } from "$convex/_generated/api";

export const load: PageServerLoad = async ({ locals, parent, url }) => {
	const { user } = await parent();
	if (!user) throw redirect(303, "/");
	if (!locals.session_token) throw redirect(303, "/");

	const client = convexServer();
	const worlds = await client.query(api.worlds.listMine, {
		session_token: locals.session_token
	});

	const worldSlug = url.searchParams.get("world");
	const activeWorld = worldSlug
		? worlds.find((w) => w.slug === worldSlug) ?? worlds[0]
		: worlds[0];

	let journeys: any[] = [];
	if (activeWorld) {
		journeys = await client.query(api.journeys.listMineInWorld, {
			session_token: locals.session_token,
			world_id: activeWorld._id
		});
	}

	return { user, worlds, activeWorld, journeys };
};

export const actions: Actions = {
	save_cluster: async ({ request, locals, url }) => {
		if (!locals.session_token) return fail(401, { error: "not signed in" });
		const form = await request.formData();
		const journey_id = form.get("journey_id") as string | null;
		if (!journey_id) return fail(400, { error: "journey_id required" });
		const keep_slugs = (form.getAll("keep_slug") as string[]) ?? [];
		const client = convexServer();
		try {
			const out = await client.mutation(api.journeys.resolveJourney, {
				session_token: locals.session_token,
				journey_id: journey_id as any,
				keep_slugs
			});
			return { saved_cluster: { saved: out.saved, total: out.total, journey_id } };
		} catch (e) {
			return fail(500, { error: (e as Error).message });
		}
	},

	dismiss: async ({ request, locals }) => {
		if (!locals.session_token) return fail(401, { error: "not signed in" });
		const form = await request.formData();
		const journey_id = form.get("journey_id") as string | null;
		if (!journey_id) return fail(400, { error: "journey_id required" });
		const client = convexServer();
		try {
			await client.mutation(api.journeys.dismissJourney, {
				session_token: locals.session_token,
				journey_id: journey_id as any
			});
			return { dismissed: journey_id };
		} catch (e) {
			return fail(500, { error: (e as Error).message });
		}
	}
};
