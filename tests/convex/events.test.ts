// Integration tests for events.ts via convex-test. Covers:
//   - writeEvent inserts with sparse columns
//   - eventsAtLocation / eventsForNpc / eventsForCharacterNpc /
//     eventsForCharacterThread return rows in time-desc order, bounded
//   - non-member cannot read
//   - min_salience filters correctly
//   - setAiQuality on worlds

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../convex/schema.js";
import { api, internal } from "../../convex/_generated/api.js";
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
		const character_id = await ctx.db.insert("characters", {
			world_id,
			branch_id,
			user_id: owner_id,
			name: "Lilith",
			pseudonym: "lilith",
			state: { hp: 10 },
			schema_version: 1,
			created_at: Date.now(),
			updated_at: Date.now(),
		});
		// Seed a location entity for queries.
		const location_id = await ctx.db.insert("entities", {
			world_id,
			branch_id,
			type: "location",
			slug: "village-square",
			current_version: 1,
			schema_version: 1,
			created_at: Date.now(),
			updated_at: Date.now(),
		});
		const npc_id = await ctx.db.insert("entities", {
			world_id,
			branch_id,
			type: "npc",
			slug: "mara",
			current_version: 1,
			schema_version: 1,
			created_at: Date.now(),
			updated_at: Date.now(),
		});
		return { owner_id, world_id, branch_id, character_id, location_id, npc_id };
	});
}

async function asSession(
	t: ReturnType<typeof convexTest>,
	user_id: string,
): Promise<string> {
	const token = `t-${user_id}-${Math.random().toString(36).slice(2)}`;
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

describe("events — writer + reads", () => {
	test("writeEvent inserts with the sparse columns set", async () => {
		const t = convexTest(schema, modules);
		const { owner_id, world_id, branch_id, character_id, location_id } =
			await seedWorld(t, { slug: "ev-a", owner_email: "ev-a@example.com" });
		await t.mutation(internal.events.writeEvent, {
			world_id: world_id as any,
			branch_id: branch_id as any,
			character_id: character_id as any,
			location_id: location_id as any,
			kind: "narrate",
			body: "the wind catches the chimes",
			salience: "medium",
		});
		const tk = await asSession(t, owner_id as unknown as string);
		const rows = await t.query(api.events.eventsAtLocation, {
			session_token: tk,
			world_slug: "ev-a",
			location_id: location_id as any,
		});
		expect(rows).toHaveLength(1);
		expect(rows[0].kind).toBe("narrate");
		expect(rows[0].body).toContain("chimes");
	});

	test("queries return time-desc and respect limit", async () => {
		const t = convexTest(schema, modules);
		const { owner_id, world_id, branch_id, character_id, location_id } =
			await seedWorld(t, { slug: "ev-b", owner_email: "ev-b@example.com" });
		// Three events at the same location, separated in time.
		for (let i = 1; i <= 3; i++) {
			await t.mutation(internal.events.writeEvent, {
				world_id: world_id as any,
				branch_id: branch_id as any,
				character_id: character_id as any,
				location_id: location_id as any,
				kind: "narrate",
				body: `line ${i}`,
				salience: "medium",
			});
			await new Promise((r) => setTimeout(r, 5));
		}
		const tk = await asSession(t, owner_id as unknown as string);
		const rows = await t.query(api.events.eventsAtLocation, {
			session_token: tk,
			world_slug: "ev-b",
			location_id: location_id as any,
			limit: 2,
		});
		expect(rows).toHaveLength(2);
		// Newest first.
		expect(rows[0].body).toBe("line 3");
		expect(rows[1].body).toBe("line 2");
	});

	test("min_salience filters correctly", async () => {
		const t = convexTest(schema, modules);
		const { owner_id, world_id, branch_id, character_id, npc_id } =
			await seedWorld(t, { slug: "ev-c", owner_email: "ev-c@example.com" });
		await t.mutation(internal.events.writeEvent, {
			world_id: world_id as any,
			branch_id: branch_id as any,
			character_id: character_id as any,
			npc_entity_id: npc_id as any,
			kind: "dialogue",
			body: "low salience line",
			salience: "low",
		});
		await t.mutation(internal.events.writeEvent, {
			world_id: world_id as any,
			branch_id: branch_id as any,
			character_id: character_id as any,
			npc_entity_id: npc_id as any,
			kind: "dialogue",
			body: "high salience line",
			salience: "high",
		});
		const tk = await asSession(t, owner_id as unknown as string);
		const all = await t.query(api.events.eventsForNpc, {
			session_token: tk,
			world_slug: "ev-c",
			npc_entity_id: npc_id as any,
		});
		expect(all).toHaveLength(2);
		const onlyHigh = await t.query(api.events.eventsForNpc, {
			session_token: tk,
			world_slug: "ev-c",
			npc_entity_id: npc_id as any,
			min_salience: "high",
		});
		expect(onlyHigh).toHaveLength(1);
		expect(onlyHigh[0].body).toContain("high salience");
	});

	test("eventsForCharacterNpc returns the us-together slab", async () => {
		const t = convexTest(schema, modules);
		const { owner_id, world_id, branch_id, character_id, npc_id } =
			await seedWorld(t, { slug: "ev-d", owner_email: "ev-d@example.com" });
		// Some events with this NPC, some without.
		await t.mutation(internal.events.writeEvent, {
			world_id: world_id as any,
			branch_id: branch_id as any,
			character_id: character_id as any,
			npc_entity_id: npc_id as any,
			kind: "dialogue",
			body: "with mara",
			salience: "medium",
		});
		await t.mutation(internal.events.writeEvent, {
			world_id: world_id as any,
			branch_id: branch_id as any,
			character_id: character_id as any,
			kind: "narrate",
			body: "alone in the woods",
			salience: "medium",
		});
		const tk = await asSession(t, owner_id as unknown as string);
		const r = await t.query(api.events.eventsForCharacterNpc, {
			session_token: tk,
			world_slug: "ev-d",
			character_id: character_id as any,
			npc_entity_id: npc_id as any,
		});
		expect(r).toHaveLength(1);
		expect(r[0].body).toContain("mara");
	});
});

describe("events — isolation", () => {
	test("non-member cannot read events", async () => {
		const t = convexTest(schema, modules);
		const { world_id, branch_id, character_id, location_id } = await seedWorld(
			t,
			{ slug: "ev-e", owner_email: "ev-e@example.com" },
		);
		await t.mutation(internal.events.writeEvent, {
			world_id: world_id as any,
			branch_id: branch_id as any,
			character_id: character_id as any,
			location_id: location_id as any,
			kind: "narrate",
			body: "secret",
			salience: "medium",
		});
		const stranger = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				email: "stranger@example.com",
				is_minor: false,
				guardian_user_ids: [],
				created_at: Date.now(),
			}),
		);
		const tk = await asSession(t, stranger as unknown as string);
		await expect(
			t.query(api.events.eventsAtLocation, {
				session_token: tk,
				world_slug: "ev-e",
				location_id: location_id as any,
			}),
		).rejects.toThrow(/forbidden|not a member/);
	});
});

