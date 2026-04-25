import { error, fail, redirect } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { convexServer } from "$lib/convex";
import { api } from "$convex/_generated/api";

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.session_token) throw redirect(303, "/");
	const client = convexServer();
	const world = await client.query(api.worlds.getBySlugForMe, {
		session_token: locals.session_token,
		slug: params.world_slug,
	});
	if (!world) throw error(404, "world not found");
	const atlas = await client.query(api.atlases.getAtlas, {
		session_token: locals.session_token,
		world_slug: params.world_slug,
		atlas_slug: params.atlas_slug,
	});
	if (!atlas) throw error(404, "atlas not found");
	// Pull the world's entity list — locations and biomes are most useful
	// for landmarks. Use the existing graph endpoint that gives us slugs +
	// names already shaped for a UI consumer.
	const map = await client.query(api.map.loadWorldMap, {
		session_token: locals.session_token,
		world_slug: params.world_slug,
	});
	return { world, atlas, map };
};

export const actions: Actions = {
	rename: async ({ params, request, locals }) => {
		if (!locals.session_token) return fail(401, { error: "not signed in" });
		const form = await request.formData();
		const patch: any = {
			session_token: locals.session_token,
			world_slug: params.world_slug,
			atlas_slug: params.atlas_slug,
		};
		const fields = ["name", "description", "style_anchor", "layer_mode"];
		for (const f of fields) {
			const v = form.get(f);
			if (v != null && String(v).length > 0) patch[f] = String(v);
		}
		const published = form.get("published");
		if (published != null) patch.published = String(published) === "true";
		try {
			await convexServer().mutation(api.atlases.renameAtlas, patch);
			return { saved: true };
		} catch (e) {
			return fail(500, { error: (e as Error).message });
		}
	},

	addLayer: async ({ params, request, locals }) => {
		if (!locals.session_token) return fail(401, { error: "not signed in" });
		const form = await request.formData();
		const name = String(form.get("name") ?? "").trim();
		const kind = String(form.get("kind") ?? "other").trim();
		if (name.length < 1) return fail(400, { error: "layer name required" });
		try {
			const r = await convexServer().mutation(api.atlases.addLayer, {
				session_token: locals.session_token,
				world_slug: params.world_slug,
				atlas_slug: params.atlas_slug,
				name,
				kind,
			});
			return { layerAdded: r };
		} catch (e) {
			return fail(500, { error: (e as Error).message });
		}
	},

	deleteLayer: async ({ params, request, locals }) => {
		if (!locals.session_token) return fail(401, { error: "not signed in" });
		const form = await request.formData();
		const layer_slug = String(form.get("layer_slug") ?? "");
		try {
			await convexServer().mutation(api.atlases.deleteLayer, {
				session_token: locals.session_token,
				world_slug: params.world_slug,
				atlas_slug: params.atlas_slug,
				layer_slug,
			});
			return { layerRemoved: layer_slug };
		} catch (e) {
			return fail(500, { error: (e as Error).message });
		}
	},

	placePin: async ({ params, request, locals }) => {
		if (!locals.session_token) return fail(401, { error: "not signed in" });
		const form = await request.formData();
		const layer_slug = String(form.get("layer_slug") ?? "");
		const entity_slug = String(form.get("entity_slug") ?? "").trim() || undefined;
		const custom_label = String(form.get("custom_label") ?? "").trim() || undefined;
		const x = Number(form.get("x") ?? -1);
		const y = Number(form.get("y") ?? -1);
		const visibility = String(form.get("visibility") ?? "icon");
		const placement_id_raw = String(form.get("placement_id") ?? "").trim();
		try {
			const r = await convexServer().mutation(api.atlases.putPlacement, {
				session_token: locals.session_token,
				world_slug: params.world_slug,
				atlas_slug: params.atlas_slug,
				layer_slug,
				entity_slug,
				custom_label,
				x,
				y,
				visibility,
				placement_id: placement_id_raw ? (placement_id_raw as any) : undefined,
			});
			return { placed: r };
		} catch (e) {
			return fail(500, { error: (e as Error).message });
		}
	},

	removePin: async ({ params, request, locals }) => {
		if (!locals.session_token) return fail(401, { error: "not signed in" });
		const form = await request.formData();
		const placement_id = String(form.get("placement_id") ?? "");
		try {
			await convexServer().mutation(api.atlases.removePlacement, {
				session_token: locals.session_token,
				world_slug: params.world_slug,
				atlas_slug: params.atlas_slug,
				placement_id: placement_id as any,
			});
			return { removed: placement_id };
		} catch (e) {
			return fail(500, { error: (e as Error).message });
		}
	},

	suggestIcon: async ({ params, request, locals }) => {
		if (!locals.session_token) return fail(401, { error: "not signed in" });
		const form = await request.formData();
		const placement_id = String(form.get("placement_id") ?? "");
		if (!placement_id) return fail(400, { error: "placement_id required" });
		try {
			const r = await convexServer().action(
				api.atlas_ai.suggestIconPrompt,
				{
					session_token: locals.session_token,
					world_slug: params.world_slug,
					atlas_slug: params.atlas_slug,
					placement_id: placement_id as any,
				},
			);
			return {
				iconSuggestion: {
					placement_id,
					icon_style: r.icon_style,
					icon_prompt: r.icon_prompt,
				},
			};
		} catch (e) {
			return fail(500, { error: (e as Error).message });
		}
	},

	applyIcon: async ({ params, request, locals }) => {
		if (!locals.session_token) return fail(401, { error: "not signed in" });
		const form = await request.formData();
		const placement_id = String(form.get("placement_id") ?? "");
		const icon_style = String(form.get("icon_style") ?? "inkwash");
		const icon_prompt = String(form.get("icon_prompt") ?? "").trim();
		if (!placement_id || !icon_prompt)
			return fail(400, { error: "placement_id + icon_prompt required" });
		try {
			await convexServer().mutation(api.atlas_ai.applyIconPrompt, {
				session_token: locals.session_token,
				world_slug: params.world_slug,
				atlas_slug: params.atlas_slug,
				placement_id: placement_id as any,
				icon_style,
				icon_prompt,
			});
			return { iconApplied: { placement_id } };
		} catch (e) {
			return fail(500, { error: (e as Error).message });
		}
	},

	regenBasemap: async ({ params, request, locals }) => {
		if (!locals.session_token) return fail(401, { error: "not signed in" });
		const form = await request.formData();
		const layer_slug = String(form.get("layer_slug") ?? "");
		const extra_prompt =
			String(form.get("extra_prompt") ?? "").trim() || undefined;
		if (!layer_slug) return fail(400, { error: "layer_slug required" });
		try {
			await convexServer().mutation(api.atlas_ai.regenerateBasemap, {
				session_token: locals.session_token,
				world_slug: params.world_slug,
				atlas_slug: params.atlas_slug,
				layer_slug,
				extra_prompt,
			});
			return { basemapQueued: { layer_slug } };
		} catch (e) {
			return fail(500, { error: (e as Error).message });
		}
	},
};
