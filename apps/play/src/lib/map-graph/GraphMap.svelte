<script lang="ts">
	// <GraphMap> — spec 26 Layer 3.
	//
	// Stateless-ish — data comes via prop (already shaped by
	// convex/graph.ts#loadGraphMap), layout is computed client-side via
	// the pure engine module, pin mutations fire through
	// useConvexClient.
	//
	// Design rules baked in:
	//   - SVG viewBox so pan + zoom is just CSS transform math.
	//   - Deterministic layout per branch_id (so two family members
	//     see the same graph pre-pin).
	//   - Cardinal edges bias the force sim so "north" stays up-ish.
	//   - Pinned nodes act as soft attractors; shared across family.

	import { goto } from '$app/navigation';
	import { useConvexClient } from 'convex-svelte';
	import { api } from '$convex/_generated/api';
	import {
		layout,
		seedFromKey,
		type GraphNode,
		type GraphEdge,
		type LayoutMode
	} from '@weaver/engine/graph-layout';

	type BundleNode = {
		id: string;
		slug: string;
		name: string;
		biome: string | null;
		subgraph: string;
		map_shape: 'spatial' | 'action' | 'floating' | null;
		draft: boolean;
		parent_slug: string | null;
		tile_url: string | null;
		palette_fill: string | null;
		neighbors: Record<string, string>;
		pin: { x: number; y: number } | null;
		map_hint: unknown | null;
		tags: string[];
	};
	type BundleEdge = { from: string; to: string; direction: string; traffic: number };

	let {
		bundle,
		worldSlug,
		sessionToken,
		canvasWidth = 1200,
		canvasHeight = 800,
		initialMode = 'force'
	} = $props<{
		bundle: {
			world: { id: string; slug: string; name: string; style_tag: string | null };
			subgraphs: Array<{ slug: string; display_name: string; tint: string | null }>;
			nodes: BundleNode[];
			edges: BundleEdge[];
			branch_id: string;
		};
		worldSlug: string;
		sessionToken: string;
		canvasWidth?: number;
		canvasHeight?: number;
		initialMode?: LayoutMode;
	}>();

	const client = useConvexClient();

	let mode = $state<LayoutMode>((() => initialMode as LayoutMode)());
	const MODE_META: Array<{ id: LayoutMode; label: string; hint: string }> = [
		{ id: 'force', label: 'Force', hint: 'cardinal-aware, default' },
		{ id: 'radial-tree', label: 'Radial', hint: 'BFS from the biggest hub outward' },
		{ id: 'biome-cluster', label: 'Clusters', hint: 'group by biome' }
	];

	// Convert bundle → layout inputs + run force sim. Deterministic seed
	// from branch_id so all family members see the same pre-pin layout.
	const positions = $derived.by(() => {
		const nodes: GraphNode[] = bundle.nodes.map((n: BundleNode) => ({
			slug: n.slug,
			biome: n.biome,
			subgraph: n.subgraph,
			map_shape: n.map_shape ?? undefined,
			draft: n.draft,
			tags: n.tags,
			neighbors: n.neighbors,
			pin: n.pin ?? undefined
		}));
		const edges: GraphEdge[] = bundle.edges.map((e: BundleEdge) => ({
			from: e.from,
			to: e.to,
			direction: e.direction,
			traffic: e.traffic
		}));
		return layout(nodes, edges, {
			mode,
			width: canvasWidth,
			height: canvasHeight,
			seed: seedFromKey(bundle.branch_id),
			iterations: 160
		});
	});

	// Pan + zoom state. Translation is in SVG coords so nodes stay sharp.
	let panX = $state(0);
	let panY = $state(0);
	let scale = $state(1);

	function onWheel(ev: WheelEvent) {
		ev.preventDefault();
		const delta = -ev.deltaY * 0.001;
		const next = Math.max(0.3, Math.min(3, scale * (1 + delta)));
		scale = next;
	}

	let dragging: { slug: string | null; startX: number; startY: number } | null = null;
	let panDrag: { startX: number; startY: number; panX: number; panY: number } | null = null;

	function startNodeDrag(slug: string, ev: PointerEvent) {
		ev.stopPropagation();
		dragging = { slug, startX: ev.clientX, startY: ev.clientY };
		(ev.target as Element).setPointerCapture?.(ev.pointerId);
	}
	function startPanDrag(ev: PointerEvent) {
		panDrag = { startX: ev.clientX, startY: ev.clientY, panX, panY };
	}
	function onPointerMove(ev: PointerEvent) {
		if (dragging) {
			// Translate screen delta into SVG delta (divide by scale).
			const dx = (ev.clientX - dragging.startX) / scale;
			const dy = (ev.clientY - dragging.startY) / scale;
			// Update overlayPins map (optimistic).
			const p = overlayPins.get(dragging.slug!) ?? positions.get(dragging.slug!);
			if (p) {
				overlayPins.set(dragging.slug!, { x: p.x + dx, y: p.y + dy });
				overlayPins = new Map(overlayPins); // trigger reactivity
			}
			dragging.startX = ev.clientX;
			dragging.startY = ev.clientY;
			return;
		}
		if (panDrag) {
			panX = panDrag.panX + (ev.clientX - panDrag.startX);
			panY = panDrag.panY + (ev.clientY - panDrag.startY);
		}
	}
	async function onPointerUp(ev: PointerEvent) {
		if (dragging?.slug) {
			// Persist the pin. If nothing moved (tap), treat as goto.
			const slug = dragging.slug;
			const pinned = overlayPins.get(slug);
			dragging = null;
			if (pinned) {
				try {
					await client.mutation(api.graph.pinNodePosition, {
						session_token: sessionToken,
						world_slug: worldSlug,
						slug,
						x: pinned.x,
						y: pinned.y
					});
				} catch (err) {
					// Revert overlay on failure.
					overlayPins.delete(slug);
					overlayPins = new Map(overlayPins);
					console.warn('pinNodePosition failed', err);
				}
			}
		}
		panDrag = null;
	}

	let overlayPins = $state<Map<string, { x: number; y: number }>>(new Map());

	function posOf(slug: string): { x: number; y: number; class: string } | null {
		const overlay = overlayPins.get(slug);
		const base = positions.get(slug);
		if (!base) return null;
		return {
			x: overlay?.x ?? base.x,
			y: overlay?.y ?? base.y,
			class: base.class
		};
	}

	// Tap → navigate. Guarded by short total travel distance so drags don't
	// trigger navigation.
	function onNodeClick(slug: string, ev: MouseEvent) {
		if (overlayPins.has(slug)) return;
		ev.stopPropagation();
		goto(`/play/${worldSlug}/${slug}`);
	}

	async function releasePin(slug: string) {
		try {
			await client.mutation(api.graph.unpinNode, {
				session_token: sessionToken,
				world_slug: worldSlug,
				slug
			});
			overlayPins.delete(slug);
			overlayPins = new Map(overlayPins);
		} catch (err) {
			console.warn('unpinNode failed', err);
		}
	}

	function colorForSubgraph(slug: string): string {
		// Stable hue from subgraph slug.
		let h = 0;
		for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
		return `hsl(${h % 360}, 55%, 62%)`;
	}

	function edgeOpacity(traffic: number): number {
		return Math.min(0.85, 0.2 + 0.6 * Math.min(1, traffic / 10));
	}

	// Context menu (long-press / right-click).
	let menu = $state<{ slug: string; x: number; y: number } | null>(null);
	function openMenu(slug: string, ev: MouseEvent) {
		ev.preventDefault();
		menu = { slug, x: ev.clientX, y: ev.clientY };
	}
	function closeMenu() {
		menu = null;
	}

	const TILE_SIZE_SPATIAL = 96;
	const TILE_SIZE_ACTION = 56;
