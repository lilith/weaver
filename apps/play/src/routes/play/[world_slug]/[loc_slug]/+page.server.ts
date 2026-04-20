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
		world: ((location as any).world_state as Record<string, unknown>) ?? {}
	};
	const description = renderTemplate(location.description_template as string, ctx as any);

	// Entity-authored palette first (auto-gen'd per biome), static
	// registry fallback. Entity lookup is cheap — same branch.
	let palette = null as ReturnType<typeof getBiomePalette> | null;
	try {
		const fromEntity = await client.query(api.worlds.getBiomePaletteFromEntity, {
			session_token: locals.session_token,
			world_slug: params.world_slug,
			biome_slug: (location as any).biome as string
		});
		if (fromEntity) palette = fromEntity as any;
	} catch {
		/* fall through to static registry */
	}
	if (!palette) palette = getBiomePalette((location as any).biome as string);
	const paletteCss = palette ? paletteToCss(palette) : null;

	// Flag gate for the art-curation wardrobe. Falls back to the legacy
	// art block when disabled. Resolve failures fail safe (flag off).
	let artCurationEnabled = false;
	try {
		const resolved = await client.query(api.flags.resolve, {
			session_token: locals.session_token,
			flag_key: "flag.art_curation",
			world_slug: params.world_slug
		});
		artCurationEnabled = !!(resolved as { enabled?: boolean })?.enabled;
	} catch {
		artCurationEnabled = false;
	}

	// Era catch-up: if world.active_era has advanced past this
	// character's personal_era, surface the unseen chronicles so the
	// play page can render a catch-up panel. Null when caught up.
	let era_catchup = null;
	try {
		era_catchup = await client.query(api.worlds.pendingEraCatchup, {
			session_token: locals.session_token,
			world_slug: params.world_slug,
		});
	} catch {
		/* fail safe — no panel */
	}

	return {
		location: {
			entity_id: location.entity_id,
			slug: location.slug,
			name: location.name,
			biome: location.biome,
			author_pseudonym: location.author_pseudonym,
			description,
			// options already filtered by condition on the server; each carries
			// its original_index so the pick action can still identify it.
			options: (location.options as any[]) ?? [],
			world_time:
				((location as any).world_state?.time as {
					hhmm?: string;
					day_of_week?: string;
					day_counter?: number;
				} | undefined) ?? null,
			tags: (location.tags as string[]) ?? [],
			safe_anchor: location.safe_anchor ?? false,
			draft: (location as any).draft === true,
			art_url: (location as any).art_url ?? null,
			art_status: (location as any).art_status ?? null
		},
		palette: palette
			? { slug: palette.slug, name: palette.name, mood: palette.mood, css: paletteCss }
			: null,
		closed_journey,
		character_state: (character.state as Record<string, unknown>) ?? {},
		// Art-curation integration surface. Client uses the reactive
		// Convex client keyed by session_token + world_slug + entity_id.
		art_curation: {
			enabled: artCurationEnabled,
			world_slug: params.world_slug,
			entity_id: location.entity_id,
			session_token: locals.session_token
		},
		era_catchup
	};
};

export const actions: Actions = {
	pick: async ({ request, params, locals, cookies, url }) => {
		if (!locals.session_token) return fail(401, { error: "not signed in" });
		const form = await request.formData();
		// The page sends original_index (the index into the unfiltered
		// options array) so the server can still look up the full option
		// even though the UI only showed a subset.
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

	ack_era: async ({ params, locals }) => {
		if (!locals.session_token) return fail(401, { error: "not signed in" });
		const client = convexServer();
		try {
			await client.mutation(api.worlds.acknowledgeEraCatchup, {
				session_token: locals.session_token,
				world_slug: params.world_slug
			});
			return { era_acknowledged: true };
		} catch (e) {
			return fail(500, { error: (e as Error).message });
		}
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

		// Streaming path: if flag.expansion_streaming is on for this
		// world, start a stream and return the stream_id. The client
		// subscribes reactively and renders prose as it arrives.
		let streamingOn = false;
		try {
			const resolved = await client.query(api.flags.resolve, {
				session_token: locals.session_token,
				flag_key: "flag.expansion_streaming",
				world_slug: params.world_slug
			});
			streamingOn = !!(resolved as { enabled?: boolean })?.enabled;
		} catch {
			streamingOn = false;
		}

		if (streamingOn) {
			try {
				const { stream_id } = await client.action(
					api.expansion.startStreamingExpansion,
					{
						session_token: locals.session_token,
						world_id: world._id,
						location_slug: params.loc_slug,
						input
					}
				);
				return {
					stream: {
						id: stream_id,
						session_token: locals.session_token,
						world_slug: params.world_slug
					}
				};
			} catch (e) {
				return fail(500, { error: (e as Error).message });
			}
		}

		// Buffered fallback — original behavior.
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
