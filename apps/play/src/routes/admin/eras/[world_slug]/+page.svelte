<script lang="ts">
	import { enhance } from '$app/forms';
	let { data, form } = $props();
	let hint = $state('');
	let pending = $state(false);

	const chronicles = $derived(data.era_state?.chronicles ?? []);
	const activeEra = $derived(data.era_state?.active_era ?? 1);
</script>

<section class="space-y-8 py-6">
	<header class="space-y-2">
		<p class="font-hand text-base text-candle-300">eras admin</p>
		<h1 class="font-display text-3xl text-mist-100 sm:text-4xl">
			{data.world.name}
		</h1>
		<p class="text-sm text-mist-400">
			Currently in <span class="font-hand text-xl text-candle-300">
				era {activeEra}
			</span>.
			Advancing writes a chronicle — a short chapter-break piece — and
			increments the world's active_era counter. Existing entities stay
			visible; per-era authoring is v2.
		</p>
	</header>

	<form
		method="POST"
		action="?/advance"
		class="story-card space-y-3 px-5 py-5"
		use:enhance={() => {
			pending = true;
			return async ({ update }) => {
				await update({ reset: true });
				pending = false;
			};
		}}
	>
		<label class="block space-y-1">
			<span class="font-hand text-base text-candle-300">
				advance into era {activeEra + 1} — optional hint for the chronicler
			</span>
			<textarea
				name="hint"
				rows="2"
				maxlength="500"
				bind:value={hint}
				placeholder="e.g. invasion arrives by sea; apothecary's disappearance is resolved"
				class="storybook-input w-full"
			></textarea>
		</label>
		<button type="submit" class="storybook-button" disabled={pending}>
			{pending ? 'Chronicler writing…' : `✧ Advance into era ${activeEra + 1}`}
		</button>
		<p class="font-hand text-sm text-mist-500">
			~$0.04 per transition. The chronicle is shown below after it lands.
		</p>
	</form>

	{#if form?.error}
		<p class="text-sm text-rose-400">{form.error}</p>
	{/if}
	{#if form?.advanced}
		<p class="font-hand text-base text-candle-300">
			✨ advanced: era {form.advanced.from_era} → era {form.advanced.to_era}
		</p>
	{/if}

	{#if chronicles.length > 0}
		<section class="space-y-4">
			<h2 class="font-display text-2xl text-mist-100">chronicles</h2>
			{#each [...chronicles].reverse() as c (c.id)}
				<article class="story-card space-y-2 px-6 py-5">
					<div class="flex items-baseline gap-3">
						<span class="font-mono text-xs text-mist-500">
							era {c.from_era} → {c.to_era}
						</span>
						<h3 class="font-display text-xl text-mist-100">{c.title}</h3>
					</div>
					<div class="story-prose whitespace-pre-wrap leading-relaxed">
						{c.body}
					</div>
				</article>
			{/each}
		</section>
	{:else}
		<p class="font-hand text-base text-mist-500">
			(no chronicles yet — this world is still in its first era)
		</p>
	{/if}

	<nav class="pt-4 text-sm text-mist-500">
		<a href="/admin/{data.world.slug}" class="hover:text-candle-300">
			← admin home
		</a>
	</nav>
</section>