describe("setAiQuality", () => {
	test("owner sets and clears quality preset", async () => {
		const t = convexTest(schema, modules);
		const { owner_id } = await seedWorld(t, {
			slug: "aq-a",
			owner_email: "aq-a@example.com",
		});
		const tk = await asSession(t, owner_id as unknown as string);
		await t.mutation(api.worlds.setAiQuality, {
			session_token: tk,
			world_slug: "aq-a",
			quality: "best",
		});
		await t.run(async (ctx) => {
			const w = await ctx.db
				.query("worlds")
				.withIndex("by_slug", (q: any) => q.eq("slug", "aq-a"))
				.first();
			expect(w!.ai_quality).toBe("best");
		});
		await t.mutation(api.worlds.setAiQuality, {
			session_token: tk,
			world_slug: "aq-a",
			quality: null,
		});
		await t.run(async (ctx) => {
			const w = await ctx.db
				.query("worlds")
				.withIndex("by_slug", (q: any) => q.eq("slug", "aq-a"))
				.first();
			expect(w!.ai_quality).toBeUndefined();
		});
	});

	test("non-owner cannot set quality", async () => {
		const t = convexTest(schema, modules);
		const { world_id } = await seedWorld(t, {
			slug: "aq-b",
			owner_email: "aq-b@example.com",
		});
		const player = await t.run(async (ctx) => {
			const u = await ctx.db.insert("users", {
				email: "aq-b-player@example.com",
				is_minor: false,
				guardian_user_ids: [],
				created_at: Date.now(),
			});
			await ctx.db.insert("world_memberships", {
				world_id: world_id as any,
				user_id: u,
				role: "player",
				created_at: Date.now(),
			});
			return u as unknown as string;
		});
		const tk = await asSession(t, player);
		await expect(
			t.mutation(api.worlds.setAiQuality, {
				session_token: tk,
				world_slug: "aq-b",
				quality: "fast",
			}),
		).rejects.toThrow(/forbidden|owner/);
	});
});
