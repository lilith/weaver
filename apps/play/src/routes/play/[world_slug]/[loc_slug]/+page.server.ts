import { error, fail, isRedirect, redirect } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { convexServer } from "$lib/convex";
import { api } from "$convex/_generated/api";
import { renderTemplate } from "@weaver/engine/template";
import { getBiomePalette, paletteToCss } from "@weaver/engine/biomes";

export const load: PageServerLoad = async ({ params, locals, parent, cookies }) => {
	const { character, world } = await parent();
	if (!locals.session_token) throw redirect(303, "/");
	const client = convexServer();
	const location = await client.query(api.locations.getBySlug, {
		session_token: locals.session_token,
		world_id: world._id,
		slug: params.loc_slug
	});
	if (!location) throw error(404, `Location "${params.loc_slug}" not found.`);

	// Journey-close handoff after a redirect — the cookie was set by the
	// previous action's pick/expand handler. One-shot.
	let closed_journey = null;
	const pending_journey_id = cookies.get("weaver_closed_journey");
	if (pending_journey_id) {
		cookies.delete("weaver_closed_journey", { path: "/" });
		try {
			closed_journey = await client.query(api.journeys.getJourney, {
				session_token: locals.session_token,
				journey_id: pending_journey_id as any
			});
			// Only show the panel if the journey is still in "closed" state
			// — avoid re-surfacing once the user has resolved it.
			if (closed_journey && closed_journey.status !== "closed") {
				closed_journey = null;
			}
		} catch {
			closed_journey = null;
		}
	}

	const thisScope =
		((character.state as any)?.this?.[params.loc_slug] as Record<string, unknown>) ?? {};
	const ctx = {
		character: (character.state as Record<string, unknown>) ?? {},
		this: thisScope,
		location: {},
		world: {}
	};
	const description = renderTemplate(location.description_template as string, ctx as any);

	const palette = getBiomePalette(location.biome as string);
	const paletteCss = palette ? paletteToCss(palette) : null;

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
			safe_anchor: location.safe_anchor ?? false,
			draft: (location as any).draft === true
		},
		palette: palette
			? { slug: palette.slug, name: palette.name, mood: palette.mood, css: paletteCss }
			: null,
		closed_journey
	};
};

export const actions: Actions = {
	pick: async ({ request, params, locals, cookies, url }) => {
		if (!locals.session_token) return fail(401, { error: "not signed in" });
		const form = await request.formData();
		const optionIndex = Number(form.get("option_index") ?? -1);
		if (!Number.isInteger(optionIndex) || optionIndex < 0) {
			return fail(400, { error: "bad option" });
		}
		const client = convexServer();
		const world = await client.query(api.worlds.getBySlugForMe, {
			session_token: locals.session_token,
			slug: params.world_slug
		});
		if (!world) return fail(404, { error: "world not found" });

		let result;
		try {
			result = await client.mutation(api.locations.applyOption, {
				session_token: locals.session_token,
				world_id: world._id,
				location_slug: params.loc_slug,
				option_index: optionIndex
			});
		} catch (e) {
			return fail(500, { error: (e as Error).message });
		}
		// If a journey just closed, fetch its detail so the page can show
		// the cluster panel. Keep this before any redirect — the new_loc
		// redirect path also closes the journey (returning to canonical).
		let closed_journey = null;
		if (result.closed_journey_id) {
			try {
				closed_journey = await client.query(api.journeys.getJourney, {
					session_token: locals.session_token,
					journey_id: result.closed_journey_id
				});
			} catch {
				/* ignore — panel just won't show */
			}
		}

		if (result.new_location_slug) {
			// Stash the closed-journey id on a cookie so the new page can
			// pick it up after the redirect. Short TTL — one-shot.
			if (closed_journey) {
				cookies.set("weaver_closed_journey", closed_journey._id, {
					path: "/",
					httpOnly: true,
					sameSite: "lax",
					secure: url.protocol === "https:",
					maxAge: 60
				});
			}
			redirect(303, `/play/${params.world_slug}/${result.new_location_slug}`);
		}
		// If the option pointed at a slug that doesn't exist yet, chain
		// into the expansion loop so the click actually goes somewhere.
		if (result.needs_expansion?.hint) {
			let expanded;
			try {
				expanded = await client.action(api.expansion.expandFromFreeText, {
					session_token: locals.session_token,
					world_id: world._id,
					location_slug: params.loc_slug,
					input: result.needs_expansion.hint
				});
			} catch (e) {
				return fail(500, { error: (e as Error).message });
			}
			if (expanded.kind === "goto") {
				redirect(303, `/play/${params.world_slug}/${expanded.new_location_slug}`);
			}
			return { says: result.says, narrate: expanded.text, closed_journey };
		}
		return { says: result.says, closed_journey };
	},

	save_cluster: async ({ request, params, locals }) => {
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
			return { saved_cluster: { saved: out.saved, total: out.total } };
		} catch (e) {
			return fail(500, { error: (e as Error).message });
		}
	},

	dismiss_journey: async ({ request, locals }) => {
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
			return { dismissed: true };
		} catch (e) {
			return fail(500, { error: (e as Error).message });
		}
	},

	save: async ({ params, locals }) => {
		if (!locals.session_token) return fail(401, { error: "not signed in" });
		const client = convexServer();
		const world = await client.query(api.worlds.getBySlugForMe, {
			session_token: locals.session_token,
			slug: params.world_slug
		});
		if (!world) return fail(404, { error: "world not found" });
		try {
			await client.mutation(api.locations.saveToMap, {
				session_token: locals.session_token,
				world_id: world._id,
				location_slug: params.loc_slug
			});
		} catch (e) {
			return fail(500, { error: (e as Error).message });
		}
		return { saved: true };
	},

	expand: async ({ request, params, locals }) => {
		if (!locals.session_token) return fail(401, { error: "not signed in" });
		const form = await request.formData();
		const input = String(form.get("input") ?? "").trim();
		if (!input) return fail(400, { error: "please describe what you want to do" });

		const client = convexServer();
		const world = await client.query(api.worlds.getBySlugForMe, {
			session_token: locals.session_token,
			slug: params.world_slug
		});
		if (!world) return fail(404, { error: "world not found" });

		let result;
		try {
			result = await client.action(api.expansion.expandFromFreeText, {
				session_token: locals.session_token,
				world_id: world._id,
				location_slug: params.loc_slug,
				input
			});
		} catch (e) {
			return fail(500, { error: (e as Error).message });
		}

		if (result.kind === "goto") {
			redirect(303, `/play/${params.world_slug}/${result.new_location_slug}`);
		}
		return { narrate: result.text };
	}
};
