// Integration tests for module_proposals end-to-end, using convex-test
// against the in-memory backend. No network, no LLM — we stub the
// suggestion step by calling writeProposal directly, then exercise
// applyModuleEdit and dismissModuleProposal to verify:
//
//   - optimistic concurrency (version bumps; stale expected_version rejected)
//   - owner-only gate (non-owner cannot apply)
//   - cross-world isolation (apply against wrong world rejected)
//   - status transitions (draft → applied | dismissed; cannot re-apply)
//   - activeOverridesForRun returns what we wrote
//
// Uses convex-test's `.run` to seed schema state directly, which keeps
// the tests focused on the application-layer logic rather than the
// full auth/seed plumbing.

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
		await ctx.db.insert("world_memberships", {
			world_id,
			user_id: owner_id,
			role: "owner",
			created_at: Date.now(),
		});
		// Turn on flag.module_overrides for this world so apply paths
		// don't short-circuit.
		await ctx.db.insert("feature_flags", {
			flag_key: "flag.module_overrides",
			scope_kind: "world",
			scope_id: world_id as unknown as string,
			enabled: true,
			set_at: Date.now(),
		});
		return { owner_id, world_id };
	});
}

async function seedNonOwner(
	t: ReturnType<typeof convexTest>,
	email: string,
): Promise<string> {
	return await t.run(async (ctx) => {
		return (await ctx.db.insert("users", {
			email,
			is_minor: false,
			guardian_user_ids: [],
			created_at: Date.now(),
		})) as unknown as string;
	});
}

