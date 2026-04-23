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
		throw error(403, "module proposals are owner-only");
	const [modules, proposals, flag] = await Promise.all([
		client.query(api.module_proposals.listModules, {
			session_token: locals.session_token,
			world_slug: params.world_slug,
		}),
		client.query(api.module_proposals.listProposals, {
			session_token: locals.session_token,
			world_slug: params.world_slug,
			limit: 30,
		}),
		client.query(api.flags.resolve, {
			session_token: locals.session_token,
			flag_key: "flag.module_overrides",
			world_slug: params.world_slug,
		}),
	]);
	return { world, modules: modules.modules, proposals, flag };
};

export const actions: Actions = {
	suggest: async ({ params, request, locals }) => {
		if (!locals.session_token) return fail(401, { error: "not signed in" });
		const form = await request.formData();
		const module_name = String(form.get("module_name") ?? "").trim();
		const feedback = String(form.get("feedback") ?? "").trim();
		if (!module_name) return fail(400, { error: "module_name required" });
		if (feedback.length < 4)
			return fail(400, { error: "tell me more (a sentence at least)" });
		const client = convexServer();
		try {
			const r = await client.action(api.module_proposals.suggestModuleEdit, {
				session_token: locals.session_token,
				world_slug: params.world_slug,
				module_name,
				feedback,
			});
			return {
				suggestion: {
					proposal_id: r.proposal_id,
					module_name: r.module_name,
					current_overrides: r.current_overrides,
					suggested_overrides: r.suggested_overrides,
					rationale: r.rationale,
					current_version: r.current_version,
					slots: r.slots,
					feedback,
				},
			};
		} catch (e) {
			return fail(500, { error: (e as Error).message });
		}
	},
	apply: async ({ params, request, locals }) => {
		if (!locals.session_token) return fail(401, { error: "not signed in" });
		const form = await request.formData();
		const proposal_id = String(form.get("proposal_id") ?? "");
		if (!proposal_id) return fail(400, { error: "proposal_id required" });
		const client = convexServer();
		try {
			const r = await client.mutation(api.module_proposals.applyModuleEdit, {
				session_token: locals.session_token,
				world_slug: params.world_slug,
				proposal_id: proposal_id as any,
			});
			return { applied: { module_name: r.module_name, version: r.version } };
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
			await client.mutation(api.module_proposals.dismissModuleProposal, {
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
