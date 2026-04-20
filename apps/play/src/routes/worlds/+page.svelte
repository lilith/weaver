<script lang="ts">
	import { enhance } from '$app/forms';
	let { data, form } = $props();
	let seeding = $state(false);
</script>

<section class="space-y-10 py-6">
	<header class="space-y-2">
		<h1 class="font-display text-4xl text-ink-900 sm:text-5xl">Your worlds</h1>
		<p class="text-ink-700">
			Each world is its own story. Start with a small seed; spin up more whenever you feel like
			trying a new game.
		</p>
	</header>

	{#if data.worlds.length > 0}
		<ul class="space-y-3">
			{#each data.worlds as world (world._id)}
				<li>
					<a
						href="/play/{world.slug}"
						class="story-card group flex items-center justify-between px-5 py-4 no-underline"
					>
						<div>
							<div class="font-display text-xl text-ink-900">{world.name}</div>
							<div class="text-xs uppercase tracking-wide text-ink-500">
								{world.role} · {world.slug}
							</div>
						</div>
						<span
							class="font-hand text-2xl text-accent-600 transition group-hover:translate-x-1"
						>
							↝
						</span>
					</a>
				</li>
			{/each}
		</ul>
	{/if}

	<div class="story-card space-y-4 px-6 py-6">
		<h2 class="font-display text-2xl">Start a new world</h2>
		<p class="text-sm text-ink-700">
			The <em>Quiet Vale</em> is a cozy starter: a small mountain village, a carpenter named Mara,
			morning light and woodsmoke. Good for seeing the bones.
		</p>

		<form
			method="POST"
			action="?/seed"
			class="space-y-3"
			use:enhance={() => {
				seeding = true;
				return async ({ update }) => {
					await update({ reset: false });
					seeding = false;
				};
			}}
		>
			<label class="block space-y-1">
				<span class="text-sm text-ink-700">What should your character be called?</span>
				<input
					name="character_name"
					placeholder="your name here (or leave blank)"
					class="storybook-input w-full"
				/>
			</label>
			{#if form?.error}
				<p class="text-sm text-red-700">{form.error}</p>
			{/if}
			<button class="storybook-button" disabled={seeding}>
				{seeding ? 'Weaving…' : 'Begin in the Quiet Vale'}
			</button>
		</form>
	</div>
</section>
