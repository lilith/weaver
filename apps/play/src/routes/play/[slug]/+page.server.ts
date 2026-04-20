import { error, fail, redirect } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { convexServer } from "$lib/convex";
import { api } from "$convex/_generated/api";
import { renderTemplate } from "@weaver/engine/template";

export const load: PageServerLoad = async ({ params, parent }) => {
	const { character, world } = await parent();
	if (!world.current_branch_id) throw error(500, "no current branch");
	const client = convexServer();
	const location = await client.query(api.locations.getLocationBySlug, {
		branch_id: world.current_branch_id,
		slug: params.slug
	});
	if (!location) throw error(404, `Location "${params.slug}" not found.`);

	// Build the render context: scope state per spec/02 §Scoped state.
	const thisScope =
		((character.state as any)?.this?.[params.slug] as Record<string, unknown>) ?? {};
	const ctx = {
		character: (character.state as Record<string, unknown>) ?? {},
		this: thisScope,
		location: {},
		world: {}
	};

	const description = renderTemplate(
		location.description_template as string,
		ctx as any
	);

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
	pick: async ({ request, params, parent, url }) => {
		const form = await request.formData();
		const optionIndex = Number(form.get("option_index") ?? -1);
		if (!Number.isInteger(optionIndex) || optionIndex < 0) {
			return fail(400, { error: "bad option" });
		}
		const p = await parent();
		const client = convexServer();
		const location = await client.query(api.locations.getLocationBySlug, {
			branch_id: p.world.current_branch_id!,
			slug: params.slug
		});
		if (!location) return fail(404, { error: "no location" });
		const result = await client.mutation(api.locations.applyOption, {
			character_id: p.character._id,
			location_entity_id: location.entity_id,
			option_index: optionIndex
		});
		if (result.new_location_id) {
			// Resolve id → slug for a clean URL.
			const next = await client.query(api.locations.getLocationByEntityId, {
				entity_id: result.new_location_id
			});
			if (next) throw redirect(303, `/play/${next.slug}`);
		}
		// Replay the current page with the say lines flashed.
		return { says: result.says };
	}
};
