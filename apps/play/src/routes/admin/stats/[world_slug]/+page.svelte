<script lang="ts">
	import { enhance } from '$app/forms';
	let { data, form } = $props();
	let feedback = $state('');
	let pending = $state(false);

	const presets = [
		{
			id: 'litrpg',
			label: 'litrpg',
			hint: 'numbers visible — HP, Gold, Energy with bars'
		},
		{
			id: 'standard-fantasy',
			label: 'standard fantasy',
			hint: 'classic labels, no bars'
		},
		{
			id: 'cozy',
			label: 'cozy',
			hint: 'no numeric stats — only "what you carry"'
		}
	];

	function presetFeedback(id: string): string {
		switch (id) {
			case 'litrpg':
				return 'go full litrpg — show HP, Gold, Energy with fraction format and bars; keep them named HP/Gold/Energy. order them HP, Energy, Gold.';
			case 'standard-fantasy':
				return 'standard fantasy labels — Health / Coin / Stamina; no bars, just the numbers; tasteful colors.';
			case 'cozy':
				return 'cozy mode — hide every numeric stat; rename the inventory heading to "in your pocket"; nothing on the panel except items.';
			default:
				return '';
		}
	}
</script>

<section class="space-y-8 py-6">
	<header class="space-y-2">
		<p class="font-hand text-base text-candle-300">stats · ai feedback</p>
		<h1 class="font-display text-3xl text-mist-100 sm:text-4xl">
			{data.world.name}
		</h1>
		<p class="max-w-prose text-sm text-mist-400">
			Choose how stats appear in your world. The engine keeps a fixed set of
			canonical stats (HP, Gold, Energy, Inventory) under the hood — you change
			only what the player <em>sees</em>: labels, colors, formats, hidden
			tiles, custom display-only stats. Combat and inventory effects keep
			working unchanged.
		</p>
	</header>

	<details class="story-card px-5 py-4" open>
		<summary class="cursor-pointer font-hand text-base text-mist-400">
			current schema (raw)
		</summary>
		{#if data.schema}
			<pre
				class="mt-3 overflow-x-auto font-mono text-xs text-mist-300"
				>{JSON.stringify(data.schema, null, 2)}</pre>
		{:else}
			<p class="mt-3 font-hand text-base text-mist-500">
				(no schema yet — engine defaults apply: HP / gold / energy at standard
				labels)
			</p>
		{/if}
	</details>

	<section class="story-card space-y-3 px-6 py-5">
		<div>
			<p class="font-hand text-2xl text-candle-300">presets</p>
			<p class="text-sm text-mist-400">
				A nudge in a direction. Opus drafts the actual schema in your world's
				voice; you review before anything writes.
			</p>
		</div>
		<div class="grid gap-2 sm:grid-cols-3">
			{#each presets as p (p.id)}
				<button
					type="button"
					class="choice-button"
					onclick={() => (feedback = presetFeedback(p.id))}
				>
					<span class="block font-display text-base text-candle-200">
						{p.label}
					</span>
					<span class="mt-0.5 block text-xs text-mist-400">{p.hint}</span>
				</button>
			{/each}
		</div>
	</section>

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
				placeholder="e.g. rename HP to wellbeing and cap it at 10; hide gold; add a 'cat bond' display sourced from state.relationships.cat"
				class="storybook-input w-full"
				required
			></textarea>
		</label>
		<button
			type="submit"
			class="storybook-button"
			disabled={pending || feedback.trim().length < 4}
		>
			{pending ? 'asking opus…' : '✦ suggest a schema'}
		</button>
	</form>

	{#if form?.error}
		<p class="text-sm text-rose-400">{form.error}</p>
	{/if}

	{#if form?.suggestion}
		<section class="story-card space-y-4 px-6 py-5">
			<div>
				<p class="font-hand text-2xl text-candle-300">ai suggestion</p>
				<p class="text-sm text-mist-400">{form.suggestion.rationale}</p>
			</div>
			<div class="grid gap-3 sm:grid-cols-2">
				<div>
					<p class="text-xs uppercase tracking-wide text-rose-400">before</p>
					<pre
						class="mt-1 max-h-72 overflow-auto rounded border border-mist-800/40 bg-velvet-800/40 p-2 font-mono text-xs text-rose-300/80"
						>{JSON.stringify(form.suggestion.current, null, 2) ??
							'(none)'}</pre>
				</div>
				<div>
					<p class="text-xs uppercase tracking-wide text-teal-400">after</p>
					<pre
						class="mt-1 max-h-72 overflow-auto rounded border border-mist-800/40 bg-velvet-800/40 p-2 font-mono text-xs text-teal-300/80"
						>{JSON.stringify(form.suggestion.suggested, null, 2)}</pre>
				</div>
			</div>
			<form method="POST" action="?/apply" use:enhance class="flex gap-3 flex-wrap items-center">
				<input
					type="hidden"
					name="schema_json"
					value={JSON.stringify(form.suggestion.suggested)}
				/>
				<input
					type="hidden"
					name="reason"
					value={`feedback: ${form.suggestion.feedback.slice(0, 120)}`}
				/>
				<button type="submit" class="storybook-button">
					✦ apply this schema
				</button>
				<a
					href="/play/{data.world.slug}"
					class="font-hand text-base text-teal-400 hover:text-rose-400"
				>
					see it in play →
				</a>
			</form>
		</section>
	{/if}

	{#if form?.applied}
		<p class="font-hand text-base text-candle-300">
			✨ applied — load /play to see the new labels.
		</p>
	{/if}

	{#if data.schema}
		<form method="POST" action="?/reset" use:enhance>
			<button
				type="submit"
				class="text-sm text-mist-500 hover:text-rose-400"
			>
				clear schema · revert to engine defaults
			</button>
		</form>
	{/if}
	{#if form?.reset}
		<p class="font-hand text-base text-mist-400">
			schema cleared — defaults apply.
		</p>
	{/if}

	<nav class="pt-4 text-sm text-mist-500">
		<a href="/admin/{data.world.slug}" class="hover:text-candle-300">← admin</a>
	</nav>
</section>
