<script lang="ts">
	let { data } = $props();
</script>

<section class="mx-auto py-16 text-center">
	{#if data.error}
		<h1 class="font-serif text-2xl">That link can't be used.</h1>
		<p class="mt-3 text-stone-600">{data.error}</p>
		<a href="/" class="mt-6 inline-block rounded-lg bg-stone-900 px-5 py-3 text-white no-underline">
			Request a new link
		</a>
	{:else}
		<h1 class="font-serif text-2xl">Signing you in…</h1>
	{/if}
</section>
