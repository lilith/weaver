// Integration tests for event_summaries — verifies the storage + read
// path. The Sonnet/Haiku actions themselves aren't tested here (they
// hit Anthropic); we directly call writeSummary + latestSummariesFor.

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
			state: {},
			schema_version: 1,
			created_at: Date.now(),
			updated_at: Date.now(),
		});
		return { owner_id, world_id, branch_id, character_id };
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

describe("event_summaries — storage + read", () => {
	test("latestSummariesFor returns null/null on a fresh world", async () => {
		const t = convexTest(schema, modules);
		const { owner_id, character_id } = await seedWorld(t, {
			slug: "es-a",
			owner_email: "es-a@example.com",
		});
		const tk = await asSession(t, owner_id as unknown as string);
		const r = await t.query(api.event_summaries.latestSummariesFor, {
			session_token: tk,
			world_slug: "es-a",
			character_id: character_id as any,
		});
		expect(r).toEqual({ rebuild: null, delta: null });
	});

	test("most-recent rebuild + delta returned (delta only when newer)", async () => {
		const t = convexTest(schema, modules);
		const { owner_id, world_id, branch_id, character_id } = await seedWorld(t, {
			slug: "es-b",
			owner_email: "es-b@example.com",
		});
		await t.mutation(internal.event_summaries.writeSummary, {
			world_id: world_id as any,
			branch_id: branch_id as any,
			character_id: character_id as any,
			kind: "rebuild",
			body: "rebuild v1 — the chimes never stop, mara cried when the cat came back",
			covers_until_turn: 50,
			model: "claude-sonnet-4-6",
		});
		await new Promise((r) => setTimeout(r, 5));
		await t.mutation(internal.event_summaries.writeSummary, {
			world_id: world_id as any,
			branch_id: branch_id as any,
			character_id: character_id as any,
			kind: "delta",
			body: "delta — three days later, fog at the well",
			covers_until_turn: 60,
			model: "claude-haiku-4-5-20251001",
		});
		const tk = await asSession(t, owner_id as unknown as string);
		const r = await t.query(api.event_summaries.latestSummariesFor, {
			session_token: tk,
			world_slug: "es-b",
			character_id: character_id as any,
		});
		expect(r!.rebuild!.body).toContain("rebuild v1");
		expect(r!.rebuild!.covers_until_turn).toBe(50);
		expect(r!.delta!.body).toContain("delta");
		expect(r!.delta!.covers_until_turn).toBe(60);
	});

	test("delta is suppressed when rebuild is newer (post-rebuild flush)", async () => {
		const t = convexTest(schema, modules);
		const { owner_id, world_id, branch_id, character_id } = await seedWorld(t, {
			slug: "es-c",
			owner_email: "es-c@example.com",
		});
		// First a delta...
		await t.mutation(internal.event_summaries.writeSummary, {
			world_id: world_id as any,
			branch_id: branch_id as any,
			character_id: character_id as any,
			kind: "delta",
			body: "delta — old",
			covers_until_turn: 30,
			model: "claude-haiku-4-5-20251001",
		});
		await new Promise((r) => setTimeout(r, 5));
		// ...then a fresh rebuild that supersedes it.
		await t.mutation(internal.event_summaries.writeSummary, {
			world_id: world_id as any,
			branch_id: branch_id as any,
			character_id: character_id as any,
			kind: "rebuild",
			body: "rebuild — fresh",
			covers_until_turn: 50,
			model: "claude-sonnet-4-6",
		});
		const tk = await asSession(t, owner_id as unknown as string);
		const r = await t.query(api.event_summaries.latestSummariesFor, {
			session_token: tk,
			world_slug: "es-c",
			character_id: character_id as any,
		});
		expect(r!.rebuild!.body).toContain("fresh");
		expect(r!.delta).toBeNull(); // older delta is dropped
	});

	test("non-member cannot read summaries (isolation)", async () => {
		const t = convexTest(schema, modules);
		const { character_id, world_id, branch_id } = await seedWorld(t, {
			slug: "es-d",
			owner_email: "es-d@example.com",
		});
		await t.mutation(internal.event_summaries.writeSummary, {
			world_id: world_id as any,
			branch_id: branch_id as any,
			character_id: character_id as any,
			kind: "rebuild",
			body: "secret memory",
			covers_until_turn: 1,
			model: "claude-sonnet-4-6",
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
			t.query(api.event_summaries.latestSummariesFor, {
				session_token: tk,
				world_slug: "es-d",
				character_id: character_id as any,
			}),
		).rejects.toThrow(/forbidden|not a member/);
	});

	test("triggerRebuild is owner-only", async () => {
		const t = convexTest(schema, modules);
		const { world_id, character_id } = await seedWorld(t, {
			slug: "es-e",
			owner_email: "es-e@example.com",
		});
		const player = await t.run(async (ctx) => {
			const u = await ctx.db.insert("users", {
				email: "es-e-player@example.com",
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
			t.mutation(api.event_summaries.triggerRebuild, {
				session_token: tk,
				world_slug: "es-e",
				character_id: character_id as any,
			}),
		).rejects.toThrow(/forbidden|owner/);
	});
});
