// Integration tests for stats.ts via convex-test. Covers:
//   - getStatSchema returns null when none set; member-readable
//   - applyStatSchema owner-gated; sanitizes unknown canonical keys
//   - resetStatSchema clears the field
//   - non-member reads forbidden; non-owner mutations forbidden

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
		await ctx.db.insert("world_memberships", {
			world_id,
			user_id: owner_id,
			role: "owner",
			created_at: Date.now(),
		});
		return { owner_id, world_id };
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

describe("stat_schema — apply + read", () => {
	test("getStatSchema returns null when none set", async () => {
		const t = convexTest(schema, modules);
		const { owner_id } = await seedWorld(t, {
			slug: "ss-a",
			owner_email: "ss-a@example.com",
		});
		const tk = await asSession(t, owner_id as unknown as string);
		const r = await t.query(api.stats.getStatSchema, {
			session_token: tk,
			world_slug: "ss-a",
		});
		expect(r).not.toBeNull();
		expect(r!.schema).toBeNull();
	});

	test("applyStatSchema accepts a sane schema and persists", async () => {
		const t = convexTest(schema, modules);
		const { owner_id } = await seedWorld(t, {
			slug: "ss-b",
			owner_email: "ss-b@example.com",
		});
		const tk = await asSession(t, owner_id as unknown as string);
		await t.mutation(api.stats.applyStatSchema, {
			session_token: tk,
			world_slug: "ss-b",
			schema_json: JSON.stringify({
				canonical: {
					hp: { label: "wellbeing", format: "fraction", max: 10 },
					gold: { hidden: true },
				},
				inventory_label: "in your pocket",
				preset: "cozy",
			}),
		});
		const r = await t.query(api.stats.getStatSchema, {
			session_token: tk,
			world_slug: "ss-b",
		});
		expect(r!.schema!.canonical!.hp!.label).toBe("wellbeing");
		expect(r!.schema!.canonical!.gold!.hidden).toBe(true);
		expect(r!.schema!.preset).toBe("cozy");
		expect(r!.schema!.inventory_label).toBe("in your pocket");
	});

	test("apply drops unknown canonical keys silently", async () => {
		const t = convexTest(schema, modules);
		const { owner_id } = await seedWorld(t, {
			slug: "ss-c",
			owner_email: "ss-c@example.com",
		});
		const tk = await asSession(t, owner_id as unknown as string);
		await t.mutation(api.stats.applyStatSchema, {
			session_token: tk,
			world_slug: "ss-c",
			schema_json: JSON.stringify({
				canonical: {
					hp: { label: "vitality" },
					xp: { label: "experience" }, // engine doesn't know xp
				},
			}),
		});
		const r = await t.query(api.stats.getStatSchema, {
			session_token: tk,
			world_slug: "ss-c",
		});
		expect(r!.schema!.canonical!.hp!.label).toBe("vitality");
		expect((r!.schema!.canonical as any).xp).toBeUndefined();
	});

	test("resetStatSchema clears the field", async () => {
		const t = convexTest(schema, modules);
		const { owner_id } = await seedWorld(t, {
			slug: "ss-d",
			owner_email: "ss-d@example.com",
		});
		const tk = await asSession(t, owner_id as unknown as string);
		await t.mutation(api.stats.applyStatSchema, {
			session_token: tk,
			world_slug: "ss-d",
			schema_json: JSON.stringify({ canonical: { hp: { label: "hp!" } } }),
		});
		await t.mutation(api.stats.resetStatSchema, {
			session_token: tk,
			world_slug: "ss-d",
		});
		const r = await t.query(api.stats.getStatSchema, {
			session_token: tk,
			world_slug: "ss-d",
		});
		expect(r!.schema).toBeNull();
	});
});

describe("stat_schema — isolation", () => {
	test("non-member cannot read schema", async () => {
		const t = convexTest(schema, modules);
		await seedWorld(t, {
			slug: "ss-e",
			owner_email: "ss-e@example.com",
		});
		const stranger = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				email: "outsider@example.com",
				is_minor: false,
				guardian_user_ids: [],
				created_at: Date.now(),
			}),
		);
		const tk = await asSession(t, stranger as unknown as string);
		await expect(
			t.query(api.stats.getStatSchema, {
				session_token: tk,
				world_slug: "ss-e",
			}),
		).rejects.toThrow(/forbidden|not a member/);
	});

	test("non-owner member cannot apply", async () => {
		const t = convexTest(schema, modules);
		const { world_id } = await seedWorld(t, {
			slug: "ss-f",
			owner_email: "ss-f@example.com",
		});
		const player = await t.run(async (ctx) => {
			const u = await ctx.db.insert("users", {
				email: "ss-f-player@example.com",
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
			t.mutation(api.stats.applyStatSchema, {
				session_token: tk,
				world_slug: "ss-f",
				schema_json: JSON.stringify({ canonical: { hp: { label: "x" } } }),
			}),
		).rejects.toThrow(/forbidden|owner/);
	});
});
