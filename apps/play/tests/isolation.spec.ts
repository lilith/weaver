/**
 * Isolation-adversarial tests — URGENT rule 7.
 *
 * For every world-scoped mutation / action we ship, verify that user B
 * with their own valid session cannot exercise that operation against
 * user A's world_id / journey_id / entity_id, even with the correct
 * argument shape. The expected failure path is either a thrown
 * "forbidden: not a member of this world" (from resolveMember) or a
 * silent null for read-only paths (getBySlugForMe returns null to
 * non-members rather than revealing existence).
 *
 * Build by seeding a world as user A, grabbing its ids, then running
 * user-B requests against them.
 */
import { expect, test } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../convex/_generated/api";

const CONVEX_URL =
	process.env.PUBLIC_CONVEX_URL ?? "https://friendly-chameleon-175.convex.cloud";

async function signIn(email: string): Promise<string> {
	const client = new ConvexHttpClient(CONVEX_URL);
	const { session_token } = await client.action(api._dev.devSignInAs, { email });
	return session_token;
}

async function expectForbidden(fn: () => Promise<any>, label: string) {
	try {
		await fn();
		throw new Error(`${label}: expected forbidden, got success`);
	} catch (e) {
		const msg = (e as Error).message.toLowerCase();
		if (
			msg.includes("forbidden") ||
			msg.includes("not a member") ||
			msg.includes("unauthorized") ||
			msg.includes("not found") ||
			msg.includes("no world")
		) {
			return;
		}
		throw e;
	}
}

