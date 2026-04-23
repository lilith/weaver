<script lang="ts">
	let { data } = $props();
	const slug = $derived(data.world.slug);
</script>

<section class="space-y-8 py-6">
	<header class="space-y-2">
		<p class="font-hand text-base text-candle-300">admin</p>
		<h1 class="font-display text-3xl text-mist-100 sm:text-4xl">
			{data.world.name}
		</h1>
		<p class="text-sm text-mist-400">
			Owner-only surfaces for curating the world's art, voice, and tone.
		</p>
	</header>

	<ul class="grid gap-4 sm:grid-cols-2">
		<li>
			<a href="/admin/bible/{slug}" class="story-card admin-card block">
				<div class="font-display text-xl text-mist-100">bible · ai feedback</div>
				<p class="mt-1 text-sm text-mist-400">
					Tune tone, taboos, established facts. Opus proposes a minimal diff;
					you approve before anything writes.
				</p>
			</a>
		</li>
		<li>
			<a href="/admin/art/{slug}" class="story-card admin-card block">
				<div class="font-display text-xl text-mist-100">art · reference board</div>
				<p class="mt-1 text-sm text-mist-400">
					Pin approved renderings per kind. Future gens for matching entities
					converge toward these.
				</p>
			</a>
		</li>
		<li>
			<a href="/admin/eras/{slug}" class="story-card admin-card block">
				<div class="font-display text-xl text-mist-100">eras · chronicles</div>
				<p class="mt-1 text-sm text-mist-400">
					Mark chapter breaks. Advancing writes a chronicle and increments the
					world's active_era counter.
				</p>
			</a>
		</li>
		<li>
			<a href="/admin/hints/{slug}" class="story-card admin-card block">
				<div class="font-display text-xl text-mist-100">image-gen hints</div>
				<p class="mt-1 text-sm text-mist-400">
					Per-location descriptor, kind, direction, distance. The tile picker
					hands these to pixellab when a fresh map tile is needed.
				</p>
			</a>
		</li>
		<li>
			<a href="/admin/modules/{slug}" class="story-card admin-card block">
				<div class="font-display text-xl text-mist-100">modules · ai feedback</div>
				<p class="mt-1 text-sm text-mist-400">
					Tune combat / dialogue / counter behavior by proposing changes to
					declared slots. No deploy — Opus drafts, you approve, runtime picks
					it up on the next step.
				</p>
			</a>
		</li>
		<li>
			<a href="/admin/code/{slug}" class="story-card admin-card block">
				<div class="font-display text-xl text-mist-100">code · ai feedback</div>
				<p class="mt-1 text-sm text-mist-400">
					For structural changes — new combat choices, new step logic, etc.
					Opus drafts a plan; you open a GitHub issue for Lilith to implement.
				</p>
			</a>
		</li>
	</ul>

	<nav class="pt-4 text-sm text-mist-500">
		<a href="/play/{slug}" class="hover:text-candle-300">→ back to play</a>
	</nav>
</section>

<style>
	.admin-card {
		padding: 1.25rem 1.4rem;
		transition: border-color 140ms ease, background 140ms ease;
		text-decoration: none;
	}
	.admin-card:hover {
		border-color: var(--color-candle-400);
	}
</style>
