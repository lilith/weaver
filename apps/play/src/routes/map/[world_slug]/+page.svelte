<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import GraphMap from '$lib/map-graph/GraphMap.svelte';
	let { data } = $props();

	// Grid fallback — retained unchanged until flag.graph_map trips on.
	type Node = {
		id: string;
		slug: string;
		name: string;
		biome: string | null;
		coords: { q: number; r: number } | null;
		neighbors: Record<string, string>;
		draft: boolean;
		tile_url: string | null;
		palette_fill: string | null;
	};
	const gridNodes = $derived(data.graph_enabled ? [] : ((data as any).nodes as Node[]));
	const bySlug = $derived(new Map(gridNodes.map((n) => [n.slug, n])));

	const DIR_OFFSET: Record<string, [number, number]> = {
		north: [0, -1],
		south: [0, 1],
		east: [1, 0],
		west: [-1, 0],
		northeast: [1, -1],
		northwest: [-1, -1],
		southeast: [1, 1],
		southwest: [-1, 1],
		up: [0, -1],
		down: [0, 1],
		in: [0, 1],
		out: [0, -1],
		back: [0, -1]
	};

	function layOutNodes(): Map<string, { col: number; row: number }> {
		const out = new Map<string, { col: number; row: number }>();
		const taken = new Set<string>();
		const claim = (slug: string, col: number, row: number) => {
			let c = col,
				r = row;
			while (taken.has(`${c},${r}`)) c++;
			taken.add(`${c},${r}`);
			out.set(slug, { col: c, row: r });
		};
		for (const n of gridNodes) {
			if (n.coords) claim(n.slug, n.coords.q, n.coords.r);
		}
		const visited = new Set<string>(out.keys());
		const queue: string[] = Array.from(out.keys());
		while (queue.length > 0) {
			const slug = queue.shift()!;
			const node = bySlug.get(slug);
			if (!node) continue;
			const pos = out.get(slug)!;
			for (const [dir, target] of Object.entries(node.neighbors)) {
				if (visited.has(target)) continue;
				if (!bySlug.has(target)) continue;
				const [dc, dr] = DIR_OFFSET[dir.toLowerCase()] ?? [1, 0];
				claim(target, pos.col + dc, pos.row + dr);
				visited.add(target);
				queue.push(target);
			}
		}
		let orphanRow = 0;
		const orphanCol =
			gridNodes.length > 0
				? Math.max(0, ...Array.from(out.values()).map((p) => p.col)) + 2
				: 0;
		for (const n of gridNodes) {
			if (!out.has(n.slug)) {
				claim(n.slug, orphanCol, orphanRow);
				orphanRow++;
			}
		}
		return out;
	}
	const positions = $derived(data.graph_enabled ? new Map() : layOutNodes());

	const gridExtent = $derived.by(() => {
		const cols = Array.from(positions.values()).map((p) => p.col);
		const rows = Array.from(positions.values()).map((p) => p.row);
		const minCol = cols.length ? Math.min(...cols) : 0;
		const minRow = rows.length ? Math.min(...rows) : 0;
		const maxCol = cols.length ? Math.max(...cols) : 0;
		const maxRow = rows.length ? Math.max(...rows) : 0;
		return {
			minCol,
			minRow,
			width: Math.max(1, maxCol - minCol + 1),
			height: Math.max(1, maxRow - minRow + 1)
		};
	});

	const TILE = 112;
	const GAP = 8;
	const cellW = TILE;
	const cellH = TILE;
	const svgW = $derived(gridExtent.width * (cellW + GAP) + GAP);
	const svgH = $derived(gridExtent.height * (cellH + GAP) + GAP);

	function cellXY(slug: string): { x: number; y: number } {
		const p = positions.get(slug)!;
		return {
			x: GAP + (p.col - gridExtent.minCol) * (cellW + GAP),
			y: GAP + (p.row - gridExtent.minRow) * (cellH + GAP)
		};
	}

	const gridEdges = $derived.by(() => {
		const out: Array<{ from: string; to: string }> = [];
		const seen = new Set<string>();
		for (const n of gridNodes) {
			for (const target of Object.values(n.neighbors)) {
				if (!bySlug.has(target)) continue;
				const key = [n.slug, target].sort().join('→');
				if (seen.has(key)) continue;
				seen.add(key);
				out.push({ from: n.slug, to: target });
			}
		}
		return out;
	});

	const sessionToken = $derived(((data as any).session_token ?? (page.data as any).session_token) ?? '');
	// Optional ?layout=force|radial-tree|biome-cluster URL param so the
	// mode picker produces shareable/bookmarkable URLs.
	const initialMode = $derived.by(() => {
		const q = page.url.searchParams.get('layout');
		if (q === 'radial-tree' || q === 'biome-cluster' || q === 'force') return q;
		return 'force' as const;
	});
