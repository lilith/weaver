<script lang="ts">
	import { enhance } from '$app/forms';
	let { data, form } = $props();
	let expanding = $state(false);
	let inputEl = $state<HTMLTextAreaElement | undefined>();
</script>

<svelte:head>
	{#if data.palette}
		{@html `<style id="biome-palette">${data.palette.css}</style>`}
	{/if}
</svelte:head>

<article class="space-y-6 pb-24">
	<header class="space-y-1">
		<h1 class="font-display text-4xl tracking-tight text-mist-100 sm:text-5xl">
			{data.location.name}
		</h1>
		<div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
			{#if data.palette}
				<span class="text-candle-300">{data.palette.name}</span>
				<span class="font-hand text-base text-mist-400">· {data.palette.mood}</span>
			{/if}
			{#if data.location.author_pseudonym}
				<span class="font-hand text-base text-teal-400">✦ by {data.location.author_pseudonym}</span>
			{/if}
			{#if data.location.draft}
				<span class="rounded-full border border-rose-400/40 bg-rose-500/10 px-2 py-0.5 font-hand text-base text-rose-300">
					dreamed, not yet on the map
				</span>
			{/if}
		</div>
	</header>

	<section class="story-prose">
		<p
			class="first-letter:float-left first-letter:mr-2 first-letter:font-display first-letter:text-6xl first-letter:leading-[0.9] first-letter:text-candle-300"
		>
			{data.location.description}
		</p>
	</section>

	<!-- Free-text input: compact, inline, icon submit — visible without scrolling. -->
	<form
		method="POST"
		action="?/expand"
		class="flex items-end gap-2"
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
			rows="1"
			required
			maxlength="500"
			placeholder={'or write what you do…'}
			class="storybook-input min-h-[2.75rem] flex-1 resize-none"
			disabled={expanding}
		></textarea>
		<button
			type="submit"
			class="weave-icon-button"
			disabled={expanding}
			title="weave this into the world"
			aria-label="weave this into the world"
		>
			{#if expanding}
				<span class="weave-spinner"></span>
			{:else}
				<span aria-hidden="true">✧</span>
			{/if}
		</button>
	</form>

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

	{#if form?.saved}
		<section class="rounded-lg border border-candle-400/40 bg-candle-500/10 px-4 py-3 text-sm text-candle-300">
			✨ Woven into the map. Anyone who passes through {form.parent_name ?? 'here'} can now find it.
		</section>
	{/if}

	{#if form?.error}
		<section class="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
			{form.error}
		</section>
	{/if}

	{#if data.location.draft}
		<section class="story-card space-y-3 px-5 py-4">
			<p class="font-hand text-xl text-candle-300">
				This place is yours alone, for now.
			</p>
			<p class="text-sm text-mist-400">
				Save it to the map and anyone who comes through {data.parentName ?? 'the way you came'} can find it.
			</p>
			<form method="POST" action="?/save" use:enhance>
				<button type="submit" class="storybook-button">✧ save to the map</button>
			</form>
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
</article>

<style>
	.weave-icon-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2.75rem;
		height: 2.75rem;
		flex-shrink: 0;
		font-family: var(--font-display);
		font-size: 1.5rem;
		color: var(--color-ink-950);
		background: linear-gradient(180deg, var(--color-candle-300), var(--color-candle-500));
		border: 1px solid rgba(12, 10, 24, 0.5);
		border-radius: var(--radius-button);
		box-shadow:
			0 1px 0 rgba(255, 255, 255, 0.4) inset,
			0 0 0 1px rgba(232, 160, 36, 0.4),
			var(--glow-candle);
		cursor: pointer;
		transition: transform 100ms ease, filter 120ms ease, box-shadow 200ms ease;
	}
	.weave-icon-button:hover {
		filter: brightness(1.05);
		transform: translateY(-1px);
		box-shadow:
			0 1px 0 rgba(255, 255, 255, 0.45) inset,
			0 0 0 1px rgba(240, 80, 128, 0.45),
			0 0 32px rgba(240, 80, 128, 0.35);
	}
	.weave-icon-button:active { transform: translateY(0); }
	.weave-icon-button:disabled {
		opacity: 0.55;
		cursor: default;
		transform: none;
		box-shadow: none;
	}
	.weave-spinner {
		width: 1rem;
		height: 1rem;
		border: 2px solid rgba(12, 10, 24, 0.3);
		border-top-color: rgba(12, 10, 24, 0.9);
		border-radius: 50%;
		animation: weave-spin 0.8s linear infinite;
	}
	@keyframes weave-spin {
		to { transform: rotate(360deg); }
	}
</style>
