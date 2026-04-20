<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();
	let submitting = $state(false);
</script>

{#if data.user}
	<section class="prose prose-stone mx-auto py-8">
		<h1 class="font-serif text-4xl">Weaver</h1>
		<p>You're signed in as <strong>{data.user.display_name}</strong>.</p>
		<a
			href="/play"
			class="mt-6 inline-block rounded-lg bg-stone-900 px-5 py-3 text-white no-underline hover:bg-stone-700"
		>
			Enter the world
		</a>
	</section>
{:else}
	<section class="mx-auto py-10 sm:py-16">
		<h1 class="font-serif text-4xl tracking-tight sm:text-5xl">Weaver</h1>
		<p class="mt-3 text-stone-600">
			A small, collaborative world-building game. Sign in with your email to enter.
		</p>

		{#if form?.ok}
			<div class="mt-8 rounded-lg border border-stone-200 bg-white p-4 text-sm text-stone-700">
				A sign-in link has been sent to <strong>{form.email}</strong>. Check your inbox. The link
				expires in 15 minutes.
			</div>
		{:else}
			<form
				method="POST"
				action="?/request"
				class="mt-8 space-y-3"
				use:enhance={() => {
					submitting = true;
					return async ({ update }) => {
						await update({ reset: false });
						submitting = false;
					};
				}}
			>
				<label class="block text-sm font-medium" for="email">Email address</label>
				<input
					id="email"
					name="email"
					type="email"
					required
					autocomplete="email"
					class="w-full rounded-lg border border-stone-300 bg-white px-4 py-3 text-base placeholder:text-stone-400 focus:border-stone-500 focus:outline-none"
					placeholder="you@example.com"
				/>
				{#if form?.error}
					<p class="text-sm text-red-600">{form.error}</p>
				{/if}
				<button
					type="submit"
					disabled={submitting}
					class="min-h-11 w-full rounded-lg bg-stone-900 px-5 py-3 text-base font-medium text-white disabled:opacity-50 sm:w-auto"
				>
					{submitting ? 'Sending…' : 'Send sign-in link'}
				</button>
			</form>
		{/if}
	</section>
{/if}
