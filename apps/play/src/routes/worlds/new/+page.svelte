<script lang="ts">
	import { enhance } from '$app/forms';
	let { form } = $props();
	let seeding = $state(false);

	// Two-step flow preserved from the old inline version:
	//   1. Pick a starting point — Quiet Vale tile or "Describe your own".
	//   2. Fill in details + submit.
	// Initial values come from `form` if a prior submit failed, otherwise
	// defaults. Bind-value keeps edits local after the first render; we
	// don't want these to rerender when `form` changes after an enhance
	// submit (that would clobber the user's in-flight edits). Lazy-read
	// via a closure to satisfy svelte-check.
	const initial = (() =>
		form as
			| { description?: string; character_name?: string; content_rating?: 'family' | 'teen' | 'adult' }
			| null
			| undefined)();
	let seedKind = $state<'quiet-vale' | 'custom' | null>(initial?.description ? 'custom' : null);
	let description = $state<string>(initial?.description ?? '');
	let characterName = $state<string>(initial?.character_name ?? '');
	let contentRating = $state<'family' | 'teen' | 'adult'>(initial?.content_rating ?? 'family');

	const RATING_BLURB: Record<'family' | 'teen' | 'adult', string> = {
		family: 'No violence, no sexual content, no disturbing imagery. Stakes via puzzles and wonder.',
		teen:
			'Stylised violence and darker themes (fear, loss, moral ambiguity). Romance can exist, not explicit.',
		adult: 'On-page violence and explicit themes permitted. Still tasteful, never gratuitous.'
	};
</script>

<svelte:head>
	<title>Start a new world — Weaver</title>
</svelte:head>

