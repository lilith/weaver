<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();
	let submitting = $state(false);
</script>

{#if data.user}
	<section class="space-y-6 py-10">
		<h1 class="font-display text-5xl text-ink-900">
			Welcome back, <span class="font-hand text-4xl text-accent-600">{data.user.display_name}</span>.
		</h1>
		<p class="text-ink-700">Your worlds are waiting.</p>
		<a href="/worlds" class="storybook-button no-underline">Go to your worlds</a>
	</section>
{:else}
	<section class="space-y-8 py-10 sm:py-16">
		<header class="space-y-3">
			<h1 class="font-display text-5xl tracking-tight text-ink-900 sm:text-6xl">
				Weaver
			</h1>
			<p class="font-hand text-2xl text-accent-600">a small loom for stories, shared</p>
			<p class="text-ink-700">
				Each world is its own story, stitched from prose and pictures you author together. Sign in with
				your email — you'll get a single-use link.
			</p>
		</header>

		{#if form?.ok}
			<div class="story-card px-5 py-4">
				<p class="text-ink-700">
					<span class="font-hand text-xl text-accent-600">sent.</span> Check <strong>{form.email}</strong>
					— link expires in 15 minutes.
				</p>
			</div>
		{:else}
			<form
				method="POST"
				action="?/request"
				class="story-card space-y-3 px-5 py-5"
				use:enhance={() => {
					submitting = true;
					return async ({ update }) => {
						await update({ reset: false });
						submitting = false;
					};
				}}
			>
				<label class="block space-y-1.5">
					<span class="text-sm text-ink-700">your email</span>
					<input
						id="email"
						name="email"
						type="email"
						required
						autocomplete="email"
						class="storybook-input w-full"
						placeholder="you@example.com"
					/>
				</label>
				{#if form?.error}
					<p class="text-sm text-red-700">{form.error}</p>
				{/if}
				<button class="storybook-button w-full sm:w-auto" disabled={submitting}>
					{submitting ? 'sending…' : 'send me a sign-in link'}
				</button>
			</form>
		{/if}
	</section>
{/if}
