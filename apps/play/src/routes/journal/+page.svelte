<script lang="ts">
	import { enhance } from '$app/forms';
	let { data, form } = $props();

	function formatDate(ms: number) {
		const d = new Date(ms);
		return d.toLocaleDateString(undefined, {
			weekday: 'short',
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		});
	}

	function statusLabel(s: string) {
		switch (s) {
			case 'open':
				return 'still wandering';
			case 'closed':
				return 'awaiting your call';
			case 'saved':
				return 'woven in';
			case 'discarded':
				return 'let to fade';
			default:
				return s;
		}
	}
</script>

<section class="space-y-8 py-6">
	<header class="space-y-1">
		<h1 class="font-display text-4xl text-mist-100 sm:text-5xl">Your journal</h1>
		<p class="text-mist-400">Every wander you've taken off the map.</p>
	</header>

	{#if data.worlds.length > 1}
		<nav class="flex flex-wrap gap-2 text-sm">
			{#each data.worlds as world (world._id)}
				<a
					href="/journal?world={world.slug}"
					class="rounded-full border px-3 py-1 {world._id === data.activeWorld?._id
						? 'border-candle-400 text-candle-300'
						: 'border-mist-800 text-mist-600 hover:text-mist-100'}"
				>
					{world.name}
				</a>
			{/each}
		</nav>
	{/if}

	{#if !data.activeWorld}
		<p class="font-hand text-xl text-mist-400">You haven't stepped into any world yet.</p>
	{:else if data.journeys.length === 0}
		<p class="font-hand text-xl text-mist-400">No journeys here yet. When you wander off the beaten path, they'll land in this book.</p>
	{:else}
		<ul class="space-y-4">
			{#each data.journeys as j (j._id)}
				<li class="story-card space-y-3 px-5 py-4">
					<div class="flex flex-wrap items-baseline justify-between gap-3">
						<div>
							<div class="font-display text-xl text-mist-100">
								{j.entity_slugs.length}
								{j.entity_slugs.length === 1 ? 'place' : 'places'}
							</div>
							<div class="text-xs uppercase tracking-wide text-mist-600">
								{formatDate(j.opened_at)} · {statusLabel(j.status)}
							</div>
						</div>
						{#if j.status === 'closed'}
							<span class="font-hand text-base text-candle-300">awaiting you</span>
						{/if}
					</div>

					{#if j.summary}
						<p class="font-hand text-base text-mist-400">{j.summary}</p>
					{/if}

					<ul class="flex flex-wrap gap-2">
						{#each j.entity_slugs as slug (slug)}
							<a
								href="/play/{data.activeWorld.slug}/{slug}"
								class="rounded-full border border-mist-800 px-3 py-1 text-sm text-mist-400 hover:border-teal-400 hover:text-teal-400"
							>
								{slug}
							</a>
						{/each}
					</ul>

					{#if j.status === 'closed' || j.status === 'open'}
						<div class="flex flex-wrap items-center gap-3">
							<form method="POST" action="?/save_cluster" use:enhance>
								<input type="hidden" name="journey_id" value={j._id} />
								{#each j.entity_slugs as slug (slug)}
									<input type="hidden" name="keep_slug" value={slug} />
								{/each}
								<button type="submit" class="storybook-button">✧ save all</button>
							</form>
							<form method="POST" action="?/dismiss" use:enhance>
								<input type="hidden" name="journey_id" value={j._id} />
								<button
									type="submit"
									class="text-sm text-mist-400 underline decoration-mist-800 hover:text-rose-400"
								>
									dismiss
								</button>
							</form>
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}

	{#if form?.saved_cluster}
		<p class="font-hand text-base text-candle-300">
			✨ {form.saved_cluster.saved} of {form.saved_cluster.total} woven in.
		</p>
	{/if}
	{#if form?.dismissed}
		<p class="text-sm text-mist-400">Tucked away.</p>
	{/if}
	{#if form?.error}
		<p class="text-sm text-rose-300">{form.error}</p>
	{/if}
</section>
