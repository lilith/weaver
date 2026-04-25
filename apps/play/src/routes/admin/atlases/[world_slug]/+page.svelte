<script lang="ts">
	import { enhance } from '$app/forms';
	let { data, form } = $props();
	let name = $state('');
	let layerMode = $state<'solo' | 'stack' | 'toggle'>('solo');
	let pending = $state(false);

	const tonePresets = [
		{
			id: 'inked-vellum',
			label: 'inked vellum',
			hint: 'crisp linework, sepia, hand-lettered place names'
		},
		{
			id: 'watercolor-wash',
			label: 'watercolor wash',
			hint: 'soft edges, washed pigment, breathing white'
		},
		{
			id: 'celestial-chart',
			label: 'celestial chart',
			hint: 'starfield base, gold leaf, brass compass'
		}
	];
	let chosenTone = $state<string | null>(null);
</script>

<section class="space-y-10 py-6">
	<header class="space-y-2">
		<p class="font-hand text-base text-candle-300">atlases · curated maps</p>
		<h1 class="font-display text-3xl text-mist-100 sm:text-4xl">
			{data.world.name}
		</h1>
		<p class="max-w-prose text-sm text-mist-400">
			Atlases are creative maps. Multiple atlases per world, multiple layers
			per atlas — caves under, peaks above, dream alongside physical. Optional;
			the auto-graph map is still right where you left it.
		</p>
		{#if !data.flag.enabled}
			<p
				class="max-w-prose rounded border border-amber-500/40 bg-amber-950/30 p-3 text-sm text-amber-200/90"
			>
				⚠ <code>flag.atlases</code> is off for this world. Enable it in
				<a href="/admin/settings/{data.world.slug}" class="underline"
					>admin settings</a
				>; you can keep drafting here either way, but no one else will see
				published atlases until the flag is on.
			</p>
		{/if}
	</header>

	<section class="story-card space-y-4 px-6 py-5">
		<div class="space-y-1">
			<p class="font-hand text-2xl text-candle-300">begin a new atlas</p>
			<p class="text-sm text-mist-400">
				A name and a feeling — that's enough to start. Layers, landmarks,
				connections, edges, all later.
			</p>
		</div>

		<form
			method="POST"
			action="?/create"
			class="space-y-4"
			use:enhance={() => {
				pending = true;
				return async ({ update }) => {
					await update({ reset: false });
					pending = false;
				};
			}}
		>
			<label class="block space-y-1">
				<span class="font-hand text-base text-candle-300">name</span>
				<input
					type="text"
					name="name"
					maxlength="80"
					bind:value={name}
					placeholder="Quiet Vale — first sketch"
					class="storybook-input w-full"
					required
				/>
			</label>

			<fieldset class="space-y-2">
				<legend class="font-hand text-base text-candle-300">layer mode</legend>
				<div class="grid gap-2 sm:grid-cols-3">
					{#each [{ id: 'solo', label: 'solo', hint: 'one canvas, hand-drawn feel' }, { id: 'stack', label: 'stack', hint: 'caves → surface → peaks; scroll between' }, { id: 'toggle', label: 'toggle', hint: 'physical / political / dream — composable overlays' }] as opt (opt.id)}
						<label class="cursor-pointer">
							<input
								type="radio"
								name="layer_mode"
								value={opt.id}
								class="peer sr-only"
								checked={layerMode === opt.id}
								onchange={() => (layerMode = opt.id as any)}
							/>
							<span
								class="block rounded-xl border px-4 py-3 transition"
								class:border-rose-400={layerMode === opt.id}
								class:border-mist-800={layerMode !== opt.id}
								class:bg-rose-950={layerMode === opt.id}
								class:bg-velvet-800={layerMode !== opt.id}
								style:opacity={layerMode === opt.id ? 1 : 0.6}
							>
								<span class="font-display text-lg text-mist-100">{opt.label}</span>
								<span class="mt-1 block text-xs text-mist-400">{opt.hint}</span>
							</span>
						</label>
					{/each}
				</div>
			</fieldset>

			<details class="text-sm">
				<summary class="cursor-pointer font-hand text-base text-mist-400">
					optional · pick a tone (saved later)
				</summary>
				<div class="mt-3 grid gap-2 sm:grid-cols-3">
					{#each tonePresets as t (t.id)}
						<button
							type="button"
							class="choice-button"
							class:!border-candle-400={chosenTone === t.id}
							onclick={() => (chosenTone = chosenTone === t.id ? null : t.id)}
						>
							<span class="block font-display text-base text-candle-200"
								>{t.label}</span
							>
							<span class="mt-0.5 block text-xs text-mist-400">{t.hint}</span>
						</button>
					{/each}
				</div>
			</details>

			<button
				type="submit"
				class="storybook-button"
				disabled={pending || name.trim().length === 0}
			>
				{pending ? 'opening canvas…' : '✦ begin atlas'}
			</button>
		</form>

		{#if form?.error}
			<p class="text-sm text-rose-400">{form.error}</p>
		{/if}
	</section>

	{#if data.atlases.length > 0}
		<section class="space-y-3">
			<p class="font-hand text-2xl text-candle-300">
				atlases of {data.world.name.toLowerCase()}
			</p>
			<ul class="grid gap-3 sm:grid-cols-2">
				{#each data.atlases as a (a._id)}
					<li>
						<a
							href="/admin/atlases/{data.world.slug}/{a.slug}"
							class="story-card block px-5 py-4 space-y-2"
						>
							<div class="flex items-start gap-3">
								<div class="flex-1 space-y-1">
									<p class="font-display text-xl text-mist-100">{a.name}</p>
									<p class="font-hand text-sm text-mist-400">
										{a.layer_mode} · {a.placement_mode}{a.is_mine
											? ' · yours'
											: ''}
									</p>
								</div>
								{#if !a.published}
									<span
										class="rounded-full border border-candle-400/40 bg-candle-950/30 px-2 py-0.5 text-xs uppercase tracking-wide text-candle-300"
									>
										draft
									</span>
								{/if}
							</div>
							{#if a.style_anchor}
								<p class="text-xs italic text-mist-500">{a.style_anchor}</p>
							{/if}
							{#if a.description}
								<p class="line-clamp-2 text-sm text-mist-300">{a.description}</p>
							{/if}
						</a>
					</li>
				{/each}
			</ul>
		</section>
	{:else}
		<p class="font-hand text-base text-mist-500">
			no atlases yet. start one above — it takes a minute.
		</p>
	{/if}

	<nav class="pt-4 text-sm text-mist-500">
		<a href="/admin/{data.world.slug}" class="hover:text-candle-300">← admin</a>
	</nav>
</section>

<style>
	.bg-velvet-800 {
		background: rgba(43, 36, 79, 0.6);
	}
	.bg-rose-950 {
		background: rgba(204, 45, 94, 0.18);
	}
	.bg-candle-950\/30 {
		background: rgba(232, 160, 36, 0.18);
	}
</style>