<section class="mx-auto max-w-3xl space-y-10 py-6">
	<header class="space-y-2">
		<p class="font-hand text-base text-candle-300">
			<a href="/worlds" class="underline decoration-candle-600/40 hover:decoration-candle-300">
				← all worlds
			</a>
		</p>
		<h1 class="font-display text-4xl text-mist-100 sm:text-5xl">Start a new world</h1>
		<p class="text-mist-400">
			A world is its own story — its own bible, biomes, characters, and clock. Start from a tile or
			describe your own.
		</p>
	</header>

	<!-- Step 1: seed picker. -->
	<div class="grid gap-3 sm:grid-cols-2">
		<button
			type="button"
			onclick={() => (seedKind = 'quiet-vale')}
			class="seed-tile"
			class:seed-tile-active={seedKind === 'quiet-vale'}
			aria-pressed={seedKind === 'quiet-vale'}
		>
			<div class="font-display text-xl text-mist-100">The Quiet Vale</div>
			<p class="text-sm text-mist-400">
				A cozy starter. A small mountain village, a carpenter named Mara, morning light and
				woodsmoke. Good for seeing the bones.
			</p>
		</button>
		<button
			type="button"
			onclick={() => (seedKind = 'custom')}
			class="seed-tile"
			class:seed-tile-active={seedKind === 'custom'}
			aria-pressed={seedKind === 'custom'}
		>
			<div class="font-display text-xl text-mist-100">Describe your own</div>
			<p class="text-sm text-mist-400">
				A sentence, a paragraph, or a whole sketch. Weaver will generate a bible, a biome, and a
				starting place.
			</p>
		</button>
	</div>

	{#if seedKind === 'custom'}
		<div class="story-card space-y-6 px-6 py-6">
			<div class="space-y-2">
				<h2 class="font-display text-2xl">Describe your world</h2>
				<p class="font-hand text-base text-candle-300">
					As short as one sentence, as long as you like. Weaver reads it all.
				</p>
			</div>

			<form
				method="POST"
				action="?/custom_seed"
				class="space-y-6"
				use:enhance={() => {
					seeding = true;
					return async ({ update }) => {
						await update({ reset: false });
						seeding = false;
					};
				}}
			>
				<label class="block space-y-1">
					<span class="font-hand text-base text-candle-300">the seed</span>
					<textarea
						name="description"
						bind:value={description}
						rows="10"
						placeholder="e.g. a walled city at the edge of a desert, ruled by cats; it's been raining for a year. the cat-queen's daughter has gone missing and the drainage wardens are suspicious."
						class="storybook-input w-full resize-y"
					></textarea>
					<span class="text-xs text-mist-500">
						{description.length.toLocaleString()} characters
					</span>
				</label>

				<fieldset class="space-y-2">
					<legend class="font-hand text-base text-candle-300">content rating</legend>
					<div class="grid gap-2 sm:grid-cols-3">
						{#each ['family', 'teen', 'adult'] as const as r (r)}
							<button
								type="button"
								class="rating-chip"
								class:rating-chip-active={contentRating === r}
								aria-pressed={contentRating === r}
								onclick={() => (contentRating = r)}
							>
								<span class="font-display text-lg capitalize">{r}</span>
								<span class="text-xs text-mist-400">{RATING_BLURB[r]}</span>
							</button>
						{/each}
					</div>
					<input type="hidden" name="content_rating" value={contentRating} />
					<p class="text-xs text-mist-500">
						Currently selected: <span class="text-mist-300">{contentRating}</span>. You can change
						a world's rating later in admin — this sets the tone Opus writes at generation time.
					</p>
				</fieldset>

				<label class="block space-y-1">
					<span class="font-hand text-base text-candle-300">
						what should your character be called?
					</span>
					<input
						name="character_name"
						bind:value={characterName}
						placeholder="your name here (or leave blank)"
						class="storybook-input w-full"
					/>
				</label>

				{#if form?.error}
					<p class="text-sm text-rose-400">{form.error}</p>
				{/if}

				<div class="flex flex-wrap items-center gap-3">
					<button
						class="storybook-button"
						disabled={seeding || description.trim().length < 8}
					>
						{seeding ? 'Weaving a fresh world…' : 'Weave this world'}
					</button>
					<p class="font-hand text-sm text-mist-500">
						Takes ~10 seconds. Weaver writes a bible and a first room, then hands you the pen.
					</p>
				</div>
			</form>
		</div>
	{/if}

	{#if seedKind === 'quiet-vale'}
		<div class="story-card space-y-6 px-6 py-6">
			<div class="space-y-2">
				<h2 class="font-display text-2xl">Begin in the Quiet Vale</h2>
				<p class="text-sm text-mist-400">
					A small mountain village. Mara's cottage, a village square, dawn light.
				</p>
			</div>
			<form
				method="POST"
				action="?/seed"
				class="space-y-4"
				use:enhance={() => {
					seeding = true;
					return async ({ update }) => {
						await update({ reset: false });
						seeding = false;
					};
				}}
			>
				<label class="block space-y-1">
					<span class="font-hand text-base text-candle-300">
						what should your character be called?
					</span>
					<input
						name="character_name"
						bind:value={characterName}
						placeholder="your name here (or leave blank)"
						class="storybook-input w-full"
					/>
				</label>
				{#if form?.error}
					<p class="text-sm text-rose-400">{form.error}</p>
				{/if}
				<button class="storybook-button" disabled={seeding}>
					{seeding ? 'Weaving…' : 'Begin in the Quiet Vale'}
				</button>
			</form>
		</div>
	{/if}
</section>

<style>
	.seed-tile {
		display: block;
		padding: 1rem 1.25rem;
		border: 1px solid rgb(var(--color-mist-800) / 0.5);
		border-radius: 0.25rem;
		background: rgb(var(--color-velvet-800) / 0.5);
		text-align: left;
		cursor: pointer;
		transition: border-color 120ms ease, background-color 120ms ease;
	}
	.seed-tile:hover {
		border-color: rgb(var(--color-candle-400) / 0.6);
		background: rgb(var(--color-velvet-800) / 0.7);
	}
	.seed-tile-active {
		border-color: rgb(var(--color-candle-400));
		background: rgb(var(--color-velvet-700) / 0.8);
		box-shadow: 0 0 0 1px rgb(var(--color-candle-400) / 0.3) inset;
	}
	.seed-tile-active:hover {
		border-color: rgb(var(--color-candle-300));
	}
	.rating-chip {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding: 0.75rem 0.9rem;
		border: 1px solid rgb(var(--color-mist-800) / 0.5);
		border-radius: 0.25rem;
		background: rgb(var(--color-velvet-800) / 0.4);
		cursor: pointer;
		transition:
			border-color 120ms ease,
			background-color 120ms ease;
	}
	.rating-chip:hover {
		border-color: rgb(var(--color-candle-400) / 0.6);
	}
	.rating-chip-active {
		border-color: rgb(var(--color-candle-400));
		background: rgb(var(--color-velvet-700) / 0.7);
		box-shadow: 0 0 0 1px rgb(var(--color-candle-400) / 0.3) inset;
	}
</style>
