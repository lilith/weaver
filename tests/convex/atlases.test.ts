// Integration tests for atlases CRUD against the convex-test in-memory
// backend. Covers:
//
//   - createAtlas seeds a default "physical" layer
//   - slug uniqueness within a world (auto-suffix collisions)
//   - placement coord validation (freeform & grid bounds)
//   - permission gates: world-owner can delete; atlas-owner can edit;
//     non-owner-member can only edit their own atlases; non-member is
//     forbidden across the board
//   - cascade: deleteLayer wipes its placements; deleteAtlas wipes all
//   - draft visibility: getAtlas returns null for non-owner viewers
//
// Mirrors the seedWorld + asSession helpers from
// tests/convex/module-proposals.test.ts for consistency.

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../convex/schema.js";
import { api } from "../../convex/_generated/api.js";
import { modules } from "./_modules.js";

async function seedWorld(
	t: ReturnType<typeof convexTest>,
	opts: { slug: string; owner_email: string },
) {
	return await t.run(async (ctx) => {
		const owner_id = await ctx.db.insert("users", {
			email: opts.owner_email,
			is_minor: false,
			guardian_user_ids: [],
			created_at: Date.now(),
		});
		const world_id = await ctx.db.insert("worlds", {
			name: `World ${opts.slug}`,
			slug: opts.slug,
			owner_user_id: owner_id,
			content_rating: "family",
			created_at: Date.now(),
		});
		const branch_id = await ctx.db.insert("branches", {
			world_id,
			name: "Main",
			slug: "main",
			transient: false,
			created_at: Date.now(),
		});
		await ctx.db.patch(world_id, { current_branch_id: branch_id });
		await ctx.db.insert("world_memberships", {
			world_id,
			user_id: owner_id,
			role: "owner",
			created_at: Date.now(),
		});
		// A canonical entity owners can place: village-square location.
		await ctx.db.insert("entities", {
			world_id,
			branch_id,
			type: "location",
			slug: "village-square",
			current_version: 1,
			schema_version: 1,
			created_at: Date.now(),
			updated_at: Date.now(),
		});
		return { owner_id, world_id, branch_id };
	});
}

async function addMember(
	t: ReturnType<typeof convexTest>,
	world_id: any,
	email: string,
	role: "family_mod" | "player" = "player",
): Promise<string> {
	return await t.run(async (ctx) => {
		const user_id = await ctx.db.insert("users", {
			email,
			is_minor: false,
			guardian_user_ids: [],
			created_at: Date.now(),
		});
		await ctx.db.insert("world_memberships", {
			world_id,
			user_id,
			role,
			created_at: Date.now(),
		});
		return user_id as unknown as string;
	});
}

async function asSession(
	t: ReturnType<typeof convexTest>,
	user_id: string,
): Promise<string> {
	const token = `test-token-${user_id}-${Math.random().toString(36).slice(2)}`;
	const { hashString } = await import("@weaver/engine/blobs");
	const token_hash = hashString(token);
	await t.run(async (ctx) => {
		await ctx.db.insert("sessions", {
			user_id: user_id as any,
			token_hash,
			expires_at: Date.now() + 1000 * 60 * 60,
			created_at: Date.now(),
			last_used_at: Date.now(),
		});
	});
	return token;
}

