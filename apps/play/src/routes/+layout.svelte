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
	<a href="/" class="font-display text-2xl font-semibold text-ink-900 no-underline">
		Weaver
	</a>
	{#if data.user}
		<div class="flex items-center gap-4 text-sm">
			<a href="/worlds" class="text-ink-700 no-underline hover:text-accent-600">worlds</a>
			<span class="font-hand text-xl text-accent-600">· {data.user.display_name}</span>
			<form method="POST" action="/auth/logout">
				<button class="rounded px-2 py-1 text-sm text-ink-500 hover:text-ink-900">
					sign out
				</button>
			</form>
		</div>
	{/if}
</header>
<main class="mx-auto max-w-2xl px-4 pb-16 sm:px-6">{@render children()}</main>
