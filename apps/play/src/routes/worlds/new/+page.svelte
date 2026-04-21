<script lang="ts">
	import { enhance } from '$app/forms';
	let { data, form } = $props();
	let seeding = $state(false);

	// Two-step flow:
	//   1. Pick a starting point — Quiet Vale tile or "Describe your own".
	//   2. Fill in details, pick a game-feel preset, optionally customize.
	const initial = (() =>
		form as
			| {
					description?: string;
					character_name?: string;
					content_rating?: 'family' | 'teen' | 'adult';
					preset?: string;
					customize?: boolean;
			  }
			| null
			| undefined)();

	let seedKind = $state<'quiet-vale' | 'custom' | null>(initial?.description ? 'custom' : null);
	let description = $state<string>(initial?.description ?? '');
	let characterName = $state<string>(initial?.character_name ?? '');
	let contentRating = $state<'family' | 'teen' | 'adult'>(initial?.content_rating ?? 'family');
	let presetId = $state<string>(initial?.preset || 'balanced');
	let customize = $state<boolean>(initial?.customize ?? false);

	// Flag-override state — populated from the selected preset whenever the
	// user flips preset OR opens the customize disclosure for the first time.
	// Stored as a plain record keyed by flag_key → boolean. Lazy lookups
	// so svelte-check doesn't complain about initial-prop reads.
	function presetFlagsAsRecord(id: string): Record<string, boolean> {
		const list = data.presets.find((p) => p.id === id)?.flags ?? [];
		const rec: Record<string, boolean> = {};
		for (const f of data.flag_options) rec[f.key] = list.includes(f.key);
		return rec;
	}
	let flagChecks = $state<Record<string, boolean>>(
		(() => presetFlagsAsRecord(presetId))(),
	);

	function selectPreset(id: string) {
		presetId = id;
		// When not in customize mode, snap the flag grid to match (so if the
		// user later opens customize, the starting state reflects the preset).
		if (!customize) flagChecks = presetFlagsAsRecord(id);
	}

	// Style-tag selection. Default: whatever the currently-selected preset
	// suggests, unless the user has touched the picker.
	function suggestedStyleFor(id: string): string | null {
		return data.presets.find((p) => p.id === id)?.suggested_style_tag ?? null;
	}
	let styleTag = $state<string | null>((() => suggestedStyleFor(presetId))());
	let styleTagTouched = $state(false);

	// Auto-sync the suggested style on preset flip, but only if the user
	// hasn't picked one explicitly.
	$effect(() => {
		if (!styleTagTouched) styleTag = suggestedStyleFor(presetId);
	});

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

	{#if seedKind !== null}
		<div class="story-card space-y-8 px-6 py-6">
			<form
				method="POST"
				action={seedKind === 'custom' ? '?/custom_seed' : '?/seed'}
				class="space-y-8"
				use:enhance={() => {
					seeding = true;
					return async ({ update }) => {
						await update({ reset: false });
						seeding = false;
					};
				}}
			>
				{#if seedKind === 'custom'}
					<div class="space-y-6">
						<div class="space-y-2">
							<h2 class="font-display text-2xl">Describe your world</h2>
							<p class="font-hand text-base text-candle-300">
								As short as one sentence, as long as you like. Weaver reads it all.
							</p>
						</div>

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
										class="chip"
										class:chip-active={contentRating === r}
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
								Currently selected: <span class="text-mist-300">{contentRating}</span>. Change in
								admin later.
							</p>
						</fieldset>
					</div>
				{/if}

				<!-- Game feel preset picker — applies to both paths. -->
				<fieldset class="space-y-3">
					<legend class="font-hand text-base text-candle-300">game feel</legend>
					<div class="grid gap-3 sm:grid-cols-3">
						{#each data.presets as p (p.id)}
							<button
								type="button"
								class="chip chip-tall"
								class:chip-active={presetId === p.id}
								aria-pressed={presetId === p.id}
								onclick={() => selectPreset(p.id)}
							>
								<span class="font-display text-lg">{p.name}</span>
								<span class="text-xs text-candle-300">{p.tagline}</span>
								<span class="text-xs text-mist-400">{p.blurb}</span>
							</button>
						{/each}
					</div>
					<input type="hidden" name="preset" value={presetId} />
				</fieldset>

				<!-- Style tag (pixel tile library). -->
				<fieldset class="space-y-2">
					<legend class="font-hand text-base text-candle-300">pixel-art style</legend>
					<div class="grid gap-2 sm:grid-cols-3">
						{#each data.style_tags as s (s.id ?? 'none')}
							<button
								type="button"
								class="chip"
								class:chip-active={styleTag === s.id}
								aria-pressed={styleTag === s.id}
								onclick={() => {
									styleTag = s.id;
									styleTagTouched = true;
								}}
							>
								<span class="font-display text-base">{s.name}</span>
								<span class="text-xs text-mist-400">{s.blurb}</span>
							</button>
						{/each}
					</div>
					{#if styleTag !== null}
						<input type="hidden" name="style_tag" value={styleTag} />
					{/if}
				</fieldset>

				<!-- Customize disclosure. Plain button + controlled div so the
				     browser's native <details> toggle doesn't fight our state. -->
				<div class="rounded border border-mist-800/40 bg-velvet-900/40 p-4">
					<button
						type="button"
						class="cursor-pointer font-hand text-base text-candle-300 select-none w-full text-left"
						aria-expanded={customize}
						onclick={() => (customize = !customize)}
					>
						<span class="mr-1 text-xs text-candle-500">{customize ? '▼' : '▶'}</span>
						customize flags…
						<span class="ml-1 text-xs text-mist-500">
							{customize ? '(overriding preset)' : '(optional; preset applies otherwise)'}
						</span>
					</button>
					{#if customize}
						<input type="hidden" name="customize" value="on" />
						<p class="mt-3 text-xs text-mist-500">
							Check what you want on. Preset is ignored when this is expanded. Foundational
							flags (expansion, journeys, world clock) are always on.
						</p>
						<div class="mt-3 grid gap-2 sm:grid-cols-2">
							{#each data.flag_options as f (f.key)}
								<label class="flag-row">
									<input
										type="checkbox"
										name={f.key}
										checked={flagChecks[f.key] ?? false}
										onchange={(e) => (flagChecks[f.key] = (e.target as HTMLInputElement).checked)}
									/>
									<span class="flag-text">
										<span class="font-display text-sm text-mist-100">{f.label}</span>
										<span class="text-xs text-mist-500">{f.hint}</span>
									</span>
								</label>
							{/each}
						</div>
					{/if}
				</div>

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
						disabled={seeding ||
							(seedKind === 'custom' && description.trim().length < 8)}
					>
						{seeding
							? seedKind === 'custom'
								? 'Weaving a fresh world…'
								: 'Weaving…'
							: seedKind === 'custom'
								? 'Weave this world'
								: 'Begin in the Quiet Vale'}
					</button>
					{#if seedKind === 'custom'}
						<p class="font-hand text-sm text-mist-500">
							Takes ~10 seconds. Weaver writes a bible and a first room, then hands you the pen.
						</p>
					{/if}
				</div>
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
	.chip {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding: 0.75rem 0.9rem;
		border: 1px solid rgb(var(--color-mist-800) / 0.5);
		border-radius: 0.25rem;
		background: rgb(var(--color-velvet-800) / 0.4);
		cursor: pointer;
		text-align: left;
		transition:
			border-color 120ms ease,
			background-color 120ms ease;
	}
	.chip-tall {
		min-height: 7rem;
	}
	.chip:hover {
		border-color: rgb(var(--color-candle-400) / 0.6);
	}
	.chip-active {
		border-color: rgb(var(--color-candle-400));
		background: rgb(var(--color-velvet-700) / 0.7);
		box-shadow: 0 0 0 1px rgb(var(--color-candle-400) / 0.3) inset;
	}
	.flag-row {
		display: flex;
		gap: 0.6rem;
		align-items: flex-start;
		padding: 0.4rem 0.5rem;
		border-radius: 0.25rem;
		cursor: pointer;
	}
	.flag-row:hover {
		background: rgb(var(--color-velvet-800) / 0.4);
	}
	.flag-row input[type='checkbox'] {
		margin-top: 0.2rem;
		flex-shrink: 0;
	}
	.flag-text {
		display: flex;
		flex-direction: column;
		gap: 0.05rem;
	}
</style>
