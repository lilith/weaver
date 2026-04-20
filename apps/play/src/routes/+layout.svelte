<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';

	let { children, data } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>Weaver</title>
</svelte:head>

<header class="mx-auto flex max-w-3xl items-center justify-between px-4 py-4 sm:px-6">
	<a href="/" class="font-display text-2xl font-semibold text-mist-100 no-underline">
		Weaver
	</a>
	{#if data.user}
		<div class="flex items-center gap-4 text-sm">
			<a href="/worlds" class="text-mist-400 no-underline hover:text-rose-400">worlds</a>
			<span class="font-hand text-xl text-candle-300">· {data.user.display_name}</span>
			<form method="POST" action="/auth/logout">
				<button class="rounded px-2 py-1 text-sm text-mist-600 hover:text-mist-100">
					sign out
				</button>
			</form>
		</div>
	{/if}
</header>
<main class="mx-auto max-w-2xl px-4 pb-16 sm:px-6">{@render children()}</main>