</script>

<div
	class="graph-map"
	onpointermove={onPointerMove}
	onpointerup={onPointerUp}
	onwheel={onWheel}
	role="presentation"
>
	<div class="graph-header">
		<span class="font-hand text-xs text-mist-400">layout:</span>
		{#each MODE_META as m (m.id)}
			<button
				type="button"
				class="graph-mode-btn"
				class:graph-mode-btn-active={mode === m.id}
				aria-pressed={mode === m.id}
				title={m.hint}
				onpointerdown={(ev) => ev.stopPropagation()}
				onclick={() => (mode = m.id)}
			>
				{m.label}
			</button>
		{/each}
	</div>
	<svg
		viewBox={`0 0 ${canvasWidth} ${canvasHeight}`}
		width={canvasWidth}
		height={canvasHeight}
		role="application"
		aria-label="Graph map"
		style={`transform: translate(${panX}px, ${panY}px) scale(${scale}); transform-origin: 0 0;`}
		onpointerdown={startPanDrag}
	>
		<!-- Edges under nodes -->
		<g class="graph-edges">
			{#each bundle.edges as e (e.from + '→' + e.to + '|' + e.direction)}
				{#if e.from !== e.to}
					{@const a = posOf(e.from)}
					{@const b = posOf(e.to)}
					{#if a && b}
						<line
							x1={a.x}
							y1={a.y}
							x2={b.x}
							y2={b.y}
							stroke={colorForSubgraph(
								bundle.nodes.find((n: BundleNode) => n.slug === e.from)?.subgraph ?? 'x'
							)}
							stroke-width={a.class === 'action' || b.class === 'action' ? 1 : 2}
							stroke-opacity={edgeOpacity(e.traffic)}
							stroke-dasharray={a.class === 'action' || b.class === 'action' ? '4 4' : null}
						/>
					{/if}
				{/if}
			{/each}
		</g>
		<!-- Nodes -->
		<g class="graph-nodes">
			{#each bundle.nodes as n (n.id)}
				{@const p = posOf(n.slug)}
				{#if p}
					{@const isAction = p.class === 'action'}
					{@const size = isAction ? TILE_SIZE_ACTION : TILE_SIZE_SPATIAL}
					<g
						class="graph-node"
						class:is-draft={n.draft}
						class:is-action={isAction}
						data-slug={n.slug}
						transform={`translate(${p.x - size / 2}, ${p.y - size / 2})`}
						role="button"
						tabindex="0"
						onpointerdown={(ev) => startNodeDrag(n.slug, ev)}
						onclick={(ev) => onNodeClick(n.slug, ev)}
						oncontextmenu={(ev) => openMenu(n.slug, ev)}
						onkeydown={(ev) => {
							if (ev.key === 'Enter' || ev.key === ' ') goto(`/play/${worldSlug}/${n.slug}`);
						}}
					>
						{#if isAction}
							<rect
								x={0}
								y={0}
								width={size}
								height={size / 2}
								rx={size / 4}
								ry={size / 4}
								fill="rgba(30, 22, 50, 0.85)"
								stroke={colorForSubgraph(n.subgraph)}
								stroke-width="1"
								stroke-opacity="0.7"
							/>
							<text
								x={size / 2}
								y={size / 3 + 4}
								font-size="10"
								fill="rgba(245, 230, 200, 0.9)"
								text-anchor="middle"
								font-family="system-ui, sans-serif"
							>
								{n.name.length > 10 ? n.name.slice(0, 9) + '…' : n.name}
							</text>
						{:else}
							<rect
								x={0}
								y={0}
								width={size}
								height={size}
								rx="6"
								ry="6"
								fill={n.palette_fill ?? 'rgba(50, 36, 80, 0.85)'}
								stroke={colorForSubgraph(n.subgraph)}
								stroke-width={n.pin ? 2.5 : 1.2}
								stroke-opacity={n.pin ? 0.95 : 0.6}
							/>
							{#if n.tile_url}
								<image
									href={n.tile_url}
									x={3}
									y={3}
									width={size - 6}
									height={size - 6}
									preserveAspectRatio="xMidYMid slice"
									style="image-rendering: pixelated;"
								/>
							{/if}
							<rect
								x={0}
								y={size - 24}
								width={size}
								height="24"
								fill="rgba(12, 10, 24, 0.78)"
							/>
							<text
								x={6}
								y={size - 8}
								font-size="10"
								fill="rgba(245, 230, 200, 0.95)"
								font-family="system-ui, sans-serif"
							>
								{n.name.length > 16 ? n.name.slice(0, 15) + '…' : n.name}
							</text>
							{#if n.biome}
								<text
									x={6}
									y={12}
									font-size="8"
									fill="rgba(245, 230, 200, 0.55)"
									font-family="system-ui, sans-serif"
								>
									{n.biome.length > 16 ? n.biome.slice(0, 15) + '…' : n.biome}
								</text>
							{/if}
						{/if}
					</g>
				{/if}
			{/each}
		</g>
	</svg>
	{#if menu}
		{@const mn = menu}
		<div
			class="graph-menu"
			style={`left: ${mn.x}px; top: ${mn.y}px;`}
			role="menu"
			tabindex="-1"
			onpointerdown={(ev) => ev.stopPropagation()}
		>
			<button type="button" onclick={() => { goto(`/play/${worldSlug}/${mn.slug}`); closeMenu(); }}>
				Open
			</button>
			<button type="button" onclick={() => { releasePin(mn.slug); closeMenu(); }}>
				Release pin
			</button>
			<button type="button" onclick={closeMenu}>Cancel</button>
		</div>
	{/if}
</div>

<style>
	.graph-map {
		position: relative;
		overflow: hidden;
		border: 1px solid rgba(255, 210, 140, 0.2);
		border-radius: 8px;
		background: rgba(12, 10, 24, 0.4);
		touch-action: none;
		cursor: grab;
		user-select: none;
	}
	.graph-header {
		position: absolute;
		top: 6px;
		left: 8px;
		display: flex;
		align-items: center;
		gap: 4px;
		z-index: 20;
		padding: 4px 8px;
		background: rgba(12, 10, 24, 0.85);
		border: 1px solid rgba(255, 210, 140, 0.2);
		border-radius: 6px;
	}
	.graph-mode-btn {
		padding: 3px 8px;
		font-size: 11px;
		color: rgba(245, 230, 200, 0.7);
		background: transparent;
		border: 1px solid transparent;
		border-radius: 4px;
		cursor: pointer;
		font-family: inherit;
	}
	.graph-mode-btn:hover {
		color: rgba(245, 230, 200, 0.95);
		background: rgba(255, 210, 140, 0.08);
	}
	.graph-mode-btn-active {
		color: rgba(245, 230, 200, 1);
		background: rgba(255, 210, 140, 0.18);
		border-color: rgba(255, 210, 140, 0.45);
	}
	.graph-node {
		cursor: pointer;
		transition: filter 160ms ease-out;
	}
	.graph-node:hover {
		filter: brightness(1.1) saturate(1.08);
	}
	.graph-node.is-draft {
		opacity: 0.55;
	}
	.graph-menu {
		position: fixed;
		background: rgba(14, 10, 28, 0.98);
		border: 1px solid rgba(255, 210, 140, 0.3);
		border-radius: 6px;
		padding: 4px;
		display: flex;
		flex-direction: column;
		gap: 2px;
		z-index: 50;
		min-width: 120px;
	}
	.graph-menu button {
		text-align: left;
		padding: 6px 10px;
		font-size: 12px;
		color: rgba(245, 230, 200, 0.92);
		background: transparent;
		border: none;
		cursor: pointer;
		border-radius: 4px;
	}
	.graph-menu button:hover {
		background: rgba(255, 210, 140, 0.1);
	}
</style>
