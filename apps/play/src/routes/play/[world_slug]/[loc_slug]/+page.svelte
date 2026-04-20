<script lang="ts">
	import { enhance } from '$app/forms';
	let { data, form } = $props();
</script>

<article class="space-y-6 pb-24">
	<header class="space-y-1">
		<h1 class="font-display text-4xl tracking-tight text-ink-900 sm:text-5xl">
			{data.location.name}
		</h1>
		{#if data.location.author_pseudonym}
			<p class="font-hand text-base text-accent-600">
				✦ discovered by {data.location.author_pseudonym}
			</p>
		{/if}
	</header>

	<section class="story-prose">
		<p class="first-letter:float-left first-letter:mr-2 first-letter:font-display first-letter:text-6xl first-letter:leading-[0.9] first-letter:text-accent-600">
			{data.location.description}
		</p>
	</section>

	{#if form?.says?.length}
		<section class="story-aside space-y-2">
			{#each form.says as line}
				<p class="italic">{line}</p>
			{/each}
		</section>
	{/if}

	<hr class="ornate-divider" />

	<section class="space-y-3">
		{#each data.location.options as option, i (i)}
			<form method="POST" action="?/pick" use:enhance>
				<input type="hidden" name="option_index" value={i} />
				<button type="submit" class="choice-button">
					<span class="mr-3 text-accent-500">❖</span>{option.label}
				</button>
			</form>
		{/each}
	</section>
</article>
