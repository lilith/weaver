<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';

	let { data, form } = $props();

	type Atlas = (typeof data)['atlas']['atlas'];
	type Layer = (typeof data)['atlas']['layers'][number];
	type Placement = NonNullable<
		(typeof data)['atlas']['placements'][string]
	>[number];
	type MapNode = NonNullable<typeof data.map>['nodes'][number];

	// `data.atlas` is the wrapper { atlas, layers, placements }; alias
	// the inner pieces so the markup reads naturally — `atlas` always
	// means the inner atlas record (with name/description/published…),
	// and layers/placements are siblings.
	const atlas = $derived(data.atlas.atlas);
	const layers = $derived(data.atlas.layers);
	const placements = $derived(data.atlas.placements);

	// ----- local state -----------------------------------------------
	let selectedLayerSlug = $state<string>('');
	let selectedEntitySlug = $state<string | null>(null);
	let entitySearch = $state('');
	let dragId = $state<string | null>(null);
	let canvasEl = $state<HTMLDivElement | null>(null);

	// Seed (and re-seed) selected layer when the list changes — covers
	// add/delete and the first render where state is initially "".
	$effect(() => {
		if (
			layers.length > 0 &&
			!layers.find((l: Layer) => l.slug === selectedLayerSlug)
		) {
			selectedLayerSlug = layers[0].slug;
		}
	});

	const selectedLayer = $derived<Layer | null>(
		layers.find((l: Layer) => l.slug === selectedLayerSlug) ?? null,
	);

	const placedOnLayer = $derived<Placement[]>(
		selectedLayer
			? (placements[String(selectedLayer._id)] ?? [])
			: [],
	);

	const placedEntitySlugs = $derived(
		new Set(
			placedOnLayer
				.map((p) => entitySlugById(p.entity_id))
				.filter((s): s is string => s !== null),
		),
	);

	function entitySlugById(id: string | null): string | null {
		if (!id) return null;
		const node = data.map?.nodes.find((n) => n.id === id);
		return node?.slug ?? null;
	}
	function entityNameById(id: string | null): string | null {
		if (!id) return null;
		const node = data.map?.nodes.find((n) => n.id === id);
		return node?.name ?? null;
	}

	const filteredEntities = $derived<MapNode[]>(
		(data.map?.nodes ?? []).filter((n) =>
			!entitySearch.trim()
				? true
				: n.name.toLowerCase().includes(entitySearch.toLowerCase()) ||
					n.slug.toLowerCase().includes(entitySearch.toLowerCase()),
		),
	);

	function placeAtCanvas(evt: MouseEvent | TouchEvent, layer_slug: string) {
		if (!selectedEntitySlug) return;
		if (!canvasEl) return;
		const rect = canvasEl.getBoundingClientRect();
		const point = 'touches' in evt ? evt.touches[0] : (evt as MouseEvent);
		const x = (point.clientX - rect.left) / rect.width;
		const y = (point.clientY - rect.top) / rect.height;
		if (x < 0 || x > 1 || y < 0 || y > 1) return;
		// Submit the placement via a hidden form post (uses ?/placePin).
		const fd = new FormData();
		fd.set('layer_slug', layer_slug);
		fd.set('entity_slug', selectedEntitySlug);
		fd.set('x', String(x));
		fd.set('y', String(y));
		fd.set('visibility', 'icon');
		fetch(`?/placePin`, { method: 'POST', body: fd }).then(async () => {
			selectedEntitySlug = null;
			await invalidateAll();
		});
	}

	function startDrag(evt: PointerEvent, placement: Placement) {
		dragId = String(placement._id);
		(evt.currentTarget as HTMLElement).setPointerCapture(evt.pointerId);
	}
	function dragMove(evt: PointerEvent, placement: Placement) {
		if (dragId !== String(placement._id) || !canvasEl) return;
		const rect = canvasEl.getBoundingClientRect();
		const x = Math.min(1, Math.max(0, (evt.clientX - rect.left) / rect.width));
		const y = Math.min(1, Math.max(0, (evt.clientY - rect.top) / rect.height));
		// Update the visual position immediately via a transient transform,
		// then commit on pointerup.
		const el = evt.currentTarget as HTMLElement;
		el.style.left = `${x * 100}%`;
		el.style.top = `${y * 100}%`;
		(el as any)._weaverDragX = x;
		(el as any)._weaverDragY = y;
	}
	function endDrag(evt: PointerEvent, placement: Placement) {
		if (dragId !== String(placement._id)) return;
		dragId = null;
		const el = evt.currentTarget as HTMLElement;
		const x = (el as any)._weaverDragX;
		const y = (el as any)._weaverDragY;
		if (typeof x !== 'number' || typeof y !== 'number') return;
		// Only commit if we actually moved beyond a small threshold —
		// otherwise treat it as a tap (no-op for now).
		const moved =
			Math.abs(x - (placement.x ?? 0)) > 0.005 ||
			Math.abs(y - (placement.y ?? 0)) > 0.005;
		if (!moved) return;
		const fd = new FormData();
		fd.set('layer_slug', selectedLayerSlug);
		fd.set('placement_id', String(placement._id));
		if (placement.entity_id) {
			const slug = entitySlugById(placement.entity_id);
			if (slug) fd.set('entity_slug', slug);
		}
		if (placement.custom_label) fd.set('custom_label', placement.custom_label);
		fd.set('x', String(x));
		fd.set('y', String(y));
		fd.set('visibility', placement.visibility);
		fetch(`?/placePin`, { method: 'POST', body: fd }).then(async () => {
			await invalidateAll();
		});
	}

	const stepProgress = $derived.by(() => {
		// Simple progress signal — gives the user a sense of "how far am I"
		// without enforcing a strict order.
		const hasName = atlas.name.trim().length > 0;
		const hasLayers = layers.length > 0;
		const hasPlacements = Object.values(placements ?? {}).some(
			(arr) => Array.isArray(arr) && arr.length > 0,
		);
		const isPublished = atlas.published;
		const done = [hasName, hasLayers, hasPlacements, isPublished].filter(
			Boolean,
		).length;
		return { done, total: 4 };
	});