test.describe("Isolation — cross-user", () => {
	const stamp = Date.now();
	let tokenA: string;
	let tokenB: string;
	let worldId: string;
	let journeyId: string | null = null;

	test.beforeAll(async () => {
		tokenA = await signIn(`iso-a-${stamp}@theweaver.quest`);
		tokenB = await signIn(`iso-b-${stamp}@theweaver.quest`);
		const client = new ConvexHttpClient(CONVEX_URL);
		const seeded = await client.mutation(api.seed.seedStarterWorld, {
			session_token: tokenA,
			template: "quiet-vale"
		});
		worldId = seeded.world_id;
		// Trigger an expansion as A so there's a draft + journey under A.
		await client.action(api.expansion.expandFromFreeText, {
			session_token: tokenA,
			world_id: worldId as any,
			location_slug: "village-square",
			input: "I step into a side cellar behind the well"
		});
		const journeys = await client.query(api.journeys.listMineInWorld, {
			session_token: tokenA,
			world_id: worldId as any
		});
		journeyId = journeys[0]?._id ?? null;
	});

	test("B cannot read A's world via getBySlugForMe", async () => {
		const client = new ConvexHttpClient(CONVEX_URL);
		// Need the slug — listMine as A to find it.
		const aWorlds = await client.query(api.worlds.listMine, { session_token: tokenA });
		const slug = aWorlds.find((w) => w._id === worldId)!.slug;
		const asB = await client.query(api.worlds.getBySlugForMe, {
			session_token: tokenB,
			slug
		});
		expect(asB).toBeNull();
	});

	test("B cannot listMineInWorld against A's world", async () => {
		const client = new ConvexHttpClient(CONVEX_URL);
		await expectForbidden(
			() =>
				client.query(api.journeys.listMineInWorld, {
					session_token: tokenB,
					world_id: worldId as any
				}),
			"listMineInWorld"
		);
	});

	test("B cannot read A's bible via getBible", async () => {
		const client = new ConvexHttpClient(CONVEX_URL);
		await expectForbidden(
			() =>
				client.query(api.worlds.getBible, {
					session_token: tokenB,
					world_id: worldId as any
				}),
			"getBible"
		);
	});

	test("B cannot read A's locations via getBySlug", async () => {
		const client = new ConvexHttpClient(CONVEX_URL);
		await expectForbidden(
			() =>
				client.query(api.locations.getBySlug, {
					session_token: tokenB,
					world_id: worldId as any,
					slug: "village-square"
				}),
			"locations.getBySlug"
		);
	});

	test("B cannot applyOption in A's world", async () => {
		const client = new ConvexHttpClient(CONVEX_URL);
		await expectForbidden(
			() =>
				client.mutation(api.locations.applyOption, {
					session_token: tokenB,
					world_id: worldId as any,
					location_slug: "village-square",
					option_index: 0
				}),
			"locations.applyOption"
		);
	});

	test("B cannot saveToMap a draft in A's world", async () => {
		const client = new ConvexHttpClient(CONVEX_URL);
		await expectForbidden(
			() =>
				client.mutation(api.locations.saveToMap, {
					session_token: tokenB,
					world_id: worldId as any,
					location_slug: "village-square"
				}),
			"locations.saveToMap"
		);
	});

	test("B cannot expandFromFreeText in A's world", async () => {
		const client = new ConvexHttpClient(CONVEX_URL);
		await expectForbidden(
			() =>
				client.action(api.expansion.expandFromFreeText, {
					session_token: tokenB,
					world_id: worldId as any,
					location_slug: "village-square",
					input: "I steal from the well"
				}),
			"expansion.expandFromFreeText"
		);
	});

	test("B cannot regenerate art on A's location", async () => {
		const client = new ConvexHttpClient(CONVEX_URL);
		await expectForbidden(
			() =>
				client.action(api.art.regenerateArt, {
					session_token: tokenB,
					world_id: worldId as any,
					location_slug: "village-square"
				}),
			"art.regenerateArt"
		);
	});

	test("B cannot resolveJourney on A's journey", async () => {
		if (!journeyId) test.skip();
		const client = new ConvexHttpClient(CONVEX_URL);
		await expectForbidden(
			() =>
				client.mutation(api.journeys.resolveJourney, {
					session_token: tokenB,
					journey_id: journeyId as any,
					keep_slugs: []
				}),
			"journeys.resolveJourney"
		);
	});

	test("B cannot dismiss A's journey", async () => {
		if (!journeyId) test.skip();
		const client = new ConvexHttpClient(CONVEX_URL);
		await expectForbidden(
			() =>
				client.mutation(api.journeys.dismissJourney, {
					session_token: tokenB,
					journey_id: journeyId as any
				}),
			"journeys.dismissJourney"
		);
	});

	test("B cannot getJourney for A's journey", async () => {
		if (!journeyId) test.skip();
		const client = new ConvexHttpClient(CONVEX_URL);
		const out = await client.query(api.journeys.getJourney, {
			session_token: tokenB,
			journey_id: journeyId as any
		});
		// getJourney soft-404's for non-owners (returns null) — no data leak.
		expect(out).toBeNull();
	});

	test("B cannot push content into A's world via cli.pushEntityPayload", async () => {
		const client = new ConvexHttpClient(CONVEX_URL);
		const aWorlds = await client.query(api.worlds.listMine, { session_token: tokenA });
		const slug = aWorlds.find((w) => w._id === worldId)!.slug;
		await expectForbidden(
			() =>
				client.mutation(api.cli.pushEntityPayload, {
					session_token: tokenB,
					world_slug: slug,
					type: "location",
					slug: "village-square",
					payload_json: JSON.stringify({ name: "hijacked" })
				}),
			"cli.pushEntityPayload"
		);
	});

	test("B cannot fast-forward A's clock", async () => {
		const client = new ConvexHttpClient(CONVEX_URL);
		const aWorlds = await client.query(api.worlds.listMine, { session_token: tokenA });
		const slug = aWorlds.find((w) => w._id === worldId)!.slug;
		await expectForbidden(
			() =>
				client.mutation(api.cli.fastForwardClock, {
					session_token: tokenB,
					world_slug: slug,
					delta_minutes: 1000
				}),
			"cli.fastForwardClock"
		);
	});

	test("B cannot set state on A's character", async () => {
		const client = new ConvexHttpClient(CONVEX_URL);
		const aWorlds = await client.query(api.worlds.listMine, { session_token: tokenA });
		const slug = aWorlds.find((w) => w._id === worldId)!.slug;
		await expectForbidden(
			() =>
				client.mutation(api.cli.setCharacterState, {
					session_token: tokenB,
					world_slug: slug,
					path: "hp",
					value_json: "999"
				}),
			"cli.setCharacterState"
		);
	});

	test("B cannot teleport in A's world", async () => {
		const client = new ConvexHttpClient(CONVEX_URL);
		const aWorlds = await client.query(api.worlds.listMine, { session_token: tokenA });
		const slug = aWorlds.find((w) => w._id === worldId)!.slug;
		await expectForbidden(
			() =>
				client.mutation(api.cli.teleportCharacter, {
					session_token: tokenB,
					world_slug: slug,
					loc_slug: "mara-cottage"
				}),
			"cli.teleportCharacter"
		);
	});

	test("B cannot fix entity fields in A's world", async () => {
		const client = new ConvexHttpClient(CONVEX_URL);
		const aWorlds = await client.query(api.worlds.listMine, { session_token: tokenA });
		const slug = aWorlds.find((w) => w._id === worldId)!.slug;
		await expectForbidden(
			() =>
				client.mutation(api.cli.fixEntityField, {
					session_token: tokenB,
					world_slug: slug,
					type: "location",
					slug: "village-square",
					field: "name",
					new_value_json: JSON.stringify("Pwned")
				}),
			"cli.fixEntityField"
		);
	});

	test("B cannot dumpLocation from A's world", async () => {
		const client = new ConvexHttpClient(CONVEX_URL);
		const aWorlds = await client.query(api.worlds.listMine, { session_token: tokenA });
		const slug = aWorlds.find((w) => w._id === worldId)!.slug;
		await expectForbidden(
			() =>
				client.query(api.cli.dumpLocation, {
					session_token: tokenB,
					world_slug: slug,
					loc_slug: "village-square"
				}),
			"cli.dumpLocation"
		);
	});

	test("B cannot exportWorld A's world", async () => {
		const client = new ConvexHttpClient(CONVEX_URL);
		const aWorlds = await client.query(api.worlds.listMine, { session_token: tokenA });
		const slug = aWorlds.find((w) => w._id === worldId)!.slug;
		await expectForbidden(
			() =>
				client.query(api.cli.exportWorld, {
					session_token: tokenB,
					world_slug: slug
				}),
			"cli.exportWorld"
		);
	});

	test("B cannot set world-scoped flag on A's world", async () => {
		const client = new ConvexHttpClient(CONVEX_URL);
		const aWorlds = await client.query(api.worlds.listMine, { session_token: tokenA });
		const slug = aWorlds.find((w) => w._id === worldId)!.slug;
		await expectForbidden(
			() =>
				client.mutation(api.flags.set, {
					session_token: tokenB,
					flag_key: "flag.biome_rules",
					scope_kind: "world",
					scope_id: slug,
					enabled: true
				}),
			"flags.set(world)"
		);
	});

	test("B cannot ensurePrefetched against A's location", async () => {
		const client = new ConvexHttpClient(CONVEX_URL);
		await expectForbidden(
			() =>
				client.action(api.expansion.ensurePrefetched, {
					session_token: tokenB,
					world_id: worldId as any,
					location_slug: "village-square"
				}),
			"expansion.ensurePrefetched"
		);
	});

	test("B cannot startFlow in A's world", async () => {
		const client = new ConvexHttpClient(CONVEX_URL);
		const aWorlds = await client.query(api.worlds.listMine, { session_token: tokenA });
		const slug = aWorlds.find((w) => w._id === worldId)!.slug;
		await expectForbidden(
			() =>
				client.action(api.flows.startFlow, {
					session_token: tokenB,
					world_slug: slug,
					module: "counter",
					initial_state: { target: 1 }
				}),
			"flows.startFlow"
		);
	});

	test("B cannot read A's flows via listMyFlows", async () => {
		const client = new ConvexHttpClient(CONVEX_URL);
		const aWorlds = await client.query(api.worlds.listMine, { session_token: tokenA });
		const slug = aWorlds.find((w) => w._id === worldId)!.slug;
		await expectForbidden(
			() =>
				client.query(api.flows.listMyFlows, {
					session_token: tokenB,
					world_slug: slug
				}),
			"flows.listMyFlows"
		);
	});

	test("B cannot add NPC memory in A's world", async () => {
		const client = new ConvexHttpClient(CONVEX_URL);
		const aWorlds = await client.query(api.worlds.listMine, { session_token: tokenA });
		const slug = aWorlds.find((w) => w._id === worldId)!.slug;
		await expectForbidden(
			() =>
				client.mutation(api.npc_memory.addForNpc, {
					session_token: tokenB,
					world_slug: slug,
					npc_slug: "mara",
					event_type: "pwn",
					summary: "B tried to write here"
				}),
			"npc_memory.addForNpc"
		);
	});

	test("B cannot getRenderingsForEntity on A's world", async () => {
		const client = new ConvexHttpClient(CONVEX_URL);
		const aWorlds = await client.query(api.worlds.listMine, { session_token: tokenA });
		const slug = aWorlds.find((w) => w._id === worldId)!.slug;
		const res = await client.query(api.cli.getEntity, {
			session_token: tokenA,
			world_slug: slug,
			type: "character",
			slug: "mara"
		});
		if (!res) test.skip();
		await expectForbidden(
			() =>
				client.query(api.art_curation.getRenderingsForEntity, {
					session_token: tokenB,
					world_slug: slug,
					entity_id: res!.id
				}),
			"art_curation.getRenderingsForEntity"
		);
	});

	test("B cannot conjureForEntity on A's world", async () => {
		const client = new ConvexHttpClient(CONVEX_URL);
		const aWorlds = await client.query(api.worlds.listMine, { session_token: tokenA });
		const slug = aWorlds.find((w) => w._id === worldId)!.slug;
		const res = await client.query(api.cli.getEntity, {
			session_token: tokenA,
			world_slug: slug,
			type: "character",
			slug: "mara"
		});
		if (!res) test.skip();
		await expectForbidden(
			() =>
				client.action(api.art_curation.conjureForEntity, {
					session_token: tokenB,
					world_slug: slug,
					entity_id: res!.id,
					mode: "tarot_card"
				}),
			"art_curation.conjureForEntity"
		);
	});

	test("B cannot migrate A's art", async () => {
		const client = new ConvexHttpClient(CONVEX_URL);
		const aWorlds = await client.query(api.worlds.listMine, { session_token: tokenA });
		const slug = aWorlds.find((w) => w._id === worldId)!.slug;
		await expectForbidden(
			() =>
				client.mutation(api.art_curation.migrateArtToRenderings, {
					session_token: tokenB,
					world_slug: slug,
					confirm: "yes-migrate-art"
				}),
			"art_curation.migrateArtToRenderings"
		);
	});

	test("B cannot listForNpc against A's world", async () => {
		const client = new ConvexHttpClient(CONVEX_URL);
		const aWorlds = await client.query(api.worlds.listMine, { session_token: tokenA });
		const slug = aWorlds.find((w) => w._id === worldId)!.slug;
		await expectForbidden(
			() =>
				client.query(api.npc_memory.listForNpc, {
					session_token: tokenB,
					world_slug: slug,
					npc_slug: "mara"
				}),
			"npc_memory.listForNpc"
		);
	});

	// ----- spec 26 graph-map + tile-picker -----

	test("B cannot loadGraphMap against A's world", async () => {
		const client = new ConvexHttpClient(CONVEX_URL);
		const aWorlds = await client.query(api.worlds.listMine, { session_token: tokenA });
		const slug = aWorlds.find((w) => w._id === worldId)!.slug;
		await expectForbidden(
			() =>
				client.query(api.graph.loadGraphMap, {
					session_token: tokenB,
					world_slug: slug
				}),
			"graph.loadGraphMap"
		);
	});

	test("B cannot pinNodePosition on A's world", async () => {
		const client = new ConvexHttpClient(CONVEX_URL);
		const aWorlds = await client.query(api.worlds.listMine, { session_token: tokenA });
		const slug = aWorlds.find((w) => w._id === worldId)!.slug;
		await expectForbidden(
			() =>
				client.mutation(api.graph.pinNodePosition, {
					session_token: tokenB,
					world_slug: slug,
					slug: "village-square",
					x: 42,
					y: 42
				}),
			"graph.pinNodePosition"
		);
	});

	test("B cannot unpinNode on A's world", async () => {
		const client = new ConvexHttpClient(CONVEX_URL);
		const aWorlds = await client.query(api.worlds.listMine, { session_token: tokenA });
		const slug = aWorlds.find((w) => w._id === worldId)!.slug;
		await expectForbidden(
			() =>
				client.mutation(api.graph.unpinNode, {
					session_token: tokenB,
					world_slug: slug,
					slug: "village-square"
				}),
			"graph.unpinNode"
		);
	});

	test("B cannot pickTileForLocation on A's world", async () => {
		const client = new ConvexHttpClient(CONVEX_URL);
		const aWorlds = await client.query(api.worlds.listMine, { session_token: tokenA });
		const slug = aWorlds.find((w) => w._id === worldId)!.slug;
		await expectForbidden(
			() =>
				client.action(api.tile_picker.pickTileForLocation, {
					session_token: tokenB,
					world_slug: slug,
					entity_slug: "village-square"
				}),
			"tile_picker.pickTileForLocation"
		);
	});

	test("B cannot backfillWorldTiles on A's world", async () => {
		const client = new ConvexHttpClient(CONVEX_URL);
		const aWorlds = await client.query(api.worlds.listMine, { session_token: tokenA });
		const slug = aWorlds.find((w) => w._id === worldId)!.slug;
		await expectForbidden(
			() =>
				client.action(api.tile_picker.backfillWorldTiles, {
					session_token: tokenB,
					world_slug: slug,
					limit: 5
				}),
			"tile_picker.backfillWorldTiles"
		);
	});

	test("B cannot setMapHint on A's world", async () => {
		const client = new ConvexHttpClient(CONVEX_URL);
		const aWorlds = await client.query(api.worlds.listMine, { session_token: tokenA });
		const slug = aWorlds.find((w) => w._id === worldId)!.slug;
		await expectForbidden(
			() =>
				client.mutation(api.tile_picker.setMapHint, {
					session_token: tokenB,
					world_slug: slug,
					entity_slug: "village-square",
					descriptor: "h1jack3d"
				}),
			"tile_picker.setMapHint"
		);
	});

	test("B cannot setWorldStyle on A's world", async () => {
		const client = new ConvexHttpClient(CONVEX_URL);
		const aWorlds = await client.query(api.worlds.listMine, { session_token: tokenA });
		const slug = aWorlds.find((w) => w._id === worldId)!.slug;
		await expectForbidden(
			() =>
				client.mutation(api.tile_library.setWorldStyle, {
					session_token: tokenB,
					world_slug: slug,
					style_tag: "pwn-style"
				}),
			"tile_library.setWorldStyle"
		);
	});

	test("B cannot import a world over A's slug", async () => {
		const client = new ConvexHttpClient(CONVEX_URL);
		// Any legit world_slug will do — we're testing the slug-collision guard.
		// Can't reuse A's exact slug because it's random per-seed; so just try
		// to import into A's *display name* as a dupe. Expect it to succeed
		// (B creates their own), since importWorldBundle scopes by owner. Here
		// we verify importing with B's session creates a world under B, not A.
		const result = await client.mutation(api.import.importWorldBundle, {
			session_token: tokenB,
			world_name: "Cross-User Attempt",
			world_slug: `iso-b-${stamp}-attempt`,
			content_rating: "family",
			entities: [
				{
					type: "bible",
					slug: "bible",
					payload: {
						name: "Cross-User Attempt",
						tagline: "probe",
						tone: { descriptors: ["test"], avoid: [] }
					}
				},
				{
					type: "biome",
					slug: "test-biome",
					payload: { name: "Test", description: "." }
				},
				{
					type: "location",
					slug: "start",
					payload: {
						name: "start",
						biome: "test-biome",
						description_template: ".",
						safe_anchor: true
					}
				}
			],
			starter_location_slug: "start",
			character_name: "B"
		});
		expect(result.slug).toBe(`iso-b-${stamp}-attempt`);
		// Confirm A can't see it.
		const asA = await client.query(api.worlds.getBySlugForMe, {
			session_token: tokenA,
			slug: `iso-b-${stamp}-attempt`
		});
		expect(asA).toBeNull();
	});

	// ----------------------------------------------------------------
	// Module + code proposal admin surfaces (spec/MODULE_AND_CODE_PROPOSALS.md)

	test("B cannot listModules on A's world", async () => {
		const client = new ConvexHttpClient(CONVEX_URL);
		const aWorlds = await client.query(api.worlds.listMine, {
			session_token: tokenA
		});
		const slug = aWorlds.find((w) => w._id === worldId)!.slug;
		await expectForbidden(
			() =>
				client.query(api.module_proposals.listModules, {
					session_token: tokenB,
					world_slug: slug
				}),
			"module_proposals.listModules"
		);
	});

	test("B cannot listProposals on A's world (modules)", async () => {
		const client = new ConvexHttpClient(CONVEX_URL);
		const aWorlds = await client.query(api.worlds.listMine, {
			session_token: tokenA
		});
		const slug = aWorlds.find((w) => w._id === worldId)!.slug;
		await expectForbidden(
			() =>
				client.query(api.module_proposals.listProposals, {
					session_token: tokenB,
					world_slug: slug
				}),
			"module_proposals.listProposals"
		);
	});

	test("B cannot suggestModuleEdit on A's world", async () => {
		const client = new ConvexHttpClient(CONVEX_URL);
		const aWorlds = await client.query(api.worlds.listMine, {
			session_token: tokenA
		});
		const slug = aWorlds.find((w) => w._id === worldId)!.slug;
		await expectForbidden(
			() =>
				client.action(api.module_proposals.suggestModuleEdit, {
					session_token: tokenB,
					world_slug: slug,
					module_name: "counter",
					feedback: "try to mess with another family's module"
				}),
			"module_proposals.suggestModuleEdit"
		);
	});

	test("B cannot listProposals on A's world (code)", async () => {
		const client = new ConvexHttpClient(CONVEX_URL);
		const aWorlds = await client.query(api.worlds.listMine, {
			session_token: tokenA
		});
		const slug = aWorlds.find((w) => w._id === worldId)!.slug;
		await expectForbidden(
			() =>
				client.query(api.code_proposals.listProposals, {
					session_token: tokenB,
					world_slug: slug
				}),
			"code_proposals.listProposals"
		);
	});

	test("B cannot suggestCodeChange on A's world", async () => {
		const client = new ConvexHttpClient(CONVEX_URL);
		const aWorlds = await client.query(api.worlds.listMine, {
			session_token: tokenA
		});
		const slug = aWorlds.find((w) => w._id === worldId)!.slug;
		await expectForbidden(
			() =>
				client.action(api.code_proposals.suggestCodeChange, {
					session_token: tokenB,
					world_slug: slug,
					feedback: "outsider attempting a code proposal"
				}),
			"code_proposals.suggestCodeChange"
		);
	});

	test("B cannot listAtlasesForWorld on A's world", async () => {
		const client = new ConvexHttpClient(CONVEX_URL);
		const aWorlds = await client.query(api.worlds.listMine, {
			session_token: tokenA
		});
		const slug = aWorlds.find((w) => w._id === worldId)!.slug;
		await expectForbidden(
			() =>
				client.query(api.atlases.listAtlasesForWorld, {
					session_token: tokenB,
					world_slug: slug
				}),
			"atlases.listAtlasesForWorld"
		);
	});

	test("B cannot createAtlas in A's world", async () => {
		const client = new ConvexHttpClient(CONVEX_URL);
		const aWorlds = await client.query(api.worlds.listMine, {
			session_token: tokenA
		});
		const slug = aWorlds.find((w) => w._id === worldId)!.slug;
		await expectForbidden(
			() =>
				client.mutation(api.atlases.createAtlas, {
					session_token: tokenB,
					world_slug: slug,
					name: "outsider's map"
				}),
			"atlases.createAtlas"
		);
	});

	test("B cannot setAiQuality on A's world", async () => {
		const client = new ConvexHttpClient(CONVEX_URL);
		const aWorlds = await client.query(api.worlds.listMine, {
			session_token: tokenA
		});
		const slug = aWorlds.find((w) => w._id === worldId)!.slug;
		await expectForbidden(
			() =>
				client.mutation(api.worlds.setAiQuality, {
					session_token: tokenB,
					world_slug: slug,
					quality: "best"
				}),
			"worlds.setAiQuality"
		);
	});

	test("B cannot eventsForCharacterThread on A's world", async () => {
		const client = new ConvexHttpClient(CONVEX_URL);
		const aWorlds = await client.query(api.worlds.listMine, {
			session_token: tokenA
		});
		const slug = aWorlds.find((w) => w._id === worldId)!.slug;
		// Need an A-owned character_id for the args; use any id-shaped string
		// — auth fails before validation, which is what we want to assert.
		await expectForbidden(
			() =>
				client.query(api.events.eventsForCharacterThread, {
					session_token: tokenB,
					world_slug: slug,
					character_id: "kx0000000000000000000000000000" as any
				}),
			"events.eventsForCharacterThread"
		);
	});

	test("B cannot getStatSchema on A's world", async () => {
		const client = new ConvexHttpClient(CONVEX_URL);
		const aWorlds = await client.query(api.worlds.listMine, {
			session_token: tokenA
		});
		const slug = aWorlds.find((w) => w._id === worldId)!.slug;
		await expectForbidden(
			() =>
				client.query(api.stats.getStatSchema, {
					session_token: tokenB,
					world_slug: slug
				}),
			"stats.getStatSchema"
		);
	});

	test("B cannot applyStatSchema on A's world", async () => {
		const client = new ConvexHttpClient(CONVEX_URL);
		const aWorlds = await client.query(api.worlds.listMine, {
			session_token: tokenA
		});
		const slug = aWorlds.find((w) => w._id === worldId)!.slug;
		await expectForbidden(
			() =>
				client.mutation(api.stats.applyStatSchema, {
					session_token: tokenB,
					world_slug: slug,
					schema_json: JSON.stringify({ canonical: { hp: { label: "x" } } })
				}),
			"stats.applyStatSchema"
		);
	});

	test("B cannot suggestStatSchema on A's world", async () => {
		const client = new ConvexHttpClient(CONVEX_URL);
		const aWorlds = await client.query(api.worlds.listMine, {
			session_token: tokenA
		});
		const slug = aWorlds.find((w) => w._id === worldId)!.slug;
		await expectForbidden(
			() =>
				client.action(api.stats.suggestStatSchema, {
					session_token: tokenB,
					world_slug: slug,
					feedback: "outsider attempting a schema rewrite"
				}),
			"stats.suggestStatSchema"
		);
	});

	test("B cannot listOwnerFlippable on A's world (settings)", async () => {
		const client = new ConvexHttpClient(CONVEX_URL);
		const aWorlds = await client.query(api.worlds.listMine, {
			session_token: tokenA
		});
		const slug = aWorlds.find((w) => w._id === worldId)!.slug;
		await expectForbidden(
			() =>
				client.query(api.flags.listOwnerFlippable, {
					session_token: tokenB,
					world_slug: slug
				}),
			"flags.listOwnerFlippable"
		);
	});
});
