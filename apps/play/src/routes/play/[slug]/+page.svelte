<script lang="ts">
	import { enhance } from '$app/forms';
	let { data, form } = $props();
</script>

<article class="space-y-6 pb-24">
	<header class="space-y-1">
		<h1 class="font-serif text-3xl tracking-tight sm:text-4xl">{data.location.name}</h1>
		{#if data.location.author_pseudonym}
			<p class="text-xs uppercase tracking-wide text-stone-500">
				✦ discovered by {data.location.author_pseudonym}
			</p>
		{/if}
	</header>

	<section class="prose prose-stone max-w-none">
		<p>{data.location.description}</p>
	</section>

	{#if form?.says?.length}
		<section
			class="space-y-2 rounded-lg border border-stone-200 bg-white px-4 py-3 text-stone-700"
		>
			{#each form.says as line}
				<p class="italic">{line}</p>
			{/each}
		</section>
	{/if}

	<section class="space-y-2">
		<h2 class="text-xs uppercase tracking-wide text-stone-500">What do you do?</h2>
		{#each data.location.options as option, i (i)}
			<form method="POST" action="?/pick" use:enhance>
				<input type="hidden" name="option_index" value={i} />
				<button
					class="min-h-11 w-full rounded-lg border border-stone-300 bg-white px-4 py-3 text-left text-base hover:border-stone-500 hover:bg-stone-50 focus:border-stone-900 focus:outline-none"
				>
					{option.label}
				</button>
			</form>
		{/each}
	</section>
</article>
