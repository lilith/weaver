import { error, fail, redirect } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { convexServer } from "$lib/convex";
import { api } from "$convex/_generated/api";
import { renderTemplate } from "@weaver/engine/template";

export const load: PageServerLoad = async ({ params, locals, parent }) => {
	const { character, world } = await parent();
	if (!locals.session_token) throw redirect(303, "/");
	const client = convexServer();
	const location = await client.query(api.locations.getBySlug, {
		session_token: locals.session_token,
		world_id: world._id,
		slug: params.loc_slug
	});
	if (!location) throw error(404, `Location "${params.loc_slug}" not found.`);

	const thisScope =
		((character.state as any)?.this?.[params.loc_slug] as Record<string, unknown>) ?? {};
	const ctx = {
		character: (character.state as Record<string, unknown>) ?? {},
		this: thisScope,
		location: {},
		world: {}
	};
	const description = renderTemplate(location.description_template as string, ctx as any);

	return {
		location: {
			entity_id: location.entity_id,
			slug: location.slug,
			name: location.name,
			biome: location.biome,
			author_pseudonym: location.author_pseudonym,
			description,
			options: (location.options as any[]) ?? [],
			tags: (location.tags as string[]) ?? [],
			safe_anchor: location.safe_anchor ?? false
		}
	};
};

export const actions: Actions = {
	pick: async ({ request, params, locals, parent }) => {
		if (!locals.session_token) return fail(401, { error: "not signed in" });
		const form = await request.formData();
		const optionIndex = Number(form.get("option_index") ?? -1);
		if (!Number.isInteger(optionIndex) || optionIndex < 0) {
			return fail(400, { error: "bad option" });
		}
		const { world } = await parent();
		const client = convexServer();
		try {
			const result = await client.mutation(api.locations.applyOption, {
				session_token: locals.session_token,
				world_id: world._id,
				location_slug: params.loc_slug,
				option_index: optionIndex
			});
			if (result.new_location_slug) {
				throw redirect(303, `/play/${params.world_slug}/${result.new_location_slug}`);
			}
			return { says: result.says };
		} catch (e) {
			if ((e as any)?.status === 303) throw e;
			return fail(500, { error: (e as Error).message });
		}
	}
};
