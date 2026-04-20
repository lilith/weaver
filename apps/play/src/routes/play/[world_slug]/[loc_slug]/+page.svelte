<script lang="ts">
	import { enhance } from '$app/forms';
	let { data, form } = $props();
	let expanding = $state(false);
	let inputEl = $state<HTMLTextAreaElement | undefined>();
</script>

<article class="space-y-6 pb-24">
	<header class="space-y-1">
		<h1 class="font-display text-4xl tracking-tight text-mist-100 sm:text-5xl">
			{data.location.name}
		</h1>
		{#if data.location.author_pseudonym}
			<p class="font-hand text-base text-candle-300">
				✦ discovered by {data.location.author_pseudonym}
			</p>
		{/if}
	</header>

	<section class="story-prose">
		<p
			class="first-letter:float-left first-letter:mr-2 first-letter:font-display first-letter:text-6xl first-letter:leading-[0.9] first-letter:text-candle-300"
		>
			{data.location.description}
		</p>
	</section>

	{#if form?.says?.length}
		<section class="story-aside space-y-2">
			{#each form.says as line}
				<p class="italic">{line}</p>
			{/each}
		</section>
	{/if}

	{#if form?.narrate}
		<section class="story-aside space-y-2">
			<p class="italic">{form.narrate}</p>
		</section>
	{/if}

	{#if form?.error}
		<section class="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
			{form.error}
		</section>
	{/if}

	<hr class="ornate-divider" />

	<section class="space-y-3">
		{#each data.location.options as option, i (i)}
			<form method="POST" action="?/pick" use:enhance>
				<input type="hidden" name="option_index" value={i} />
				<button type="submit" class="choice-button">
					<span class="mr-3 text-rose-400">❖</span>{option.label}
				</button>
			</form>
		{/each}
	</section>

	<section class="space-y-3">
		<h2 class="font-hand text-2xl text-candle-300">or — tell the world what you do</h2>
		<form
			method="POST"
			action="?/expand"
			class="space-y-3"
			use:enhance={() => {
				expanding = true;
				return async ({ update }) => {
					await update({ reset: true });
					expanding = false;
					inputEl?.focus();
				};
			}}
		>
			<textarea
				bind:this={inputEl}
				name="input"
				rows="2"
				required
				maxlength="500"
				placeholder={'"I climb the chapel tower" — or anything. The world will catch you.'}
				class="storybook-input w-full resize-none"
				disabled={expanding}
			></textarea>
			<div class="flex items-center justify-between gap-3">
				<p class="text-xs text-mist-600">
					{expanding ? 'the world is forming…' : 'your words weave new places.'}
				</p>
				<button class="storybook-button" disabled={expanding}>
					{expanding ? '…' : 'weave it'}
				</button>
			</div>
		</form>
	</section>
</article>
