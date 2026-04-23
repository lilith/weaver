<script lang="ts">
	import { enhance } from '$app/forms';
	let { data, form } = $props();

	const GROUPS = [
		{ id: 'game', label: 'game systems' },
		{ id: 'ai', label: 'ai-assisted features' },
		{ id: 'admin', label: 'admin surfaces' },
		{ id: 'ui', label: 'ui' }
	] as const;

	function byGroup(g: string) {
		return data.flags.filter((f: any) => f.group === g);
	}
</script>

<section class="space-y-8 py-6">
	<header class="space-y-2">
		<p class="font-hand text-base text-candle-300">admin · settings</p>
		<h1 class="font-display text-3xl text-mist-100 sm:text-4xl">
			{data.world.name}
		</h1>
		<p class="text-sm text-mist-400">
			Per-world feature flags. Toggle to override the global default. "Clear"
			removes the world override and lets the global default win again.
		</p>
	</header>

	{#if form?.error}
		<p class="text-sm text-rose-400">{form.error}</p>
	{/if}
	{#if form?.toggled}
		<p class="font-hand text-base text-candle-300">
			✓ <code>{form.toggled.flag_key}</code> is now
			{form.toggled.enabled ? 'on' : 'off'}.
		</p>
	{/if}
	{#if form?.cleared}
		<p class="font-hand text-base text-candle-300">
			cleared <code>{form.cleared.flag_key}</code> (falls through to global default).
		</p>
	{/if}

	{#each GROUPS as group (group.id)}
		{@const rows = byGroup(group.id)}
		{#if rows.length > 0}
			<section class="space-y-3">
				<p class="font-hand text-2xl text-candle-300">{group.label}</p>
				<ul class="space-y-2">
					{#each rows as f (f.key)}
						<li
							class="story-card px-5 py-4 space-y-2"
							class:is-on={f.enabled}
						>
							<div class="flex items-center gap-3 flex-wrap">
								<span
									class="font-mono text-sm"
									class:text-teal-300={f.enabled}
									class:text-mist-500={!f.enabled}
								>
									{f.enabled ? '● on' : '○ off'}
								</span>
								<span class="font-hand text-base text-mist-200">{f.label}</span>
								<span
									class="ml-auto font-mono text-xs"
									class:text-candle-300={f.world_override !== null}
									class:text-mist-500={f.world_override === null}
								>
									{f.world_override === null
										? `default: ${f.default ? 'on' : 'off'}`
										: `world override: ${f.world_override ? 'on' : 'off'}`}
								</span>
							</div>
							<p class="text-xs text-mist-400">{f.description}</p>
							{#if f.caveat}
								<p class="text-xs text-amber-300/80">⚠ {f.caveat}</p>
							{/if}
							<div class="flex gap-2 items-center flex-wrap">
								<form method="POST" action="?/toggle" use:enhance>
									<input type="hidden" name="flag_key" value={f.key} />
									<input
										type="hidden"
										name="next"
										value={f.enabled ? 'off' : 'on'}
									/>
									<button type="submit" class="storybook-button text-sm">
										turn {f.enabled ? 'off' : 'on'}
									</button>
								</form>
								{#if f.world_override !== null}
									<form method="POST" action="?/clear" use:enhance>
										<input type="hidden" name="flag_key" value={f.key} />
										<button
											type="submit"
											class="text-sm text-mist-500 hover:text-mist-300"
										>
											clear override
										</button>
									</form>
								{/if}
								<code class="ml-auto font-mono text-xs text-mist-600">
									{f.key}
								</code>
							</div>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	{/each}

	<nav class="pt-4 text-sm text-mist-500">
		<a href="/admin/{data.world.slug}" class="hover:text-candle-300">← admin</a>
	</nav>
</section>

<style>
	.story-card.is-on {
		border-color: color-mix(in oklab, var(--color-candle-400) 35%, transparent);
	}
</style>
