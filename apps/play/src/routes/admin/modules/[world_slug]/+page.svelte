<script lang="ts">
	import { enhance } from '$app/forms';
	let { data, form } = $props();
	let selected = $state<string>('');
	let feedback = $state('');
	let pending = $state(false);

	// Seed `selected` lazily from data so we don't capture a stale ref
	// before the first render; updates on nav too.
	$effect(() => {
		if (!selected && data.modules.length > 0) {
			selected = data.modules[0].name;
		}
	});

	const selectedModule = $derived(
		data.modules.find((m: any) => m.name === selected) ?? data.modules[0]
	);

	function diffKeys(
		current: Record<string, unknown>,
		suggested: Record<string, unknown>
	): string[] {
		return Object.keys(suggested ?? {}).filter(
			(k) => JSON.stringify(current?.[k]) !== JSON.stringify(suggested?.[k])
		);
	}

	const changedKeys = $derived(
		form?.suggestion
			? diffKeys(
					form.suggestion.current_overrides as any,
					form.suggestion.suggested_overrides as any
				)
			: []
	);
</script>

<section class="space-y-8 py-6">
	<header class="space-y-2">
		<p class="font-hand text-base text-candle-300">modules admin — ai feedback</p>
		<h1 class="font-display text-3xl text-mist-100 sm:text-4xl">
			{data.world.name}
		</h1>
		<p class="text-sm text-mist-400">
			Tune how combat / dialogue / counter play in this world. Opus proposes a
			minimal change to declared slots; you approve before it takes effect.
			Structural changes (new steps, new choices) need
			<a href="/admin/code/{data.world.slug}" class="text-candle-300 underline"
				>a code proposal</a
			>
			instead.
		</p>
		{#if !data.flag.enabled}
			<p class="rounded border border-amber-500/50 bg-amber-950/40 p-3 text-sm text-amber-200">
				⚠ <code>flag.module_overrides</code> is off for this world. Enable it in
				<a href="/admin/settings/{data.world.slug}" class="underline"
					>admin settings</a
				>
				before proposing or applying overrides will take effect.
			</p>
		{/if}
	</header>

	<div class="flex gap-2 flex-wrap">
		{#each data.modules as m (m.name)}
			<button
				class="storybook-chip"
				class:is-active={m.name === selected}
				onclick={() => (selected = m.name)}
				type="button"
			>
				{m.name}{#if m.version > 0}
					<span class="font-hand text-xs text-mist-500"> v{m.version}</span>
				{/if}
			</button>
		{/each}
	</div>

	{#if selectedModule}
		<section class="story-card space-y-4 px-6 py-5">
			<div>
				<p class="font-hand text-2xl text-candle-300">{selectedModule.name}</p>
				<p class="text-sm text-mist-400">
					{Object.keys(selectedModule.slots).length} override slot{Object.keys(
						selectedModule.slots
					).length === 1
						? ''
						: 's'} declared · current version v{selectedModule.version}
				</p>
			</div>

			<details class="text-sm">
				<summary class="cursor-pointer font-hand text-base text-mist-400">
					declared slots
				</summary>
				<div class="mt-3 space-y-3">
					{#each Object.entries(selectedModule.slots) as [key, slot] (key)}
						<div class="border-l-2 border-candle-400/40 pl-3">
							<div class="font-mono text-xs uppercase tracking-wide text-candle-400">
								{key}
								<span class="font-hand normal-case text-mist-500">
									· {slot.kind}{#if slot.kind === 'number' && (slot.min != null || slot.max != null)}
										{#if slot.min != null && slot.max != null}
											· [{slot.min}..{slot.max}]
										{:else if slot.min != null}
											· ≥ {slot.min}
										{:else}
											· ≤ {slot.max}
										{/if}
									{/if}
								</span>
							</div>
							<div class="mt-1 text-xs text-mist-400">{slot.description}</div>
							<pre class="mt-1 whitespace-pre-wrap break-words font-mono text-xs text-mist-300"
								>{JSON.stringify(
									selectedModule.current[key] ?? slot.default,
									null,
									2
								)}{#if selectedModule.current[key] !== undefined}
									<span class="font-hand text-xs text-candle-300">
										(overridden; default: {JSON.stringify(slot.default)})</span
									>
								{/if}</pre>
						</div>
					{/each}
				</div>
			</details>

			<form
				method="POST"
				action="?/suggest"
				class="space-y-3"
				use:enhance={() => {
					pending = true;
					return async ({ update }) => {
						await update({ reset: false });
						pending = false;
					};
				}}
			>
				<input type="hidden" name="module_name" value={selectedModule.name} />
				<label class="block space-y-1">
					<span class="font-hand text-base text-candle-300">
						what should change in <code>{selectedModule.name}</code>?
					</span>
					<textarea
						name="feedback"
						rows="3"
						maxlength="1500"
						bind:value={feedback}
						placeholder={selectedModule.name === 'combat'
							? 'e.g. enemies should hit harder; fleeing should feel more uncertain; say the opening line more cheerfully'
							: 'e.g. make the greeting cozier; let replies run a little longer'}
						class="storybook-input w-full"
						required
					></textarea>
				</label>
				<button
					type="submit"
					class="storybook-button"
					disabled={pending || feedback.trim().length < 4}
				>
					{pending ? 'Asking Opus…' : '✧ Suggest an edit'}
				</button>
			</form>
		</section>
	{/if}

	{#if form?.error}
		<p class="text-sm text-rose-400">{form.error}</p>
	{/if}

	{#if form?.suggestion}
		<section class="story-card space-y-4 px-6 py-5">
			<div class="space-y-1">
				<p class="font-hand text-2xl text-candle-300">
					proposal · {form.suggestion.module_name}
				</p>
				<p class="text-sm text-mist-400">{form.suggestion.rationale}</p>
			</div>

			{#if changedKeys.length === 0}
				<p class="font-hand text-base text-mist-500">(no slots changed)</p>
			{:else}
				<div class="space-y-3">
					<p class="text-sm uppercase tracking-wide text-mist-500">
						changed slots ({changedKeys.length})
					</p>
					{#each changedKeys as key (key)}
						<div class="border-l-2 border-candle-400/50 pl-3">
							<div class="font-mono text-xs uppercase tracking-wide text-candle-400">
								{key}
							</div>
							<div class="mt-1 grid grid-cols-2 gap-3 text-sm">
								<div>
									<div class="text-xs text-rose-400">before</div>
									<pre
										class="whitespace-pre-wrap break-words font-mono text-xs text-rose-300/80">{JSON.stringify(
											(form.suggestion.current_overrides as any)[key] ??
												(form.suggestion.slots as any)[key]?.default,
											null,
											2
										)}</pre>
								</div>
								<div>
									<div class="text-xs text-teal-400">after</div>
									<pre
										class="whitespace-pre-wrap break-words font-mono text-xs text-teal-300/80">{JSON.stringify(
											(form.suggestion.suggested_overrides as any)[key],
											null,
											2
										)}</pre>
								</div>
							</div>
						</div>
					{/each}
				</div>

				<div class="flex gap-3 pt-2 items-center flex-wrap">
					<form method="POST" action="?/apply" use:enhance style="display:inline">
						<input
							type="hidden"
							name="proposal_id"
							value={form.suggestion.proposal_id}
						/>
						<button type="submit" class="storybook-button">
							✧ apply (new version)
						</button>
					</form>
					<span class="font-hand text-sm text-mist-500">
						v{form.suggestion.current_version} → v{form.suggestion.current_version + 1}
					</span>
					<form method="POST" action="?/dismiss" use:enhance style="display:inline">
						<input
							type="hidden"
							name="proposal_id"
							value={form.suggestion.proposal_id}
						/>
						<button
							type="submit"
							class="ml-auto text-sm text-mist-500 hover:text-mist-300"
						>
							dismiss
						</button>
					</form>
				</div>
			{/if}
		</section>
	{/if}

	{#if form?.applied}
		<p class="font-hand text-base text-candle-300">
			✨ applied — {form.applied.module_name} is now at v{form.applied.version}.
		</p>
	{/if}
	{#if form?.dismissed}
		<p class="font-hand text-base text-mist-400">dismissed.</p>
	{/if}

	{#if data.proposals.length > 0}
		<section class="space-y-3">
			<p class="font-hand text-2xl text-candle-300">recent proposals</p>
			<ul class="space-y-2">
				{#each data.proposals as p (p._id)}
					<li class="story-card px-4 py-3 text-sm">
						<div class="flex gap-3 items-center">
							<span class="font-mono text-xs text-candle-400">
								{p.module_name}
							</span>
							<span
								class="font-hand text-xs"
								class:text-teal-300={p.status === 'applied'}
								class:text-mist-500={p.status === 'dismissed'}
								class:text-candle-300={p.status === 'draft'}
							>
								{p.status}
							</span>
							<span class="text-xs text-mist-500">
								{new Date(p.created_at).toLocaleDateString()}
							</span>
							{#if p.applied_version}
								<span class="font-hand text-xs text-mist-500"
									>→ v{p.applied_version}</span
								>
							{/if}
						</div>
						<p class="mt-1 text-mist-300">{p.feedback_text}</p>
						{#if p.rationale}
							<p class="mt-1 text-xs text-mist-500">{p.rationale}</p>
						{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	<nav class="pt-4 text-sm text-mist-500">
		<a href="/admin/{data.world.slug}" class="hover:text-candle-300">← admin</a>
	</nav>
</section>

<style>
	.storybook-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.4rem 0.85rem;
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 999px;
		font-family: var(--font-hand);
		font-size: 0.875rem;
		color: var(--color-mist-300);
		background: transparent;
		cursor: pointer;
		transition: border-color 140ms ease, color 140ms ease;
	}
	.storybook-chip:hover {
		border-color: var(--color-candle-400);
		color: var(--color-candle-200);
	}
	.storybook-chip.is-active {
		border-color: var(--color-candle-400);
		color: var(--color-candle-200);
		background: rgba(255, 235, 180, 0.05);
	}
</style>
