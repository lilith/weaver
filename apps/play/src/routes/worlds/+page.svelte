<script lang="ts">
	import { enhance } from '$app/forms';
	let { data, form } = $props();
	let seeding = $state(false);
	// Two-step new-world flow:
	//   1. Pick a starting point (tile or "describe your own").
	//   2. Name your character → submit.
	let seedKind = $state<'quiet-vale' | 'custom' | null>(null);
	let description = $state('');
</script>

<section class="space-y-10 py-6">
	<header class="space-y-2">
		<h1 class="font-display text-4xl text-mist-100 sm:text-5xl">Your worlds</h1>
		<p class="text-mist-400">
			Each world is its own story. Start with a small seed; spin up more whenever you feel like
			trying a new game.
		</p>
	</header>

	{#if data.worlds.length > 0}
		<ul class="space-y-3">
			{#each data.worlds as world (world._id)}
				<li>
					<a
						href="/play/{world.slug}"
						class="story-card group flex items-center justify-between px-5 py-4 no-underline"
					>
						<div>
							<div class="font-display text-xl text-mist-100">{world.name}</div>
							<div class="text-xs uppercase tracking-wide text-mist-600">
								{world.role} ·
								{world.location_count ?? 0}
								{(world.location_count ?? 0) === 1 ? 'place' : 'places'}
								{#if world.visited_count}
									· {world.visited_count} visited
								{/if}
							</div>
						</div>
						<span class="font-hand text-2xl text-rose-400 transition group-hover:translate-x-1">
							↝
						</span>
					</a>
				</li>
			{/each}
		</ul>
	{/if}

	<div class="story-card space-y-6 px-6 py-6">
		<div class="space-y-2">
			<h2 class="font-display text-2xl">Start a new world</h2>
			<p class="font-hand text-base text-candle-300">first: what kind of world?</p>
		</div>

		<!-- Step 1: seed picker (two tiles — Quiet Vale default, Custom). -->
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
					A sentence or two about where and when. Weaver will generate a bible, a biome, and a
					starting place.
				</p>
			</button>
		</div>

		<!-- Step 1b (conditional): the seed description textarea. -->
		{#if seedKind === 'custom'}
			<label class="block space-y-1">
				<span class="font-hand text-base text-candle-300">
					describe your world — 1–3 sentences
				</span>
				<textarea
					bind:value={description}
					rows="3"
					maxlength="1200"
					placeholder="e.g. a walled city at the edge of a desert, ruled by cats; it's been raining for a year"
					class="storybook-input w-full"
				></textarea>
			</label>
		{/if}

		<!-- Step 2 (conditional on seedKind chosen): character name + submit. -->
		{#if seedKind !== null}
			<form
				method="POST"
				action={seedKind === 'custom' ? '?/custom_seed' : '?/seed'}
				class="space-y-3"
				use:enhance={() => {
					seeding = true;
					return async ({ update }) => {
						await update({ reset: false });
						seeding = false;
					};
				}}
			>
				{#if seedKind === 'custom'}
					<input type="hidden" name="description" value={description} />
				{/if}
				<label class="block space-y-1">
					<span class="font-hand text-base text-candle-300">
						second: what should your character be called?
					</span>
					<input
						name="character_name"
						placeholder="your name here (or leave blank)"
						class="storybook-input w-full"
					/>
				</label>
				{#if form?.error}
					<p class="text-sm text-rose-400">{form.error}</p>
				{/if}
				<button
					class="storybook-button"
					disabled={seeding || (seedKind === 'custom' && description.trim().length < 8)}
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
			</form>
		{/if}
	</div>
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
</style>
