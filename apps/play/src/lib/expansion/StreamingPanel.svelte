<script lang="ts">
	import { useConvexClient, useQuery } from 'convex-svelte';
	import { api } from '$convex/_generated/api';
	import type { Id } from '$convex/_generated/dataModel';
	import { goto } from '$app/navigation';

	let {
		streamId,
		sessionToken,
		worldSlug
	} = $props<{
		streamId: string;
		sessionToken: string;
		worldSlug: string;
	}>();

	const client = useConvexClient();
	const q = useQuery(api.expansion.readStream, () => ({
		session_token: sessionToken,
		stream_id: streamId as Id<'expansion_streams'>
	}));

	const status = $derived<'streaming' | 'done' | 'failed' | 'pending'>(
		(q.data?.status as any) ?? 'pending'
	);
	const text = $derived(q.data?.text ?? '');
	const resultKind = $derived(q.data?.result_kind ?? null);
	const resultSlug = $derived(q.data?.result_slug ?? null);
	const errorMsg = $derived(q.data?.error ?? null);

	// Once the stream resolves to a new location, navigate.
	$effect(() => {
		if (status === 'done' && resultKind === 'location' && resultSlug) {
			// Small delay so the final chunk has time to render visually.
			const id = setTimeout(() => {
				goto(`/play/${worldSlug}/${resultSlug}`);
			}, 350);
			return () => clearTimeout(id);
		}
	});
</script>

<section class="streaming-panel mt-4 space-y-2 rounded-lg border border-candle-400/40 bg-velvet-800/40 px-5 py-4">
	{#if status === 'streaming' || status === 'pending'}
		<div class="flex items-center gap-2 text-candle-300">
			<span class="weave-spinner" aria-hidden="true"></span>
			<span class="font-hand text-lg">weaving…</span>
		</div>
	{:else if status === 'done' && resultKind === 'location'}
		<div class="flex items-center gap-2 text-candle-300">
			<span class="font-hand text-lg">ready — stepping through…</span>
		</div>
	{:else if status === 'done' && resultKind === 'narrate'}
		<p class="font-hand text-base text-mist-400">a moment:</p>
	{:else if status === 'failed'}
		<p class="text-sm text-rose-400">
			the thread snagged{errorMsg ? `: ${errorMsg}` : ''} — try again?
		</p>
	{/if}

	{#if text}
		<p class="story-aside italic leading-relaxed">
			{text}
		</p>
	{/if}
</section>

<style>
	.streaming-panel {
		box-shadow: 0 0 24px rgba(232, 160, 36, 0.06);
	}
</style>