describe("atlases — create + structure", () => {
	test("createAtlas seeds a default physical layer", async () => {
		const t = convexTest(schema, modules);
		const { owner_id } = await seedWorld(t, {
			slug: "atlas-a",
			owner_email: "atlas-a@example.com",
		});
		const token = await asSession(t, owner_id as unknown as string);
		const out = await t.mutation(api.atlases.createAtlas, {
			session_token: token,
			world_slug: "atlas-a",
			name: "Quiet Vale — first sketch",
		});
		expect(out.slug).toBe("quiet-vale-first-sketch");
		// Atlas detail has one layer, no placements yet.
		const detail = await t.query(api.atlases.getAtlas, {
			session_token: token,
			world_slug: "atlas-a",
			atlas_slug: out.slug,
		});
		expect(detail).not.toBeNull();
		expect(detail!.layers).toHaveLength(1);
		expect(detail!.layers[0].slug).toBe("physical");
		expect(detail!.layers[0].kind).toBe("physical");
		expect(Object.values(detail!.placements).flat()).toHaveLength(0);
	});

	test("slug collisions get suffixed", async () => {
		const t = convexTest(schema, modules);
		const { owner_id } = await seedWorld(t, {
			slug: "atlas-b",
			owner_email: "atlas-b@example.com",
		});
		const token = await asSession(t, owner_id as unknown as string);
		const a1 = await t.mutation(api.atlases.createAtlas, {
			session_token: token,
			world_slug: "atlas-b",
			name: "Atlas",
		});
		const a2 = await t.mutation(api.atlases.createAtlas, {
			session_token: token,
			world_slug: "atlas-b",
			name: "Atlas",
		});
		expect(a1.slug).toBe("atlas");
		expect(a2.slug).toBe("atlas-2");
	});

	test("invalid layer_mode rejected", async () => {
		const t = convexTest(schema, modules);
		const { owner_id } = await seedWorld(t, {
			slug: "atlas-c",
			owner_email: "atlas-c@example.com",
		});
		const token = await asSession(t, owner_id as unknown as string);
		await expect(
			t.mutation(api.atlases.createAtlas, {
				session_token: token,
				world_slug: "atlas-c",
				name: "x",
				layer_mode: "tabbed",
			}),
		).rejects.toThrow(/layer_mode/);
	});

	test("grid mode requires grid_cols / grid_rows", async () => {
		const t = convexTest(schema, modules);
		const { owner_id } = await seedWorld(t, {
			slug: "atlas-d",
			owner_email: "atlas-d@example.com",
		});
		const token = await asSession(t, owner_id as unknown as string);
		await expect(
			t.mutation(api.atlases.createAtlas, {
				session_token: token,
				world_slug: "atlas-d",
				name: "g",
				placement_mode: "grid",
			}),
		).rejects.toThrow(/grid_cols/);
	});
});

describe("atlases — placements", () => {
	test("freeform xy must be in [0..1]", async () => {
		const t = convexTest(schema, modules);
		const { owner_id } = await seedWorld(t, {
			slug: "p-a",
			owner_email: "p-a@example.com",
		});
		const token = await asSession(t, owner_id as unknown as string);
		const a = await t.mutation(api.atlases.createAtlas, {
			session_token: token,
			world_slug: "p-a",
			name: "freeform",
		});
		await expect(
			t.mutation(api.atlases.putPlacement, {
				session_token: token,
				world_slug: "p-a",
				atlas_slug: a.slug,
				layer_slug: "physical",
				entity_slug: "village-square",
				x: 1.5,
				y: 0.3,
			}),
		).rejects.toThrow(/0\.\.1/);
	});

	test("entity_slug resolves through current_branch_id", async () => {
		const t = convexTest(schema, modules);
		const { owner_id } = await seedWorld(t, {
			slug: "p-b",
			owner_email: "p-b@example.com",
		});
		const token = await asSession(t, owner_id as unknown as string);
		const a = await t.mutation(api.atlases.createAtlas, {
			session_token: token,
			world_slug: "p-b",
			name: "x",
		});
		const r = await t.mutation(api.atlases.putPlacement, {
			session_token: token,
			world_slug: "p-b",
			atlas_slug: a.slug,
			layer_slug: "physical",
			entity_slug: "village-square",
			x: 0.5,
			y: 0.5,
			visibility: "icon",
		});
		expect(r.placement_id).toBeTruthy();
		const detail = await t.query(api.atlases.getAtlas, {
			session_token: token,
			world_slug: "p-b",
			atlas_slug: a.slug,
		});
		const layer_id = String(detail!.layers[0]._id);
		expect(detail!.placements[layer_id]).toHaveLength(1);
		expect(detail!.placements[layer_id][0].visibility).toBe("icon");
		expect(detail!.placements[layer_id][0].entity_id).toBeTruthy();
	});

	test("custom_label without entity_slug is allowed", async () => {
		const t = convexTest(schema, modules);
		const { owner_id } = await seedWorld(t, {
			slug: "p-c",
			owner_email: "p-c@example.com",
		});
		const token = await asSession(t, owner_id as unknown as string);
		const a = await t.mutation(api.atlases.createAtlas, {
			session_token: token,
			world_slug: "p-c",
			name: "x",
		});
		const r = await t.mutation(api.atlases.putPlacement, {
			session_token: token,
			world_slug: "p-c",
			atlas_slug: a.slug,
			layer_slug: "physical",
			custom_label: "Here be dragons",
			x: 0.05,
			y: 0.95,
			visibility: "icon",
		});
		expect(r.placement_id).toBeTruthy();
	});

	test("missing entity_slug AND custom_label rejected", async () => {
		const t = convexTest(schema, modules);
		const { owner_id } = await seedWorld(t, {
			slug: "p-d",
			owner_email: "p-d@example.com",
		});
		const token = await asSession(t, owner_id as unknown as string);
		const a = await t.mutation(api.atlases.createAtlas, {
			session_token: token,
			world_slug: "p-d",
			name: "x",
		});
		await expect(
			t.mutation(api.atlases.putPlacement, {
				session_token: token,
				world_slug: "p-d",
				atlas_slug: a.slug,
				layer_slug: "physical",
				x: 0.1,
				y: 0.1,
			}),
		).rejects.toThrow(/entity_slug or custom_label/);
	});
});

