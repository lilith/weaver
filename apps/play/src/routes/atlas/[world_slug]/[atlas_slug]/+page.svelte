<script lang="ts">
	import { env } from '$env/dynamic/public';

	let { data } = $props();

	type Layer = (typeof data)['atlas']['layers'][number];

	const atlas = $derived(data.atlas.atlas);
	const layers = $derived(data.atlas.layers);
	const placements = $derived(data.atlas.placements);
	const r2Public = env.PUBLIC_R2_IMAGES_URL ?? '';

	function blobUrl(hash: string | null | undefined): string | null {
		if (!hash || !r2Public) return null;
		return `${r2Public}/blob/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
	}
	function entityNameById(id: string | null): string | null {
		if (!id) return null;
		const node = data.map?.nodes.find((n) => n.id === id);
		return node?.name ?? null;
	}
	function entitySlugById(id: string | null): string | null {
		if (!id) return null;
		const node = data.map?.nodes.find((n) => n.id === id);
		return node?.slug ?? null;
	}

	// Toggle mode shows multiple layers composed; users tick chips on/off.
	let visibleLayerSlugs = $state<Set<string>>(new Set());
	$effect(() => {
		// Initialize: in solo mode show all (just one); in toggle/stack
		// show all by default — viewer can hide layers via chips.
		if (visibleLayerSlugs.size === 0 && layers.length > 0) {
			visibleLayerSlugs = new Set(layers.map((l: Layer) => l.slug));
		}
	});

	function toggleLayer(slug: string) {
		const next = new Set(visibleLayerSlugs);
		if (next.has(slug)) next.delete(slug);
		else next.add(slug);
		visibleLayerSlugs = next;
	}

	const visibleLayers = $derived<Layer[]>(
		layers.filter((l: Layer) => visibleLayerSlugs.has(l.slug)),
	);

	// Solo & toggle mode render layers stacked z-index style; stack mode
	// places them vertically with smooth scroll between.
	const renderMode = $derived<'composed' | 'stacked'>(
		atlas.layer_mode === 'stack' ? 'stacked' : 'composed',
	);

	let activePlacementId = $state<string | null>(null);
	const activePlacement = $derived.by(() => {
		if (!activePlacementId) return null;
		for (const layer of layers) {
			const arr = placements[String(layer._id)] ?? [];
			const found = arr.find((p: any) => String(p._id) === activePlacementId);
			if (found) return { layer, p: found };
		}
		return null;
	});
</script>

<section class="viewer-shell">
	<header class="viewer-header">
		<div class="space-y-1 min-w-0">
			<p class="font-hand text-base text-candle-300">
				atlas <span class="text-mist-500">·</span> {data.world.name}
			</p>
			<h1 class="font-display text-3xl text-mist-100 sm:text-4xl">
				{atlas.name}
			</h1>
			{#if atlas.description}
				<p class="max-w-prose text-sm italic text-mist-400">
					{atlas.description}
				</p>
			{/if}
		</div>
		<div class="flex items-center gap-2 flex-wrap">
			<span
				class="rounded-full border px-3 py-1 text-xs uppercase tracking-wide"
				class:border-candle-400={!atlas.published}
				class:text-candle-300={!atlas.published}
				class:border-teal-400={atlas.published}
				class:text-teal-300={atlas.published}
			>
				{atlas.published ? 'published' : 'draft'}
			</span>
			{#if atlas.is_mine}
				<a
					href="/admin/atlases/{data.world.slug}/{atlas.slug}"
					class="font-hand text-sm text-teal-400 hover:text-rose-400"
				>
					edit
				</a>
			{/if}
		</div>
	</header>

	{#if layers.length > 1 && atlas.layer_mode === 'toggle'}
		<div class="viewer-layer-chips">
			{#each layers as layer (layer._id)}
				<button
					type="button"
					class="viewer-layer-chip"
					class:is-on={visibleLayerSlugs.has(layer.slug)}
					onclick={() => toggleLayer(layer.slug)}
				>
					<span class="font-hand text-xs text-mist-500">{layer.kind}</span>
					<span class="font-display text-sm">{layer.name}</span>
				</button>
			{/each}
		</div>
	{/if}

	{#if renderMode === 'stacked'}
		<!-- Stack mode: each layer is its own vertical card; viewer scrolls. -->
		<div class="viewer-stack">
			{#each layers as layer (layer._id)}
				{@const ps = placements[String(layer._id)] ?? []}
				<section class="viewer-stack-panel">
					<header class="viewer-stack-head">
						<span class="font-hand text-sm text-mist-500">{layer.kind}</span>
						<h2 class="font-display text-lg text-mist-100">{layer.name}</h2>
					</header>
					<div
						class="viewer-canvas"
						style:background-image={layer.basemap_blob_hash
							? `url(${blobUrl(layer.basemap_blob_hash)})`
							: ''}
						class:has-basemap={!!layer.basemap_blob_hash}
					>
						{#each ps as p (p._id)}
							{#if p.visibility !== 'hidden'}
								{@const label =
									p.custom_label ?? entityNameById(p.entity_id) ?? '?'}
								<button
									type="button"
									class="viewer-pin"
									class:is-line={p.visibility === 'line'}
									style:left="{(p.x ?? 0) * 100}%"
									style:top="{(p.y ?? 0) * 100}%"
									onclick={(e) => {
										e.stopPropagation();
										activePlacementId =
											activePlacementId === String(p._id)
												? null
												: String(p._id);
									}}
								>
									<span class="viewer-dot"></span>
									{#if p.visibility === 'icon'}
										<span class="viewer-label">{label}</span>
									{/if}
								</button>
							{/if}
						{/each}
					</div>
				</section>
			{/each}
		</div>
	{:else}
		<!-- Composed mode: every visible layer painted on a single canvas;
		     basemaps stack with the highest-order on top. -->
		<div class="viewer-canvas viewer-composed">
			{#each visibleLayers as layer (layer._id)}
				{#if layer.basemap_blob_hash}
					<img
						class="viewer-basemap"
						src={blobUrl(layer.basemap_blob_hash)}
						alt=""
						style:opacity={atlas.layer_mode === 'toggle' ? 0.7 : 1}
					/>
				{/if}
				{@const ps = placements[String(layer._id)] ?? []}
				{#each ps as p (p._id)}
					{#if p.visibility !== 'hidden'}
						{@const label =
							p.custom_label ?? entityNameById(p.entity_id) ?? '?'}
						<button
							type="button"
							class="viewer-pin"
							class:is-line={p.visibility === 'line'}
							style:left="{(p.x ?? 0) * 100}%"
							style:top="{(p.y ?? 0) * 100}%"
							onclick={(e) => {
								e.stopPropagation();
								activePlacementId =
									activePlacementId === String(p._id) ? null : String(p._id);
							}}
						>
							<span class="viewer-dot"></span>
							{#if p.visibility === 'icon'}
								<span class="viewer-label">{label}</span>
							{/if}
						</button>
					{/if}
				{/each}
			{/each}
			{#if visibleLayers.length === 0}
				<p class="viewer-empty">no layers visible — pick at least one above.</p>
			{/if}
		</div>
	{/if}

	{#if activePlacement}
		<aside class="viewer-detail">
			<p class="font-hand text-base text-candle-300">
				{activePlacement.layer.name} <span class="text-mist-600">·</span>
				{activePlacement.p.visibility}
			</p>
			<p class="font-display text-xl text-mist-100">
				{activePlacement.p.custom_label ??
					entityNameById(activePlacement.p.entity_id) ??
					'unnamed'}
			</p>
			{#if activePlacement.p.icon_prompt}
				<p class="text-sm italic text-mist-400">
					{activePlacement.p.icon_prompt}
				</p>
			{/if}
			{#if activePlacement.p.entity_id && entitySlugById(activePlacement.p.entity_id)}
				<a
					href="/play/{data.world.slug}/{entitySlugById(activePlacement.p.entity_id)}"
					class="font-hand text-sm text-teal-400 hover:text-rose-400"
				>
					→ visit in play
				</a>
			{/if}
			<button
				type="button"
				class="viewer-detail-close"
				onclick={() => (activePlacementId = null)}
				aria-label="close"
			>
				×
			</button>
		</aside>
	{/if}

	<nav class="pt-4 text-sm text-mist-500">
		<a href="/admin/atlases/{data.world.slug}" class="hover:text-candle-300">
			← all atlases of {data.world.name}
		</a>
	</nav>
</section>

<style>
	.viewer-shell {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
		padding: 1rem 0 4rem;
	}
	.viewer-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
	}

	.viewer-layer-chips {
		display: flex;
		gap: 0.45rem;
		flex-wrap: wrap;
	}
	.viewer-layer-chip {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		padding: 0.35rem 0.75rem;
		border-radius: 999px;
		background: rgba(20, 17, 40, 0.5);
		border: 1px solid rgba(159, 140, 210, 0.18);
		color: var(--color-mist-400);
		cursor: pointer;
		line-height: 1.1;
		transition: border-color 140ms ease, background 140ms ease, opacity 140ms ease;
		opacity: 0.55;
	}
	.viewer-layer-chip:hover {
		border-color: var(--color-teal-400);
	}
	.viewer-layer-chip.is-on {
		opacity: 1;
		border-color: var(--color-rose-400);
		background: rgba(204, 45, 94, 0.16);
		color: var(--color-mist-100);
	}

	.viewer-canvas {
		position: relative;
		width: 100%;
		aspect-ratio: 1.4 / 1;
		border-radius: 0.875rem;
		border: 1px solid rgba(159, 140, 210, 0.18);
		overflow: hidden;
		background:
			radial-gradient(
				ellipse 60% 50% at 30% 30%,
				rgba(232, 160, 36, 0.12),
				transparent 60%
			),
			radial-gradient(
				ellipse 70% 55% at 70% 75%,
				rgba(45, 189, 148, 0.08),
				transparent 60%
			),
			linear-gradient(180deg, rgba(20, 17, 40, 0.85), rgba(12, 10, 24, 0.95));
	}
	.viewer-canvas.has-basemap {
		background-size: cover;
		background-position: center;
		background-repeat: no-repeat;
		border-color: rgba(232, 160, 36, 0.32);
	}
	.viewer-composed .viewer-basemap {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
		mix-blend-mode: normal;
	}
	.viewer-empty {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		font-family: var(--font-hand);
		color: var(--color-mist-500);
	}

	.viewer-stack {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}
	.viewer-stack-panel {
		position: relative;
		background: linear-gradient(
			145deg,
			rgba(43, 36, 79, 0.7),
			rgba(26, 22, 52, 0.86)
		);
		border: 1px solid rgba(159, 140, 210, 0.18);
		border-radius: 0.875rem;
		padding: 0.85rem;
	}
	.viewer-stack-head {
		display: flex;
		align-items: baseline;
		gap: 0.6rem;
		padding-bottom: 0.5rem;
	}

	.viewer-pin {
		position: absolute;
		transform: translate(-50%, -100%);
		display: inline-flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
		padding: 0.1rem 0.45rem;
		background: rgba(20, 17, 40, 0.85);
		border: 1px solid rgba(232, 160, 36, 0.55);
		border-radius: 0.5rem;
		color: var(--color-candle-200);
		font-family: var(--font-hand);
		font-size: 0.85rem;
		cursor: pointer;
		box-shadow:
			0 1px 4px rgba(0, 0, 0, 0.5),
			0 0 16px rgba(232, 160, 36, 0.18);
		max-width: 7rem;
	}
	.viewer-pin.is-line {
		padding: 0.1rem 0.25rem;
		background: transparent;
		border: none;
		box-shadow: none;
	}
	.viewer-dot {
		display: block;
		width: 8px;
		height: 8px;
		border-radius: 999px;
		background: var(--color-candle-400);
		box-shadow: 0 0 8px var(--color-candle-400);
	}
	.viewer-pin.is-line .viewer-dot {
		width: 5px;
		height: 5px;
		background: var(--color-mist-400);
		box-shadow: none;
		opacity: 0.7;
	}
	.viewer-label {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 7rem;
	}
	@media (min-width: 720px) {
		.viewer-pin,
		.viewer-label {
			max-width: 9rem;
		}
	}

	.viewer-detail {
		position: relative;
		background: linear-gradient(
			145deg,
			rgba(43, 36, 79, 0.92),
			rgba(26, 22, 52, 0.95)
		);
		border: 1px solid rgba(232, 160, 36, 0.4);
		border-radius: 0.875rem;
		padding: 0.85rem 2.4rem 0.85rem 1.2rem;
		box-shadow: var(--glow-candle);
	}
	.viewer-detail-close {
		position: absolute;
		top: 0.4rem;
		right: 0.6rem;
		width: 2rem;
		height: 2rem;
		border: none;
		background: transparent;
		color: var(--color-mist-500);
		font-size: 1.5rem;
		cursor: pointer;
	}
	.viewer-detail-close:hover {
		color: var(--color-rose-400);
	}
</style>
