<script lang="ts">
	let { data } = $props();
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
				<li class="group relative">
					<a
						href="/play/{world.slug}"
						class="story-card flex items-center justify-between px-5 py-4 no-underline"
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
					{#if world.role === 'owner'}
						<a
							href="/admin/{world.slug}"
							class="absolute top-2 right-14 rounded border border-mist-800/50 bg-velvet-900/70 px-2 py-1 font-hand text-xs text-candle-300 opacity-0 transition group-hover:opacity-100 hover:border-candle-400"
							title="admin this world"
						>
							admin
						</a>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}

	<a
		href="/worlds/new"
		class="story-card flex items-center justify-between px-6 py-5 no-underline hover:border-candle-400"
	>
		<div>
			<div class="font-display text-2xl text-mist-100">Start a new world</div>
			<p class="font-hand text-sm text-candle-300">
				a starter tile or a paragraph of your own — Weaver takes it from there
			</p>
		</div>
		<span class="font-hand text-3xl text-rose-400">↝</span>
	</a>
</section>
