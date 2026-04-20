<script lang="ts">
	import { enhance } from '$app/forms';
	let { data, form } = $props();
	let feedback = $state('');
	let pending = $state(false);

	function fieldDiff(
		a: Record<string, unknown> | null | undefined,
		b: Record<string, unknown> | null | undefined
	): string[] {
		const out: string[] = [];
		const keys = new Set([
			...Object.keys(a ?? {}),
			...Object.keys(b ?? {})
		]);
		for (const k of keys) {
			const av = JSON.stringify(a?.[k]);
			const bv = JSON.stringify(b?.[k]);
			if (av !== bv) out.push(k);
		}
		return out;
	}

	const changedFields = $derived(
		form?.suggestion
			? fieldDiff(
					form.suggestion.current as any,
					form.suggestion.suggested as any
				)
			: []
	);
</script>

<section class="space-y-8 py-6">
	<header class="space-y-2">
		<p class="font-hand text-base text-candle-300">bible admin — ai feedback</p>
		<h1 class="font-display text-3xl text-mist-100 sm:text-4xl">
			{data.world.name}
		</h1>
		<p class="text-sm text-mist-400">
			Write what you want tuned about the world. Opus will propose a minimal
			diff — preserving established facts, taboos, and voice — and you approve
			before anything writes.
		</p>
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
				rows="3"
				maxlength="1500"
				bind:value={feedback}
				placeholder="e.g. make the tone a bit spookier; add 'fog after dusk' to established facts; forbid named real-world brands"
				class="storybook-input w-full"
				required
			></textarea>
		</label>
		<button
			type="submit"
			class="storybook-button"
			disabled={pending || feedback.trim().length < 4}
		>
			{pending ? 'Weaving a suggestion…' : '✧ Suggest an edit'}
		</button>
	</form>

	{#if form?.error}
		<p class="text-sm text-rose-400">{form.error}</p>
	{/if}

	{#if form?.suggestion}
		<section class="story-card space-y-4 px-6 py-5">
			<div class="space-y-1">
				<p class="font-hand text-2xl text-candle-300">ai suggestion</p>
				<p class="text-sm text-mist-400">{form.suggestion.rationale}</p>
			</div>

			{#if changedFields.length === 0}
				<p class="font-hand text-base text-mist-500">(no fields changed)</p>
			{:else}
				<div class="space-y-3">
					<p class="text-sm uppercase tracking-wide text-mist-500">
						changed fields ({changedFields.length})
					</p>
					{#each changedFields as field (field)}
						<div class="border-l-2 border-candle-400/50 pl-3">
							<div class="font-mono text-xs uppercase tracking-wide text-candle-400">
								{field}
							</div>
							<div class="mt-1 grid grid-cols-2 gap-3 text-sm">
								<div>
									<div class="text-xs text-rose-400">before</div>
									<pre class="whitespace-pre-wrap break-words font-mono text-xs text-rose-300/80">{JSON.stringify(
											(form.suggestion.current as any)[field],
											null,
											2
										)}</pre>
								</div>
								<div>
									<div class="text-xs text-teal-400">after</div>
									<pre class="whitespace-pre-wrap break-words font-mono text-xs text-teal-300/80">{JSON.stringify(
											(form.suggestion.suggested as any)[field],
											null,
											2
										)}</pre>
								</div>
							</div>
						</div>
					{/each}
				</div>
			{/if}

			<form method="POST" action="?/apply" use:enhance class="flex gap-3 pt-2">
				<input
					type="hidden"
					name="new_bible_json"
					value={JSON.stringify(form.suggestion.suggested)}
				/>
				<input
					type="hidden"
					name="expected_version"
					value={form.suggestion.current_version}
				/>
				<input
					type="hidden"
					name="reason"
					value={`feedback: ${form.suggestion.feedback.slice(0, 120)}`}
				/>
				<button type="submit" class="storybook-button">
					✧ apply (new version)
				</button>
				<span class="font-hand text-sm text-mist-500 self-center">
					current version: v{form.suggestion.current_version} →
					v{form.suggestion.current_version + 1}
				</span>
			</form>
		</section>
	{/if}

	{#if form?.applied}
		<p class="font-hand text-base text-candle-300">
			✨ applied — bible is now at v{form.applied.version}.
		</p>
	{/if}

	<details class="story-card px-5 py-4">
		<summary class="cursor-pointer font-hand text-base text-mist-400">
			current bible (raw)
		</summary>
		<pre class="mt-3 overflow-x-auto font-mono text-xs text-mist-300">{JSON.stringify(
				data.bible,
				null,
				2
			)}</pre>
	</details>
</section>