describe("atlases — permissions + isolation", () => {
	test("non-member cannot listAtlasesForWorld", async () => {
		const t = convexTest(schema, modules);
		await seedWorld(t, {
			slug: "perm-a",
			owner_email: "perm-a@example.com",
		});
		const stranger = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				email: "stranger@example.com",
				is_minor: false,
				guardian_user_ids: [],
				created_at: Date.now(),
			}),
		);
		const tokenS = await asSession(t, stranger as unknown as string);
		await expect(
			t.query(api.atlases.listAtlasesForWorld, {
				session_token: tokenS,
				world_slug: "perm-a",
			}),
		).rejects.toThrow(/forbidden|not a member/);
	});

	test("member who is not atlas-owner cannot edit someone else's atlas", async () => {
		const t = convexTest(schema, modules);
		const { owner_id, world_id } = await seedWorld(t, {
			slug: "perm-b",
			owner_email: "perm-b@example.com",
		});
		// Owner creates atlas A1.
		const tokenO = await asSession(t, owner_id as unknown as string);
		const a1 = await t.mutation(api.atlases.createAtlas, {
			session_token: tokenO,
			world_slug: "perm-b",
			name: "Owner Map",
		});
		// Player B is a member but not the atlas owner.
		const player_b = await addMember(t, world_id, "player-b@example.com");
		const tokenB = await asSession(t, player_b);

		await expect(
			t.mutation(api.atlases.renameAtlas, {
				session_token: tokenB,
				world_slug: "perm-b",
				atlas_slug: a1.slug,
				name: "Hijacked",
			}),
		).rejects.toThrow(/forbidden/);
	});

	test("member can create + edit their own atlas; world owner can also edit it", async () => {
		const t = convexTest(schema, modules);
		const { owner_id, world_id } = await seedWorld(t, {
			slug: "perm-c",
			owner_email: "perm-c@example.com",
		});
		const player_b = await addMember(t, world_id, "player-c@example.com");
		const tokenB = await asSession(t, player_b);
		const tokenO = await asSession(t, owner_id as unknown as string);

		// Player creates their own atlas — fine.
		const aB = await t.mutation(api.atlases.createAtlas, {
			session_token: tokenB,
			world_slug: "perm-c",
			name: "B's view",
		});
		// World owner can also edit B's atlas.
		await t.mutation(api.atlases.renameAtlas, {
			session_token: tokenO,
			world_slug: "perm-c",
			atlas_slug: aB.slug,
			description: "noted by world owner",
		});
		const detail = await t.query(api.atlases.getAtlas, {
			session_token: tokenO,
			world_slug: "perm-c",
			atlas_slug: aB.slug,
		});
		expect(detail!.atlas.description).toBe("noted by world owner");
	});

	test("non-owner cannot deleteAtlas (world-owner-only)", async () => {
		const t = convexTest(schema, modules);
		const { owner_id, world_id } = await seedWorld(t, {
			slug: "perm-d",
			owner_email: "perm-d@example.com",
		});
		const player_b = await addMember(t, world_id, "player-d@example.com");
		const tokenB = await asSession(t, player_b);
		const tokenO = await asSession(t, owner_id as unknown as string);

		// B creates their own atlas...
		const aB = await t.mutation(api.atlases.createAtlas, {
			session_token: tokenB,
			world_slug: "perm-d",
			name: "B's atlas",
		});
		// ...but B can't delete it: deletion is world-owner-only as a guardrail.
		await expect(
			t.mutation(api.atlases.deleteAtlas, {
				session_token: tokenB,
				world_slug: "perm-d",
				atlas_slug: aB.slug,
			}),
		).rejects.toThrow(/forbidden/);
		// World owner can.
		const r = await t.mutation(api.atlases.deleteAtlas, {
			session_token: tokenO,
			world_slug: "perm-d",
			atlas_slug: aB.slug,
		});
		expect(r.ok).toBe(true);
	});

	test("draft atlas not visible to other members", async () => {
		const t = convexTest(schema, modules);
		const { owner_id, world_id } = await seedWorld(t, {
			slug: "perm-e",
			owner_email: "perm-e@example.com",
		});
		const tokenO = await asSession(t, owner_id as unknown as string);
		const a = await t.mutation(api.atlases.createAtlas, {
			session_token: tokenO,
			world_slug: "perm-e",
			name: "draft",
		});
		// Default is published=false.
		const player_b = await addMember(t, world_id, "player-e@example.com");
		const tokenB = await asSession(t, player_b);
		const detail = await t.query(api.atlases.getAtlas, {
			session_token: tokenB,
			world_slug: "perm-e",
			atlas_slug: a.slug,
		});
		expect(detail).toBeNull();
		// listAtlasesForWorld also filters drafts for non-owners.
		const list = await t.query(api.atlases.listAtlasesForWorld, {
			session_token: tokenB,
			world_slug: "perm-e",
		});
		expect(list).toHaveLength(0);
	});
});