</script>

<section class="atlas-shell">
	<header class="atlas-header">
		<div class="space-y-1 min-w-0">
			<p class="font-hand text-base text-candle-300">
				atlas <span class="text-mist-500">·</span> {data.world.name}
			</p>
			<h1 class="font-display text-3xl text-mist-100 sm:text-4xl truncate">
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
			<span class="font-hand text-sm text-mist-500">
				step {stepProgress.done}/{stepProgress.total}
			</span>
		</div>
	</header>

	{#if form?.error}
		<p class="atlas-flash text-rose-300">{form.error}</p>
	{/if}
	{#if form?.saved}
		<p class="atlas-flash text-teal-300">✓ saved.</p>
	{/if}

	<!-- ============ Card 1: Tone ============ -->
	<details class="atlas-card" open={atlas.description == null}>
		<summary class="atlas-card-summary">
			<span class="atlas-card-num">1</span>
			<span>
				<span class="font-display text-xl text-mist-100">name + tone</span>
				<span class="block font-hand text-sm text-mist-400">
					{atlas.style_anchor
						? '✓ tone set'
						: 'a sentence about how this map should feel'}
				</span>
			</span>
		</summary>
		<form
			method="POST"
			action="?/rename"
			class="space-y-3 px-1 pb-1 pt-3"
			use:enhance
		>
			<label class="block space-y-1">
				<span class="font-hand text-base text-candle-300">name</span>
				<input
					type="text"
					name="name"
					maxlength="80"
					value={atlas.name}
					class="storybook-input w-full"
					required
				/>
			</label>
			<label class="block space-y-1">
				<span class="font-hand text-base text-candle-300">
					describe the feeling
				</span>
				<textarea
					name="description"
					rows="2"
					maxlength="400"
					placeholder="What does this map feel like to look at?"
					class="storybook-input w-full"
					>{atlas.description ?? ''}</textarea
				>
			</label>
			<label class="block space-y-1">
				<span class="font-hand text-base text-candle-300">
					style anchor (for AI-generated icons + basemap)
				</span>
				<input
					type="text"
					name="style_anchor"
					maxlength="500"
					value={atlas.style_anchor ?? ''}
					placeholder="medieval ink-and-watercolor with rough coastlines"
					class="storybook-input w-full"
				/>
			</label>
			<button type="submit" class="storybook-button">save name + tone</button>
		</form>
	</details>

	<!-- ============ Card 2: Layers ============ -->
	<details class="atlas-card" open={layers.length <= 1}>
		<summary class="atlas-card-summary">
			<span class="atlas-card-num">2</span>
			<span>
				<span class="font-display text-xl text-mist-100">layers</span>
				<span class="block font-hand text-sm text-mist-400">
					{atlas.layer_mode === 'solo'
						? 'solo mode — one canvas'
						: atlas.layer_mode === 'stack'
							? 'stack — caves under, peaks above'
							: 'toggle — composable overlays'} ·
					{layers.length} layer{layers.length === 1
						? ''
						: 's'}
				</span>
			</span>
		</summary>

		<div class="space-y-3 px-1 pb-1 pt-3">
			<ul class="grid gap-2 sm:grid-cols-2">
				{#each layers as layer (layer._id)}
					<li class="atlas-layer-row">
						<button
							type="button"
							class="layer-chip"
							class:is-active={layer.slug === selectedLayerSlug}
							onclick={() => (selectedLayerSlug = layer.slug)}
						>
							<span class="layer-chip-name">{layer.name}</span>
							<span class="layer-chip-kind">{layer.kind}</span>
						</button>
						{#if layers.length > 1}
							<form method="POST" action="?/deleteLayer" use:enhance>
								<input type="hidden" name="layer_slug" value={layer.slug} />
								<button
									type="submit"
									class="layer-remove"
									title="remove layer"
								>
									×
								</button>
							</form>
						{/if}
					</li>
				{/each}
			</ul>

			{#if atlas.layer_mode !== 'solo'}
				<form
					method="POST"
					action="?/addLayer"
					class="flex gap-2 flex-wrap"
					use:enhance
				>
					<input
						type="text"
						name="name"
						placeholder="new layer name (e.g. 'caves')"
						class="storybook-input flex-1 min-w-0"
						maxlength="80"
						required
					/>
					<select name="kind" class="storybook-input">
						{#each ['physical', 'spiritual', 'political', 'seasonal', 'dream', 'caves', 'peaks', 'coast', 'other'] as k (k)}
							<option value={k}>{k}</option>
						{/each}
					</select>
					<button type="submit" class="storybook-button">add layer</button>
				</form>
			{/if}
		</div>
	</details>

	<!-- ============ Card 3: Landmarks ============ -->
	<details class="atlas-card" open>
		<summary class="atlas-card-summary">
			<span class="atlas-card-num">3</span>
			<span>
				<span class="font-display text-xl text-mist-100">landmarks</span>
				<span class="block font-hand text-sm text-mist-400">
					tap a place, then tap the canvas. drag to reposition.
				</span>
			</span>
		</summary>

		{#if layers.length > 1}
			<div class="layer-switcher pt-3">
				{#each layers as layer (layer._id)}
					<button
						type="button"
						class="layer-switch-chip"
						class:is-active={layer.slug === selectedLayerSlug}
						onclick={() => (selectedLayerSlug = layer.slug)}
					>
						<span class="font-hand text-xs text-mist-500">{layer.kind}</span>
						<span class="font-display text-sm">{layer.name}</span>
					</button>
				{/each}
			</div>
		{/if}

		<div class="atlas-canvas-shell pt-3">
			<aside class="atlas-rail" data-area="rail">
				<input
					type="text"
					placeholder="search places…"
					bind:value={entitySearch}
					class="storybook-input w-full text-sm"
				/>
				<p class="font-hand text-xs text-mist-500 px-1">
					{filteredEntities.length} place{filteredEntities.length === 1
						? ''
						: 's'} ·
					{placedEntitySlugs.size} placed
				</p>
				<ul class="atlas-rail-list">
					{#each filteredEntities as node (node.id)}
						<li>
							<button
								type="button"
								class="rail-item"
								class:is-selected={selectedEntitySlug === node.slug}
								class:is-placed={placedEntitySlugs.has(node.slug)}
								onclick={() =>
									(selectedEntitySlug =
										selectedEntitySlug === node.slug ? null : node.slug)}
							>
								<span class="rail-item-name">{node.name}</span>
								<span class="rail-item-meta">
									{node.biome ?? '—'}
									{#if placedEntitySlugs.has(node.slug)}
										<span class="rail-placed">●</span>
									{/if}
								</span>
							</button>
						</li>
					{/each}
				</ul>
			</aside>

			<div
				class="atlas-canvas"
				class:is-arming={!!selectedEntitySlug}
				bind:this={canvasEl}
				onclick={(e) => selectedLayer && placeAtCanvas(e, selectedLayer.slug)}
				role="presentation"
				data-area="canvas"
			>
				{#if !selectedLayer}
					<p class="atlas-empty">no layer yet — add one above.</p>
				{:else}
					<div class="atlas-canvas-hint">
						<span class="font-hand text-xs">
							{selectedLayer.name} <span class="text-mist-600">·</span>
							{placedOnLayer.length} placement{placedOnLayer.length === 1
								? ''
								: 's'}
						</span>
						{#if selectedEntitySlug}
							<span class="font-hand text-xs text-rose-300">
								tap to place: {data.map?.nodes.find(
									(n) => n.slug === selectedEntitySlug,
								)?.name ?? selectedEntitySlug}
							</span>
						{:else if placedOnLayer.length === 0}
							<span class="font-hand text-xs text-mist-500">
								pick a place at left to drop your first landmark
							</span>
						{/if}
					</div>

					{#each placedOnLayer as p (p._id)}
						{@const label =
							p.custom_label ?? entityNameById(p.entity_id) ?? '?'}
						<button
							type="button"
							class="placement-pin"
							style:left="{(p.x ?? 0) * 100}%"
							style:top="{(p.y ?? 0) * 100}%"
							onpointerdown={(e) => startDrag(e, p)}
							onpointermove={(e) => dragMove(e, p)}
							onpointerup={(e) => endDrag(e, p)}
							onclick={(e) => e.stopPropagation()}
						>
							<span class="placement-dot"></span>
							<span class="placement-label">{label}</span>
						</button>
					{/each}
				{/if}
			</div>
		</div>

		{#if placedOnLayer.length > 0}
			<details class="atlas-placements-list">
				<summary class="font-hand text-sm text-mist-400 cursor-pointer">
					placements on {selectedLayer?.name} ({placedOnLayer.length})
				</summary>
				<ul class="mt-2 space-y-1 text-sm">
					{#each placedOnLayer as p (p._id)}
						<li class="flex items-center gap-2">
							<span class="font-hand text-xs text-mist-500 tabular-nums">
								({(p.x ?? 0).toFixed(2)}, {(p.y ?? 0).toFixed(2)})
							</span>
							<span class="text-mist-300 flex-1 truncate">
								{p.custom_label ?? entityNameById(p.entity_id) ?? '?'}
							</span>
							<form method="POST" action="?/removePin" use:enhance>
								<input
									type="hidden"
									name="placement_id"
									value={String(p._id)}
								/>
								<button
									type="submit"
									class="text-xs text-mist-500 hover:text-rose-400"
								>
									remove
								</button>
							</form>
						</li>
					{/each}
				</ul>
			</details>
		{/if}
	</details>

	<!-- ============ Card 4: Publish ============ -->
	<details class="atlas-card" open={!atlas.published}>
		<summary class="atlas-card-summary">
			<span class="atlas-card-num">4</span>
			<span>
				<span class="font-display text-xl text-mist-100">share</span>
				<span class="block font-hand text-sm text-mist-400">
					{atlas.published
						? 'others in your world can see this'
						: 'only you can see this draft'}
				</span>
			</span>
		</summary>
		<form
			method="POST"
			action="?/rename"
			class="space-y-2 px-1 pb-1 pt-3"
			use:enhance
		>
			<input
				type="hidden"
				name="published"
				value={atlas.published ? 'false' : 'true'}
			/>
			<button type="submit" class="storybook-button">
				{atlas.published ? 'unpublish (back to draft)' : '✦ publish atlas'}
			</button>
			<p class="text-xs text-mist-500">
				you can flip this any time. publishing doesn't lock anything — keep
				editing whenever the map asks for it.
			</p>
		</form>
	</details>

	<nav class="pt-4 text-sm text-mist-500">
		<a href="/admin/atlases/{data.world.slug}" class="hover:text-candle-300">
			← all atlases of {data.world.name}
		</a>
	</nav>
</section>

<style>
	.atlas-shell {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
		padding-bottom: 4rem;
	}
	.atlas-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
		padding-top: 1rem;
	}
	.atlas-flash {
		font-family: var(--font-hand);
		padding: 0.4rem 0.6rem;
		border-radius: 0.5rem;
		background: rgba(20, 17, 40, 0.5);
	}
	.atlas-card {
		background: linear-gradient(
			145deg,
			rgba(43, 36, 79, 0.86),
			rgba(26, 22, 52, 0.9)
		);
		border: 1px solid rgba(159, 140, 210, 0.18);
		border-radius: 0.875rem;
		padding: 0.75rem 1rem;
		box-shadow: var(--shadow-panel);
	}
	.atlas-card[open] {
		border-color: rgba(232, 160, 36, 0.32);
	}
	.atlas-card-summary {
		display: flex;
		gap: 0.85rem;
		align-items: center;
		cursor: pointer;
		list-style: none;
		padding: 0.4rem 0.2rem;
	}
	.atlas-card-summary::-webkit-details-marker {
		display: none;
	}
	.atlas-card-num {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 999px;
		background: linear-gradient(
			180deg,
			var(--color-candle-300),
			var(--color-candle-500)
		);
		color: var(--color-ink-950);
		font-family: var(--font-display);
		font-size: 1.1rem;
		font-weight: 600;
		box-shadow:
			inset 0 1px 0 rgba(255, 255, 255, 0.4),
			var(--glow-candle);
		flex-shrink: 0;
	}

	/* ============ layer chips ============ */
	.atlas-layer-row {
		display: flex;
		gap: 0.4rem;
		align-items: stretch;
	}
	.layer-chip {
		flex: 1;
		text-align: left;
		padding: 0.6rem 0.85rem;
		background: rgba(20, 17, 40, 0.55);
		border: 1px solid rgba(159, 140, 210, 0.22);
		border-radius: 0.6rem;
		cursor: pointer;
		transition: border-color 140ms ease, background 140ms ease;
	}
	.layer-chip:hover {
		border-color: var(--color-teal-400);
	}
	.layer-chip.is-active {
		border-color: var(--color-rose-400);
		background: rgba(204, 45, 94, 0.12);
	}
	.layer-chip-name {
		display: block;
		font-family: var(--font-display);
		font-size: 1.05rem;
		color: var(--color-mist-100);
	}
	.layer-chip-kind {
		display: block;
		font-family: var(--font-hand);
		font-size: 0.85rem;
		color: var(--color-mist-500);
	}
	.layer-remove {
		width: 2rem;
		height: 100%;
		min-height: 2.5rem;
		border-radius: 0.5rem;
		background: rgba(20, 17, 40, 0.5);
		border: 1px solid rgba(159, 140, 210, 0.18);
		color: var(--color-mist-500);
		font-size: 1.2rem;
		cursor: pointer;
	}
	.layer-remove:hover {
		color: var(--color-rose-400);
		border-color: var(--color-rose-400);
	}

	/* ============ layer switcher ============ */
	.layer-switcher {
		display: flex;
		gap: 0.4rem;
		flex-wrap: wrap;
	}
	.layer-switch-chip {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		padding: 0.35rem 0.75rem;
		border-radius: 999px;
		background: rgba(20, 17, 40, 0.5);
		border: 1px solid rgba(159, 140, 210, 0.18);
		color: var(--color-mist-300);
		cursor: pointer;
		line-height: 1.1;
		transition: border-color 140ms ease, background 140ms ease;
	}
	.layer-switch-chip:hover {
		border-color: var(--color-teal-400);
	}
	.layer-switch-chip.is-active {
		border-color: var(--color-rose-400);
		background: rgba(204, 45, 94, 0.16);
		color: var(--color-mist-100);
	}

	/* ============ canvas + rail ============ */
	.atlas-canvas-shell {
		display: grid;
		grid-template-columns: 1fr;
		gap: 0.75rem;
		min-width: 0;
	}
	/* Mobile: canvas first so tapping a place at the rail below brings
	   you straight into "tap somewhere on the map" instead of forcing a
	   scroll. Desktop reverts to rail-then-canvas reading order. */
	.atlas-canvas-shell [data-area='canvas'] {
		order: 1;
	}
	.atlas-canvas-shell [data-area='rail'] {
		order: 2;
	}
	@media (min-width: 720px) {
		.atlas-canvas-shell {
			grid-template-columns: 240px minmax(0, 1fr);
		}
		.atlas-canvas-shell [data-area='canvas'] {
			order: unset;
		}
		.atlas-canvas-shell [data-area='rail'] {
			order: unset;
		}
	}
	.atlas-rail {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		min-height: 0;
		max-height: min(60vh, 520px);
		overflow: hidden;
	}
	.atlas-rail-list {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding-right: 0.25rem;
	}
	.rail-item {
		display: block;
		width: 100%;
		text-align: left;
		padding: 0.5rem 0.6rem;
		border-radius: 0.5rem;
		border: 1px solid rgba(159, 140, 210, 0.16);
		background: rgba(20, 17, 40, 0.5);
		cursor: pointer;
		transition: border-color 140ms ease, background 140ms ease;
	}
	.rail-item:hover {
		border-color: var(--color-teal-400);
	}
	.rail-item.is-selected {
		border-color: var(--color-rose-400);
		background: rgba(204, 45, 94, 0.14);
	}
	.rail-item.is-placed {
		opacity: 0.65;
	}
	.rail-item-name {
		display: block;
		font-family: var(--font-display);
		font-size: 0.95rem;
		color: var(--color-mist-100);
		line-height: 1.2;
	}
	.rail-item-meta {
		display: flex;
		justify-content: space-between;
		align-items: center;
		font-family: var(--font-hand);
		font-size: 0.8rem;
		color: var(--color-mist-500);
	}
	.rail-placed {
		color: var(--color-teal-400);
	}

	.atlas-canvas {
		position: relative;
		width: 100%;
		min-width: 0;
		aspect-ratio: 1.4 / 1;
		max-height: 70vh;
		border-radius: 0.875rem;
		border: 1px dashed rgba(159, 140, 210, 0.28);
		background:
			radial-gradient(
				ellipse 60% 50% at 30% 30%,
				rgba(232, 160, 36, 0.12),
				transparent 60%
			),
			radial-gradient(
				ellipse 70% 55% at 70% 75%,
				rgba(45, 189, 148, 0.1),
				transparent 60%
			),
			linear-gradient(180deg, rgba(20, 17, 40, 0.85), rgba(12, 10, 24, 0.95));
		overflow: hidden;
		cursor: crosshair;
	}
	.atlas-canvas.is-arming {
		border-color: var(--color-rose-400);
		box-shadow: 0 0 0 2px rgba(240, 80, 128, 0.18) inset;
	}
	.atlas-canvas:not(.is-arming) {
		cursor: default;
	}
	.atlas-empty {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--color-mist-500);
		font-family: var(--font-hand);
		font-size: 1rem;
	}
	.atlas-canvas-hint {
		position: absolute;
		top: 0.5rem;
		left: 0.6rem;
		right: 0.6rem;
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.5rem;
		pointer-events: none;
		color: var(--color-mist-500);
	}

	.placement-pin {
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
		cursor: grab;
		touch-action: none;
		box-shadow:
			0 1px 4px rgba(0, 0, 0, 0.5),
			0 0 16px rgba(232, 160, 36, 0.2);
		max-width: 9rem;
	}
	.placement-pin:active {
		cursor: grabbing;
	}
	.placement-dot {
		display: block;
		width: 8px;
		height: 8px;
		margin-bottom: 1px;
		border-radius: 999px;
		background: var(--color-candle-400);
		box-shadow: 0 0 8px var(--color-candle-400);
	}
	.placement-label {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 7rem;
	}
	@media (min-width: 720px) {
		.placement-label {
			max-width: 9rem;
		}
	}

	.atlas-placements-list {
		margin-top: 0.6rem;
		padding: 0.4rem 0.5rem;
		border-radius: 0.5rem;
		background: rgba(20, 17, 40, 0.4);
	}
</style>
