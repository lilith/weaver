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
	if (world.role !== "owner")
		throw error(403, "code proposals are owner-only");
	const [proposals, flag] = await Promise.all([
		client.query(api.code_proposals.listProposals, {
			session_token: locals.session_token,
			world_slug: params.world_slug,
			limit: 30,
		}),
		client.query(api.flags.resolve, {
			session_token: locals.session_token,
			flag_key: "flag.code_proposals",
			world_slug: params.world_slug,
		}),
	]);
	return { world, proposals, flag };
};

export const actions: Actions = {
	suggest: async ({ params, request, locals }) => {
		if (!locals.session_token) return fail(401, { error: "not signed in" });
		const form = await request.formData();
		const feedback = String(form.get("feedback") ?? "").trim();
		if (feedback.length < 4)
			return fail(400, { error: "tell me more (a sentence at least)" });
		const client = convexServer();
		try {
			const r = await client.action(api.code_proposals.suggestCodeChange, {
				session_token: locals.session_token,
				world_slug: params.world_slug,
				feedback,
			});
			return {
				suggestion: {
					proposal_id: r.proposal_id,
					plan: r.plan,
					feedback,
				},
			};
		} catch (e) {
			return fail(500, { error: (e as Error).message });
		}
	},
	open: async ({ params, request, locals }) => {
		if (!locals.session_token) return fail(401, { error: "not signed in" });
		const form = await request.formData();
		const proposal_id = String(form.get("proposal_id") ?? "");
		if (!proposal_id) return fail(400, { error: "proposal_id required" });
		const client = convexServer();
		try {
			const r = await client.action(api.code_proposals.openCodeIssue, {
				session_token: locals.session_token,
				world_slug: params.world_slug,
				proposal_id: proposal_id as any,
			});
			return {
				opened: {
					number: r.github_issue_number,
					url: r.github_issue_url,
				},
			};
		} catch (e) {
			return fail(500, { error: (e as Error).message });
		}
	},
	dismiss: async ({ params, request, locals }) => {
		if (!locals.session_token) return fail(401, { error: "not signed in" });
		const form = await request.formData();
		const proposal_id = String(form.get("proposal_id") ?? "");
		if (!proposal_id) return fail(400, { error: "proposal_id required" });
		const client = convexServer();
		try {
			await client.mutation(api.code_proposals.dismissCodeProposal, {
				session_token: locals.session_token,
				world_slug: params.world_slug,
				proposal_id: proposal_id as any,
			});
			return { dismissed: true };
		} catch (e) {
			return fail(500, { error: (e as Error).message });
		}
	},
};
