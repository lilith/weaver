<script lang="ts">
	import { enhance } from '$app/forms';
	let { data, form } = $props();

	type Loc = {
		slug: string;
		name: string;
		biome: string | null;
		map_hint: any;
		has_entity_pin: boolean;
		has_biome_pin: boolean;
	};

	let savingSlug = $state<string | null>(null);
</script>

<svelte:head>
	<title>{data.world.name} — image-gen hints</title>
</svelte:head>

<section class="space-y-8 py-6">
	<header class="space-y-2">
		<p class="font-hand text-base text-candle-300">
			<a
				href="/admin/{data.world_slug}"
				class="underline decoration-candle-600/40 hover:decoration-candle-300"
			>
				← admin
			</a>
		</p>
		<h1 class="font-display text-3xl text-mist-100 sm:text-4xl">image-gen hints</h1>
		<p class="text-sm text-mist-400">
			Per-location briefs the tile picker hands to pixellab. Edit the descriptor directly, or
			set direction/distance so the graph map positions the tile correctly on first render.
		</p>
		<p class="text-xs text-mist-500">
			World style: <span class="text-mist-300">{data.world.style_tag ?? '(unbound)'}</span>
		</p>
	</header>

	{#if form?.error}
		<p class="text-sm text-rose-400">{form.error}</p>
	{/if}

	<ul class="space-y-4">
		{#each data.locations as loc (loc.slug)}
			{@const hint = loc.map_hint as
				| {
						descriptor?: string;
						kind?: string;
						relative_direction?: string | null;
						relative_distance?: string | null;
						proposed_at?: number;
				  }
				| null}
			<li class="story-card px-4 py-3">
				<div class="flex flex-wrap items-baseline justify-between gap-2">
					<div>
						<div class="font-display text-lg text-mist-100">{loc.name}</div>
						<div class="text-xs text-mist-500">
							{loc.slug}
							{#if loc.biome}· <span class="text-teal-400">{loc.biome}</span>{/if}
							{#if loc.has_entity_pin}· <span class="text-candle-300">entity-pinned</span>
							{:else if loc.has_biome_pin}· <span class="text-candle-500">biome default</span>
							{:else}· <span class="text-rose-400">no tile</span>{/if}
						</div>
					</div>
					{#if form?.saved_slug === loc.slug}
						<span class="font-hand text-sm text-teal-400">saved</span>
					{:else if form?.cleared_slug === loc.slug}
						<span class="font-hand text-sm text-rose-400">cleared</span>
					{/if}
				</div>

				<form
					method="POST"
					action="?/save"
					class="mt-3 space-y-2"
					use:enhance={() => {
						savingSlug = loc.slug;
						return async ({ update }) => {
							await update({ reset: false });
							savingSlug = null;
						};
					}}
				>
					<input type="hidden" name="entity_slug" value={loc.slug} />
					<label class="block space-y-1">
						<span class="font-hand text-xs text-candle-400">descriptor</span>
						<textarea
							name="descriptor"
							rows="2"
							value={hint?.descriptor ?? ''}
							placeholder="a short, concrete prompt — e.g. stone well under oak canopy"
							class="storybook-input w-full resize-y text-sm"
						></textarea>
					</label>
					<div class="flex flex-wrap gap-2 text-xs">
						<label class="flex items-center gap-1">
							<span class="text-candle-500">kind</span>
							<select name="kind" class="storybook-input text-xs">
								{#each ['portrait', 'map_object', 'biome_tile', 'building', 'path', 'bridge', 'character_walk'] as k (k)}
									<option value={k} selected={(hint?.kind ?? 'portrait') === k}>{k}</option>
								{/each}
							</select>
						</label>
						<label class="flex items-center gap-1">
							<span class="text-candle-500">direction</span>
							<select name="relative_direction" class="storybook-input text-xs">
								<option value="">(none)</option>
								{#each ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw', 'up', 'down', 'in', 'out'] as d (d)}
									<option value={d} selected={hint?.relative_direction === d}>{d}</option>
								{/each}
							</select>
						</label>
						<label class="flex items-center gap-1">
							<span class="text-candle-500">distance</span>
							<select name="relative_distance" class="storybook-input text-xs">
								<option value="">(none)</option>
								{#each ['near', 'mid', 'far'] as x (x)}
									<option value={x} selected={hint?.relative_distance === x}>{x}</option>
								{/each}
							</select>
						</label>
					</div>
					<div class="flex gap-2">
						<button class="storybook-button text-xs" disabled={savingSlug === loc.slug}>
							{savingSlug === loc.slug ? 'saving…' : 'save'}
						</button>
						<button
							type="submit"
							formaction="?/clear"
							class="rounded border border-mist-800/60 px-3 py-1 text-xs text-mist-400 hover:text-rose-400"
							disabled={!hint}
						>
							clear
						</button>
					</div>
				</form>
			</li>
		{/each}
	</ul>

	{#if data.locations.length === 0}
		<p class="text-sm text-mist-500">(no canonical locations in this world yet)</p>
	{/if}
</section>