async function asSession(
	t: ReturnType<typeof convexTest>,
	user_id: string,
): Promise<string> {
	// hashString in blobs uses sha256 — don't reinvent; use dev sign-in
	// equivalent by inserting a session row directly with a token hash
	// we can reproduce.
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

describe("module_proposals — apply + isolation", () => {
	test("writeProposal → applyModuleEdit increments version", async () => {
		const t = convexTest(schema, modules);
		const { owner_id, world_id } = await seedWorld(t, {
			slug: "iso-a",
			owner_email: "a@example.com",
		});
		const token = await asSession(t, owner_id as unknown as string);

		// Seed a proposal directly (skip the Opus action).
		const proposal_id = await t.mutation(
			internal.module_proposals.writeProposal,
			{
				world_id: world_id as any,
				module_name: "counter",
				feedback_text: "raise the default target",
				current_overrides_snapshot: {},
				suggested_overrides: { default_target: 9 },
				rationale: "unit test",
				expected_version: 0,
				author_user_id: owner_id as any,
			},
		);

		const out = await t.mutation(api.module_proposals.applyModuleEdit, {
			session_token: token,
			world_slug: "iso-a",
			proposal_id,
		});
		expect(out).toEqual({ version: 1, module_name: "counter" });

		// Runtime resolver sees the applied value.
		const resolved = await t.query(internal.flows.activeOverridesForRun, {
			world_id: world_id as any,
			module_name: "counter",
		});
		expect(resolved).toEqual({
			overrides: { default_target: 9 },
			version: 1,
		});
	});

	test("stale expected_version is rejected", async () => {
		const t = convexTest(schema, modules);
		const { owner_id, world_id } = await seedWorld(t, {
			slug: "iso-b",
			owner_email: "b@example.com",
		});
		const token = await asSession(t, owner_id as unknown as string);

		// First apply bumps version to 1.
		const p1 = await t.mutation(internal.module_proposals.writeProposal, {
			world_id: world_id as any,
			module_name: "counter",
			feedback_text: "first",
			current_overrides_snapshot: {},
			suggested_overrides: { default_target: 7 },
			rationale: "test",
			expected_version: 0,
			author_user_id: owner_id as any,
		});
		await t.mutation(api.module_proposals.applyModuleEdit, {
			session_token: token,
			world_slug: "iso-b",
			proposal_id: p1,
		});

		// Second proposal was drafted BEFORE the first applied → stale.
		const p2 = await t.mutation(internal.module_proposals.writeProposal, {
			world_id: world_id as any,
			module_name: "counter",
			feedback_text: "second, drafted stale",
			current_overrides_snapshot: {},
			suggested_overrides: { default_target: 15 },
			rationale: "test",
			expected_version: 0, // stale!
			author_user_id: owner_id as any,
		});
		await expect(
			t.mutation(api.module_proposals.applyModuleEdit, {
				session_token: token,
				world_slug: "iso-b",
				proposal_id: p2,
			}),
		).rejects.toThrow(/version changed/);
	});

	test("non-owner member cannot apply (URGENT rule 7)", async () => {
		const t = convexTest(schema, modules);
		const { owner_id, world_id } = await seedWorld(t, {
			slug: "iso-c",
			owner_email: "c@example.com",
		});

		// Add a family_mod member B — still NOT the owner.
		const b_id = await seedNonOwner(t, "b@example.com");
		await t.run(async (ctx) => {
			await ctx.db.insert("world_memberships", {
				world_id: world_id as any,
				user_id: b_id as any,
				role: "family_mod",
				created_at: Date.now(),
			});
		});
		const tokenB = await asSession(t, b_id);

		const proposal_id = await t.mutation(
			internal.module_proposals.writeProposal,
			{
				world_id: world_id as any,
				module_name: "counter",
				feedback_text: "try me",
				current_overrides_snapshot: {},
				suggested_overrides: { default_target: 99 },
				rationale: "test",
				expected_version: 0,
				author_user_id: owner_id as any,
			},
		);

		await expect(
			t.mutation(api.module_proposals.applyModuleEdit, {
				session_token: tokenB,
				world_slug: "iso-c",
				proposal_id,
			}),
		).rejects.toThrow(/forbidden/);
	});

	test("user outside the world cannot apply (isolation)", async () => {
		const t = convexTest(schema, modules);
		const { owner_id, world_id } = await seedWorld(t, {
			slug: "iso-d",
			owner_email: "d@example.com",
		});
		// User B isn't a member at all.
		const b_id = await seedNonOwner(t, "outsider@example.com");
		const tokenB = await asSession(t, b_id);

		const proposal_id = await t.mutation(
			internal.module_proposals.writeProposal,
			{
				world_id: world_id as any,
				module_name: "counter",
				feedback_text: "try me",
				current_overrides_snapshot: {},
				suggested_overrides: { default_target: 99 },
				rationale: "test",
				expected_version: 0,
				author_user_id: owner_id as any,
			},
		);

		await expect(
			t.mutation(api.module_proposals.applyModuleEdit, {
				session_token: tokenB,
				world_slug: "iso-d",
				proposal_id,
			}),
		).rejects.toThrow(/forbidden|not a member/);
	});

	test("cannot dismiss an already-applied proposal", async () => {
		const t = convexTest(schema, modules);
		const { owner_id, world_id } = await seedWorld(t, {
			slug: "iso-e",
			owner_email: "e@example.com",
		});
		const token = await asSession(t, owner_id as unknown as string);
		const proposal_id = await t.mutation(
			internal.module_proposals.writeProposal,
			{
				world_id: world_id as any,
				module_name: "counter",
				feedback_text: "apply then dismiss",
				current_overrides_snapshot: {},
				suggested_overrides: { default_target: 3 },
				rationale: "test",
				expected_version: 0,
				author_user_id: owner_id as any,
			},
		);
		await t.mutation(api.module_proposals.applyModuleEdit, {
			session_token: token,
			world_slug: "iso-e",
			proposal_id,
		});
		await expect(
			t.mutation(api.module_proposals.dismissModuleProposal, {
				session_token: token,
				world_slug: "iso-e",
				proposal_id,
			}),
		).rejects.toThrow(/already|applied/);
	});

	test("apply rejects values that fail slot validation", async () => {
		const t = convexTest(schema, modules);
		const { owner_id, world_id } = await seedWorld(t, {
			slug: "iso-f",
			owner_email: "f@example.com",
		});
		const token = await asSession(t, owner_id as unknown as string);
		// max is 1000 per the counter slot; 5000 should fail at apply.
		const proposal_id = await t.mutation(
			internal.module_proposals.writeProposal,
			{
				world_id: world_id as any,
				module_name: "counter",
				feedback_text: "too big",
				current_overrides_snapshot: {},
				suggested_overrides: { default_target: 5000 },
				rationale: "test",
				expected_version: 0,
				author_user_id: owner_id as any,
			},
		);
		await expect(
			t.mutation(api.module_proposals.applyModuleEdit, {
				session_token: token,
				world_slug: "iso-f",
				proposal_id,
			}),
		).rejects.toThrow(/maximum/);
	});

	test("activeOverridesForRun returns empty when no row exists", async () => {
		const t = convexTest(schema, modules);
		const { world_id } = await seedWorld(t, {
			slug: "iso-g",
			owner_email: "g@example.com",
		});
		const out = await t.query(internal.flows.activeOverridesForRun, {
			world_id: world_id as any,
			module_name: "combat",
		});
		expect(out).toEqual({ overrides: {}, version: 0 });
	});
});

describe("code_proposals — dismiss + isolation", () => {
	test("non-owner cannot dismiss another world's proposal", async () => {
		const t = convexTest(schema, modules);
		const { owner_id: owner_a, world_id: world_a } = await seedWorld(t, {
			slug: "code-a",
			owner_email: "code-a@example.com",
		});
		const b_id = await seedNonOwner(t, "code-b@example.com");
		const tokenB = await asSession(t, b_id);

		// Seed a code proposal owned by A.
		const proposal_id = await t.mutation(
			internal.code_proposals.writeCodeProposal,
			{
				world_id: world_a as any,
				feedback_text: "something",
				plan_json: {
					title: "x",
					summary: "y",
					suggested_changes: [],
					new_tests: [],
					open_questions: [],
					estimated_size: "small",
				},
				author_user_id: owner_a as any,
			},
		);

		// B isn't a member of A's world → forbidden.
		await expect(
			t.mutation(api.code_proposals.dismissCodeProposal, {
				session_token: tokenB,
				world_slug: "code-a",
				proposal_id,
			}),
		).rejects.toThrow(/forbidden|not a member/);
	});

	test("owner can dismiss their own draft proposal", async () => {
		const t = convexTest(schema, modules);
		const { owner_id, world_id } = await seedWorld(t, {
			slug: "code-c",
			owner_email: "code-c@example.com",
		});
		const token = await asSession(t, owner_id as unknown as string);
		const proposal_id = await t.mutation(
			internal.code_proposals.writeCodeProposal,
			{
				world_id: world_id as any,
				feedback_text: "drop me",
				plan_json: {
					title: "x",
					summary: "y",
					suggested_changes: [],
					new_tests: [],
					open_questions: [],
					estimated_size: "small",
				},
				author_user_id: owner_id as any,
			},
		);
		const r = await t.mutation(api.code_proposals.dismissCodeProposal, {
			session_token: token,
			world_slug: "code-c",
			proposal_id,
		});
		expect(r).toEqual({ ok: true });
	});
});