describe("atlases — cascade delete", () => {
	test("deleteLayer removes its placements; deleteAtlas wipes all", async () => {
		const t = convexTest(schema, modules);
		const { owner_id } = await seedWorld(t, {
			slug: "cas-a",
			owner_email: "cas-a@example.com",
		});
		const token = await asSession(t, owner_id as unknown as string);
		const a = await t.mutation(api.atlases.createAtlas, {
			session_token: token,
			world_slug: "cas-a",
			name: "x",
		});
		// Add second layer + a placement on it.
		const layer2 = await t.mutation(api.atlases.addLayer, {
			session_token: token,
			world_slug: "cas-a",
			atlas_slug: a.slug,
			name: "Caves",
			kind: "caves",
		});
		await t.mutation(api.atlases.putPlacement, {
			session_token: token,
			world_slug: "cas-a",
			atlas_slug: a.slug,
			layer_slug: layer2.slug,
			custom_label: "old well",
			x: 0.4,
			y: 0.4,
		});
		// deleteLayer removes the placement.
		const r = await t.mutation(api.atlases.deleteLayer, {
			session_token: token,
			world_slug: "cas-a",
			atlas_slug: a.slug,
			layer_slug: layer2.slug,
		});
		expect(r.placements_removed).toBe(1);
		// Atlas still exists with the default layer.
		const detail = await t.query(api.atlases.getAtlas, {
			session_token: token,
			world_slug: "cas-a",
			atlas_slug: a.slug,
		});
		expect(detail!.layers).toHaveLength(1);

		// deleteAtlas removes everything.
		const del = await t.mutation(api.atlases.deleteAtlas, {
			session_token: token,
			world_slug: "cas-a",
			atlas_slug: a.slug,
		});
		expect(del.ok).toBe(true);
		const after = await t.query(api.atlases.getAtlas, {
			session_token: token,
			world_slug: "cas-a",
			atlas_slug: a.slug,
		});
		expect(after).toBeNull();
	});
});
