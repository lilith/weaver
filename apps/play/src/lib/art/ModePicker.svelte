<script lang="ts">
	import Icon from './Icon.svelte';
	import { MODE_META } from './modes.js';

	let {
		modes,
		busyMode = null,
		onPick,
		onClose
	} = $props<{
		modes: readonly string[];
		busyMode?: string | null;
		onPick: (mode: string) => void;
		onClose: () => void;
	}>();
</script>

<div class="wardrobe-picker" role="dialog" aria-label="choose an art mode">
	<div class="wardrobe-picker-head">
		<span class="font-hand text-candle-300 text-xl">the wardrobe</span>
		<button
			type="button"
			class="wardrobe-picker-close"
			onclick={onClose}
			aria-label="close wardrobe"
		>
			<Icon name="close" size={16} />
		</button>
	</div>

	<p class="wardrobe-picker-hint">
		Nothing conjured here yet. Pick a treatment; the others can follow.
	</p>

	<ul class="wardrobe-picker-grid">
		{#each modes as key (key)}
			{@const m = MODE_META[key]}
			{#if m}
				<li>
					<button
						type="button"
						class="wardrobe-tile"
						class:wardrobe-tile-busy={busyMode === key}
						disabled={busyMode !== null}
						onclick={() => onPick(key)}
					>
						<span class="wardrobe-tile-label font-display">{m.label}</span>
						<span class="wardrobe-tile-line font-hand">{m.tagline}</span>
						{#if busyMode === key}
							<span class="wardrobe-tile-brew font-hand">brewing…</span>
						{/if}
					</button>
				</li>
			{/if}
		{/each}
	</ul>
</div>

<style>
	.wardrobe-picker {
		position: relative;
		padding: 1rem 1.1rem 1.2rem;
		background:
			linear-gradient(180deg, rgba(31, 26, 56, 0.94), rgba(20, 17, 40, 0.96)),
			radial-gradient(circle at 25% 0%, rgba(253, 213, 122, 0.08), transparent 55%);
		border: 1px solid rgba(159, 140, 210, 0.22);
		border-radius: var(--radius-card);
		box-shadow: var(--shadow-panel);
	}
	.wardrobe-picker::before {
		content: '';
		position: absolute;
		inset: 5px;
		border: 1px dashed rgba(159, 140, 210, 0.12);
		border-radius: calc(var(--radius-card) - 3px);
		pointer-events: none;
	}
	.wardrobe-picker-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 0.25rem;
	}
	.wardrobe-picker-hint {
		color: var(--color-mist-400);
		font-size: 0.95rem;
		margin-bottom: 0.75rem;
	}
	.wardrobe-picker-close {
		color: var(--color-mist-600);
		padding: 0.35rem;
		line-height: 0;
		border-radius: 3px;
		transition: color 140ms ease, background 140ms ease;
	}
	.wardrobe-picker-close:hover {
		color: var(--color-rose-400);
		background: rgba(240, 80, 128, 0.1);
	}
	.wardrobe-picker-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
		gap: 0.5rem;
	}
	.wardrobe-tile {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		align-items: flex-start;
		text-align: left;
		min-height: 3.6rem;
		padding: 0.65rem 0.8rem;
		background: linear-gradient(
			145deg,
			rgba(43, 36, 79, 0.55),
			rgba(20, 17, 40, 0.8)
		);
		border: 1px solid rgba(159, 140, 210, 0.2);
		border-radius: 0.4rem;
		color: var(--color-mist-100);
		cursor: pointer;
		transition: border-color 140ms ease, background 140ms ease,
			transform 100ms ease, box-shadow 180ms ease;
	}
	.wardrobe-tile:hover:not(:disabled) {
		border-color: var(--color-candle-300);
		background: linear-gradient(
			145deg,
			rgba(60, 51, 105, 0.7),
			rgba(32, 27, 67, 0.92)
		);
		box-shadow: 0 0 24px rgba(232, 160, 36, 0.15);
	}
	.wardrobe-tile:focus-visible {
		outline: none;
		border-color: var(--color-rose-400);
		box-shadow: 0 0 0 3px rgba(240, 80, 128, 0.25);
	}
	.wardrobe-tile:disabled {
		opacity: 0.6;
		cursor: wait;
	}
	.wardrobe-tile-busy {
		border-color: var(--color-candle-400);
		box-shadow: 0 0 18px rgba(232, 160, 36, 0.35);
	}
	.wardrobe-tile-label {
		font-size: 1.15rem;
		letter-spacing: 0.01em;
	}
	.wardrobe-tile-line {
		color: var(--color-mist-400);
		font-size: 1rem;
		line-height: 1.25;
	}
	.wardrobe-tile-brew {
		color: var(--color-candle-300);
		font-size: 0.95rem;
		margin-top: 0.15rem;
	}
</style>
