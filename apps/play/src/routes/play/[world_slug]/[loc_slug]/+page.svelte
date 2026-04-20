<script lang="ts">
	import { enhance } from '$app/forms';
	let { data, form } = $props();
	let expanding = $state(false);
	let inputEl = $state<HTMLTextAreaElement | undefined>();

	// Which dreams from the closed journey is the player keeping.
	// Defaults to all boxes checked — the most common intent after a
	// journey is "yeah, keep what I made." Opt-out, not opt-in.
	let keepSet = $state<Record<string, boolean>>({});
	$effect(() => {
		const j = data.closed_journey;
		if (j) {
			const next: Record<string, boolean> = {};
			for (const e of j.entities) next[e.slug] = e.draft; // pre-check unsaved ones
			keepSet = next;
		}
	});
</script>

<svelte:head>
	{#if data.palette}
		{@html `<style id="biome-palette">${data.palette.css}</style>`}
	{/if}
</svelte:head>

<article class="space-y-6 pb-24">
	<header class="space-y-1">
		<h1 class="font-display text-4xl tracking-tight text-mist-100 sm:text-5xl">
			{#if data.location.draft}
				<span class="dream-glyph" title="a dream — not yet on the map">✦</span>
			{/if}
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
		</div>
	</header>

	<section class="story-prose">
		<p
			class="first-letter:float-left first-letter:mr-2 first-letter:font-display first-letter:text-6xl first-letter:leading-[0.9] first-letter:text-candle-300"
		>
			{data.location.description}
		</p>
	</section>

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

	{#if form?.saved_cluster}
		<section class="rounded-lg border border-candle-400/40 bg-candle-500/10 px-4 py-3 text-sm text-candle-300">
			{#if form.saved_cluster.saved > 0}
				✨ {form.saved_cluster.saved} of {form.saved_cluster.total} woven into the map.
			{:else}
				Nothing kept this time — the dreams are still in your journal if you want them later.
			{/if}
		</section>
	{/if}

	{#if form?.dismissed}
		<section class="rounded-lg border border-mist-600/40 bg-mist-600/10 px-4 py-3 text-sm text-mist-400">
			The journey's tucked into your journal — come back for it any time.
		</section>
	{/if}

	{#if form?.error}
		<section class="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
			{form.error}
		</section>
	{/if}

	<!-- Journey-close cluster panel: only shown when we've just returned
	     to canonical ground after one or more dreams -->
	{#if data.closed_journey && data.closed_journey.entities.length > 0}
		<section class="story-card space-y-4 px-5 py-5">
			<div class="space-y-1">
				<p class="font-hand text-2xl text-candle-300">the way back</p>
				<p class="text-sm text-mist-400">
					You wandered {data.closed_journey.entities.length === 1
						? 'somewhere'
						: `through ${data.closed_journey.entities.length} places`}.
					Keep any for the shared map?
				</p>
				{#if data.closed_journey.summary}
					<p class="text-sm italic text-mist-400">{data.closed_journey.summary}</p>
				{/if}
			</div>

			<form method="POST" action="?/save_cluster" use:enhance class="space-y-2">
				<input type="hidden" name="journey_id" value={data.closed_journey._id} />
				<ul class="space-y-2">
					{#each data.closed_journey.entities as entity (entity.entity_id)}
						<li>
							<label class="flex cursor-pointer items-center gap-3 rounded-lg border border-mist-800/50 bg-velvet-800/40 px-3 py-2 hover:border-candle-400/50">
								<input
									type="checkbox"
									name="keep_slug"
									value={entity.slug}
									checked={keepSet[entity.slug]}
									onchange={(e) => (keepSet[entity.slug] = (e.target as HTMLInputElement).checked)}
									disabled={!entity.draft}
									class="h-5 w-5 accent-candle-400"
								/>
								<span class="flex-1">
									<span class="font-display text-lg text-mist-100">{entity.name}</span>
									{#if entity.biome}
										<span class="ml-2 text-xs uppercase tracking-wide text-mist-600">{entity.biome}</span>
									{/if}
									{#if !entity.draft}
										<span class="ml-2 font-hand text-sm text-candle-300">already saved</span>
									{/if}
								</span>
							</label>
						</li>
					{/each}
				</ul>
				<div class="flex flex-wrap gap-2">
					<button type="submit" class="storybook-button">✧ keep the checked ones</button>
				</div>
			</form>
			<form method="POST" action="?/dismiss_journey" use:enhance>
				<input type="hidden" name="journey_id" value={data.closed_journey._id} />
				<button type="submit" class="text-sm text-mist-400 underline decoration-mist-800 hover:text-rose-400">
					ask me later (tuck into journal)
				</button>
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
	.dream-glyph {
		display: inline-block;
		color: var(--color-candle-300);
		font-size: 0.7em;
		vertical-align: 0.2em;
		margin-right: 0.3em;
		text-shadow: 0 0 12px rgba(249, 213, 122, 0.45);
	}
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
	.weave-icon-button:active {
		transform: translateY(0);
	}
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
