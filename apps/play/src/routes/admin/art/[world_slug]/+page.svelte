<script lang="ts">
	import { enhance } from '$app/forms';
	let { data, form } = $props();

	// Grouped by kind on the server. Flatten for the header count.
	const board = $derived<Record<string, any[]>>(data.board ?? {});
	const kinds = $derived(Object.keys(board).sort());
	const totalPinned = $derived(
		kinds.reduce((n, k) => n + (board[k]?.length ?? 0), 0),
	);
	const renderings = $derived(data.renderings ?? []);

	// Add-to-board picker state.
	let pickingRenderingId = $state<string | null>(null);
	let newKind = $state('');
	let newCaption = $state('');

	function blobUrl(hash: string | null | undefined): string {
		if (!hash || !data.r2_public_url) return '';
		return `${data.r2_public_url}/blob/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
	}
</script>

<section class="space-y-8 py-6">
	<header class="space-y-2">
		<p class="font-hand text-base text-candle-300">art admin — reference board</p>
		<h1 class="font-display text-3xl text-mist-100 sm:text-4xl">
			{data.world.name}
		</h1>
		<p class="text-sm text-mist-400">
			{totalPinned} pinned across {kinds.length} kinds · {renderings.length}
			renderings in the world total
		</p>
		<p class="font-hand text-base text-mist-500">
			The reference board teaches future art gens what the family has approved.
			Upvoted renderings pinned here flow into FLUX prompts for matching
			entities and modes.
		</p>
	</header>

	{#if form?.error}
		<p class="text-sm text-rose-300">{form.error}</p>
	{/if}
	{#if form?.removed}
		<p class="font-hand text-base text-candle-300">removed.</p>
	{/if}
	{#if form?.added}
		<p class="font-hand text-base text-candle-300">added to the board.</p>
	{/if}

	{#if kinds.length === 0}
		<div class="story-card px-5 py-4">
			<p class="font-hand text-base text-mist-400">
				nothing pinned yet. upvote variants in the wardrobe to build the
				family's canon, or pin specific renderings below.
			</p>
		</div>
	{:else}
		{#each kinds as kind (kind)}
			<section class="space-y-3">
				<div class="flex items-baseline justify-between">
					<h2 class="font-display text-xl text-mist-100">{kind}</h2>
					<span class="font-mono text-xs text-mist-500">
						{board[kind]?.length ?? 0}
					</span>
				</div>
				<ul class="grid gap-3 sm:grid-cols-3">
					{#each board[kind] as e (e.id)}
						<li class="story-card space-y-2 px-3 py-3">
							{#if e.blob_hash}
								<img
									src={blobUrl(e.blob_hash)}
									alt=""
									loading="lazy"
									class="board-thumb"
								/>
							{:else}
								<div class="board-thumb-empty">(no blob)</div>
							{/if}
							<div class="text-xs uppercase tracking-wide text-mist-600">
								{e.mode} · v{e.variant_index ?? '?'} · ↑{e.upvote_count}
							</div>
							{#if e.caption}
								<p class="font-hand text-sm text-mist-400">{e.caption}</p>
							{/if}
							<form
								method="POST"
								action="?/remove_from_board"
								use:enhance
								class="pt-1"
							>
								<input type="hidden" name="board_id" value={e.id} />
								<button
									type="submit"
									class="text-xs text-mist-500 underline decoration-mist-700 hover:text-rose-400"
								>
									remove from board
								</button>
							</form>
						</li>
					{/each}
				</ul>
			</section>
		{/each}
	{/if}

	<section class="space-y-3 pt-4">
		<h2 class="font-display text-2xl text-mist-100">pin more</h2>
		<p class="font-hand text-base text-mist-400">
			Every ready rendering in the world. Pick one, give it a <em>kind</em>
			(<code>style</code>, <code>character:&lt;slug&gt;</code>,
			<code>biome:&lt;slug&gt;</code>, <code>mode:&lt;mode&gt;</code>),
			optionally a caption.
		</p>

		<ul class="grid gap-3 sm:grid-cols-4">
			{#each renderings as r (r.id)}
				<li
					class="story-card space-y-2 px-3 py-3"
					class:picking={pickingRenderingId === r.id}
				>
					{#if r.blob_hash}
						<img
							src={blobUrl(r.blob_hash)}
							alt=""
							loading="lazy"
							class="board-thumb"
						/>
					{:else}
						<div class="board-thumb-empty"></div>
					{/if}
					<div class="text-xs uppercase tracking-wide text-mist-600">
						{r.entity_type}/{r.entity_slug} · {r.mode} · v{r.variant_index}
					</div>
					{#if pickingRenderingId === r.id}
						<form
							method="POST"
							action="?/add_to_board"
							use:enhance={() => async ({ update }) => {
								await update({ reset: true });
								pickingRenderingId = null;
								newKind = '';
								newCaption = '';
							}}
							class="space-y-2 pt-1"
						>
							<input type="hidden" name="rendering_id" value={r.id} />
							<input
								name="kind"
								placeholder="e.g. character:mara"
								bind:value={newKind}
								class="storybook-input w-full text-sm"
								required
							/>
							<input
								name="caption"
								placeholder="optional caption"
								bind:value={newCaption}
								class="storybook-input w-full text-sm"
							/>
							<div class="flex gap-2">
								<button type="submit" class="storybook-button text-xs">
									✧ pin
								</button>
								<button
									type="button"
									class="text-xs text-mist-500 underline decoration-mist-700 hover:text-mist-200"
									onclick={() => (pickingRenderingId = null)}
								>
									cancel
								</button>
							</div>
						</form>
					{:else}
						<button
							type="button"
							class="text-xs font-hand text-candle-300 underline decoration-mist-700 hover:text-candle-100"
							onclick={() => (pickingRenderingId = r.id)}
						>
							pin to board
						</button>
					{/if}
				</li>
			{/each}
		</ul>
	</section>
</section>

<style>
	.board-thumb {
		width: 100%;
		aspect-ratio: 1;
		object-fit: cover;
		border-radius: 3px;
		background: rgba(0, 0, 0, 0.3);
	}
	.board-thumb-empty {
		width: 100%;
		aspect-ratio: 1;
		background: rgba(0, 0, 0, 0.25);
		border: 1px dashed rgba(159, 140, 210, 0.2);
		border-radius: 3px;
		color: var(--color-mist-500);
		font-family: var(--font-hand);
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 0.85rem;
	}
	.picking {
		border-color: var(--color-candle-400);
	}
</style>