</script>

<svelte:head>
	<title>{data.world.name} — map</title>
</svelte:head>

<article class="space-y-4 pb-24">
	<header class="space-y-1">
		<p class="font-hand text-2xl text-candle-300">map</p>
		<p class="text-sm text-mist-400">
			{data.world.name}
			{#if data.graph_enabled}
				· graph view
			{:else}
				· {gridNodes.length} {gridNodes.length === 1 ? 'place' : 'places'}
			{/if}
		</p>
		{#if !data.graph_enabled}
			<p class="text-xs text-mist-500">
				Tap a tile to walk there. Drafts are dimmed. Enable <code>flag.graph_map</code> on this world for the graph view.
			</p>
		{:else}
			<p class="text-xs text-mist-500">
				Drag a node to pin it. Tap to walk there. Right-click for menu.
			</p>
		{/if}
	</header>

	{#if data.graph_enabled}
		<GraphMap
			bundle={(data as any).bundle}
			worldSlug={data.world_slug}
			{sessionToken}
			{initialMode}
		/>
	{:else}
		<div class="map-wrap">
			<svg
				viewBox={`0 0 ${svgW} ${svgH}`}
				style={`width: ${svgW}px; max-width: 100%; height: auto;`}
				xmlns="http://www.w3.org/2000/svg"
			>
				<g class="map-edges">
					{#each gridEdges as e (e.from + '→' + e.to)}
						{@const a = cellXY(e.from)}
						{@const b = cellXY(e.to)}
						<line
							x1={a.x + cellW / 2}
							y1={a.y + cellH / 2}
							x2={b.x + cellW / 2}
							y2={b.y + cellH / 2}
							stroke="rgba(255, 210, 140, 0.15)"
							stroke-width="1"
						/>
					{/each}
				</g>
				{#each gridNodes as n (n.id)}
					{@const p = cellXY(n.slug)}
					<g
						class="map-cell"
						class:map-cell-draft={n.draft}
						onclick={() => goto(`/play/${data.world_slug}/${n.slug}`)}
						role="button"
						tabindex="0"
						onkeydown={(ev) => {
							if (ev.key === 'Enter' || ev.key === ' ') {
								goto(`/play/${data.world_slug}/${n.slug}`);
							}
						}}
					>
						<rect
							x={p.x}
							y={p.y}
							width={cellW}
							height={cellH}
							rx="4"
							ry="4"
							fill={n.palette_fill ?? 'rgba(60, 46, 80, 0.6)'}
							stroke="rgba(255, 210, 140, 0.3)"
							stroke-width="1"
						/>
						{#if n.tile_url}
							<image
								href={n.tile_url}
								x={p.x + 4}
								y={p.y + 4}
								width={cellW - 8}
								height={cellH - 8}
								preserveAspectRatio="xMidYMid slice"
								style="image-rendering: pixelated;"
							/>
						{/if}
						<rect
							x={p.x}
							y={p.y + cellH - 28}
							width={cellW}
							height="28"
							fill="rgba(12, 10, 24, 0.72)"
						/>
						<text
							x={p.x + 6}
							y={p.y + cellH - 10}
							font-size="11"
							fill="rgba(245, 230, 200, 0.92)"
							font-family="system-ui, sans-serif"
						>
							{n.name.length > 18 ? n.name.slice(0, 17) + '…' : n.name}
						</text>
						{#if n.biome}
							<text
								x={p.x + 6}
								y={p.y + 12}
								font-size="9"
								fill="rgba(245, 230, 200, 0.55)"
								font-family="system-ui, sans-serif"
							>
								{n.biome.length > 14 ? n.biome.slice(0, 13) + '…' : n.biome}
							</text>
						{/if}
					</g>
				{/each}
			</svg>
		</div>
	{/if}
</article>

<style>
	.map-wrap {
		overflow: auto;
		padding: 8px;
		border-radius: 8px;
		border: 1px solid rgba(255, 210, 140, 0.2);
		background: rgba(12, 10, 24, 0.4);
	}
	.map-cell {
		cursor: pointer;
		transition: filter 160ms ease-out;
	}
	.map-cell:hover {
		filter: brightness(1.12) saturate(1.08);
	}
	.map-cell:focus {
		outline: 2px solid rgba(255, 210, 140, 0.7);
	}
	.map-cell-draft {
		opacity: 0.55;
	}
</style>
