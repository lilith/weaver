<script lang="ts">
	import { enhance } from '$app/forms';
	let { data, form } = $props();
	let feedback = $state('');
	let pending = $state(false);
</script>

<section class="space-y-8 py-6">
	<header class="space-y-2">
		<p class="font-hand text-base text-candle-300">code admin — ai feedback</p>
		<h1 class="font-display text-3xl text-mist-100 sm:text-4xl">
			{data.world.name}
		</h1>
		<p class="text-sm text-mist-400">
			For structural changes Weaver can't do with tuning alone. Opus drafts a
			plan; you open a GitHub issue assigned to Lilith. No runtime code
			execution — the plan is a brief for a human + agent to implement via a
			normal PR.
		</p>
		{#if !data.flag.enabled}
			<p class="rounded border border-amber-500/50 bg-amber-950/40 p-3 text-sm text-amber-200">
				⚠ <code>flag.code_proposals</code> is off for this world. Enable it in
				<a href="/admin/{data.world.slug}" class="underline">admin settings</a>
				before proposing.
			</p>
		{/if}
	</header>

	<form
		method="POST"
		action="?/suggest"
		class="space-y-3"
		use:enhance={() => {
			pending = true;
			return async ({ update }) => {
				await update({ reset: false });
				pending = false;
			};
		}}
	>
		<label class="block space-y-1">
			<span class="font-hand text-base text-candle-300">
				what should change?
			</span>
			<textarea
				name="feedback"
				rows="4"
				maxlength="2500"
				bind:value={feedback}
				placeholder="e.g. combat should have a 'block' option that reduces incoming damage for one turn; or: add a cooking module with recipes pulled from the bible; or: the map should show weather per region"
				class="storybook-input w-full"
				required
			></textarea>
		</label>
		<button
			type="submit"
			class="storybook-button"
			disabled={pending || feedback.trim().length < 4}
		>
			{pending ? 'Drafting a plan…' : '✧ Draft a plan'}
		</button>
	</form>

	{#if form?.error}
		<p class="text-sm text-rose-400">{form.error}</p>
	{/if}

	{#if form?.suggestion}
		<section class="story-card space-y-4 px-6 py-5">
			<div>
				<p class="font-hand text-2xl text-candle-300">
					{form.suggestion.plan.title}
				</p>
				<p class="mt-1 text-xs uppercase tracking-wide text-mist-500">
					estimated size: {form.suggestion.plan.estimated_size}
				</p>
			</div>
			<p class="text-sm text-mist-300">{form.suggestion.plan.summary}</p>
			{#if form.suggestion.plan.rationale}
				<p class="text-xs text-mist-400">{form.suggestion.plan.rationale}</p>
			{/if}

			{#if form.suggestion.plan.suggested_changes?.length > 0}
				<div>
					<p class="text-xs uppercase tracking-wide text-mist-500">
						suggested changes
					</p>
					<ul class="mt-2 space-y-1 text-sm">
						{#each form.suggestion.plan.suggested_changes as c (c.file)}
							<li>
								<code class="font-mono text-xs text-candle-300">{c.file}</code>
								<span class="text-mist-300"> — {c.what}</span>
							</li>
						{/each}
					</ul>
				</div>
			{/if}

			{#if form.suggestion.plan.new_tests?.length > 0}
				<div>
					<p class="text-xs uppercase tracking-wide text-mist-500">new tests</p>
					<ul class="mt-2 space-y-1 text-sm text-mist-300">
						{#each form.suggestion.plan.new_tests as t (t)}
							<li>☐ {t}</li>
						{/each}
					</ul>
				</div>
			{/if}

			{#if form.suggestion.plan.open_questions?.length > 0}
				<div>
					<p class="text-xs uppercase tracking-wide text-mist-500">
						open questions
					</p>
					<ul class="mt-2 space-y-1 text-sm text-mist-300">
						{#each form.suggestion.plan.open_questions as q (q)}
							<li>• {q}</li>
						{/each}
					</ul>
				</div>
			{/if}

			<div class="flex gap-3 pt-2 items-center flex-wrap">
				<form method="POST" action="?/open" use:enhance style="display:inline">
					<input
						type="hidden"
						name="proposal_id"
						value={form.suggestion.proposal_id}
					/>
					<button type="submit" class="storybook-button">
						✧ open github issue
					</button>
				</form>
				<form method="POST" action="?/dismiss" use:enhance style="display:inline">
					<input
						type="hidden"
						name="proposal_id"
						value={form.suggestion.proposal_id}
					/>
					<button
						type="submit"
						class="text-sm text-mist-500 hover:text-mist-300"
					>
						dismiss
					</button>
				</form>
			</div>
		</section>
	{/if}

	{#if form?.opened}
		<p class="font-hand text-base text-candle-300">
			✨ issue opened —
			<a
				href={form.opened.url}
				target="_blank"
				rel="noopener"
				class="underline hover:text-candle-200"
			>
				#{form.opened.number}
			</a>. Lilith will pick it up.
		</p>
	{/if}
	{#if form?.dismissed}
		<p class="font-hand text-base text-mist-400">dismissed.</p>
	{/if}

	{#if data.proposals.length > 0}
		<section class="space-y-3">
			<p class="font-hand text-2xl text-candle-300">recent proposals</p>
			<ul class="space-y-2">
				{#each data.proposals as p (p._id)}
					<li class="story-card px-4 py-3 text-sm space-y-1">
						<div class="flex gap-3 items-center flex-wrap">
							<span
								class="font-hand text-xs"
								class:text-teal-300={p.status === 'opened'}
								class:text-mist-500={p.status === 'dismissed' ||
									p.status === 'closed'}
								class:text-candle-300={p.status === 'draft'}
							>
								{p.status}
							</span>
							<span class="text-xs text-mist-500">
								{new Date(p.created_at).toLocaleDateString()}
							</span>
							{#if p.github_issue_number}
								<a
									href={p.github_issue_url}
									target="_blank"
									rel="noopener"
									class="text-xs text-candle-300 underline hover:text-candle-200"
								>
									#{p.github_issue_number}
								</a>
							{/if}
							<span class="ml-auto font-mono text-xs text-mist-500">
								{p.plan_json?.estimated_size ?? '—'}
							</span>
						</div>
						{#if p.plan_json?.title}
							<p class="font-hand text-base text-mist-200">{p.plan_json.title}</p>
						{/if}
						<p class="text-mist-300">{p.feedback_text}</p>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	<nav class="pt-4 text-sm text-mist-500">
		<a href="/admin/{data.world.slug}" class="hover:text-candle-300">← admin</a>
	</nav>
</section>
