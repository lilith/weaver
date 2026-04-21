<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import { setupConvex } from 'convex-svelte';
	import { PUBLIC_CONVEX_URL } from '$env/static/public';
	import { page } from '$app/state';

	let { children, data } = $props();

	// Reactive Convex client — used by feature components (e.g. the
	// art-curation wardrobe) that need live subscriptions. SSR loaders
	// still go through the HTTP client in $lib/convex.
	setupConvex(PUBLIC_CONVEX_URL);

	// Surface a world-scoped admin link when the user is inside a world
	// (play, map, or admin routes). Extracts the slug from the path so
	// the nav doesn't need a per-world layout change. Non-owners who hit
	// /admin/<slug> get redirected out by that page's server load.
	const worldSlug = $derived.by(() => {
		const p = page.url.pathname;
		const m = /^\/(?:play|map|admin)\/([^/]+)/.exec(p);
		return m ? m[1] : null;
	});
	const isOnAdmin = $derived(worldSlug && page.url.pathname.startsWith('/admin/'));
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
			<a href="/journal" class="text-mist-400 no-underline hover:text-rose-400">journal</a>
			{#if worldSlug && !isOnAdmin}
				<a
					href={`/admin/${worldSlug}`}
					class="text-mist-400 no-underline hover:text-rose-400"
					title="Admin this world"
				>
					admin
				</a>
			{/if}
			{#if worldSlug && isOnAdmin}
				<a
					href={`/play/${worldSlug}`}
					class="text-mist-400 no-underline hover:text-rose-400"
					title="Back to playing"
				>
					play
				</a>
			{/if}
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
