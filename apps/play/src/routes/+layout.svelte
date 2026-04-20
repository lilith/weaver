<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';

	let { children, data } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>Weaver</title>
</svelte:head>

<div class="min-h-svh bg-stone-50 text-stone-900 antialiased">
	<header
		class="flex items-center justify-between border-b border-stone-200 bg-white/80 px-4 py-3 backdrop-blur"
	>
		<a href="/" class="font-serif text-lg tracking-tight">Weaver</a>
		{#if data.user}
			<div class="flex items-center gap-3 text-sm">
				<span class="text-stone-600">{data.user.display_name}</span>
				<form method="POST" action="/auth/logout">
					<button
						class="rounded px-2 py-1 text-stone-500 hover:bg-stone-100 hover:text-stone-900"
					>
						Sign out
					</button>
				</form>
			</div>
		{/if}
	</header>
	<main class="mx-auto max-w-2xl px-4 py-6 sm:px-6">{@render children()}</main>
</div>
