<script lang="ts">
	import Icon from './Icon.svelte';

	let {
		upvoteCount = 0,
		haveMultipleVariants = false,
		busy = false,
		onRegen,
		onDelete,
		onUpvote,
		onFeedback,
		onPrev,
		onNext
	} = $props<{
		upvoteCount?: number;
		haveMultipleVariants?: boolean;
		busy?: boolean;
		onRegen: () => void;
		onDelete: () => void;
		onUpvote: () => void;
		onFeedback: () => void;
		onPrev: () => void;
		onNext: () => void;
	}>();
</script>

<div class="variant-controls" role="toolbar" aria-label="variant controls">
	<div class="vc-group">
		<button
			type="button"
			class="vc-btn"
			disabled={busy || !haveMultipleVariants}
			onclick={onPrev}
			aria-label="previous variant"
			title="previous variant"
		>
			<Icon name="chevron_left" size={16} />
		</button>
		<button
			type="button"
			class="vc-btn"
			disabled={busy || !haveMultipleVariants}
			onclick={onNext}
			aria-label="next variant"
			title="next variant"
		>
			<Icon name="chevron_right" size={16} />
		</button>
	</div>

	<button
		type="button"
		class="vc-btn vc-btn-vote"
		disabled={busy}
		onclick={onUpvote}
		aria-label="upvote this variant"
		title="upvote"
	>
		<Icon name="heart" size={16} />
		{#if upvoteCount > 0}
			<span class="vc-count font-hand">{upvoteCount}</span>
		{/if}
	</button>

	<button
		type="button"
		class="vc-btn"
		disabled={busy}
		onclick={onFeedback}
		aria-label="leave feedback for next regen"
		title="feedback"
	>
		<Icon name="pen" size={16} />
	</button>

	<button
		type="button"
		class="vc-btn vc-btn-regen"
		disabled={busy}
		onclick={onRegen}
		aria-label="regenerate a new variant"
		title="regenerate"
	>
		<Icon name="regen" size={16} />
	</button>

	<button
		type="button"
		class="vc-btn vc-btn-delete"
		disabled={busy}
		onclick={onDelete}
		aria-label="hide this variant"
		title="hide"
	>
		<Icon name="trash" size={16} />
	</button>
</div>

<style>
	.variant-controls {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
		padding: 0.2rem 0.3rem;
		background: linear-gradient(180deg, rgba(20, 17, 40, 0.88), rgba(12, 10, 24, 0.92));
		border: 1px solid rgba(159, 140, 210, 0.22);
		border-radius: 6px;
		backdrop-filter: blur(6px);
	}
	.vc-group {
		display: inline-flex;
		align-items: center;
		border-right: 1px solid rgba(159, 140, 210, 0.14);
		padding-right: 0.15rem;
		margin-right: 0.15rem;
	}
	.vc-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.15rem;
		min-width: 2rem;
		min-height: 2rem;
		padding: 0 0.35rem;
		background: transparent;
		border: none;
		border-radius: 4px;
		color: var(--color-mist-400);
		cursor: pointer;
		transition: color 120ms ease, background 140ms ease;
	}
	.vc-btn:hover:not(:disabled) {
		color: var(--color-mist-100);
		background: rgba(159, 140, 210, 0.12);
	}
	.vc-btn:focus-visible {
		outline: none;
		color: var(--color-mist-100);
		box-shadow: 0 0 0 2px rgba(240, 80, 128, 0.35);
	}
	.vc-btn:disabled {
		opacity: 0.35;
		cursor: default;
	}
	.vc-btn-vote:hover:not(:disabled) {
		color: var(--color-rose-400);
		background: rgba(240, 80, 128, 0.12);
	}
	.vc-btn-regen:hover:not(:disabled) {
		color: var(--color-candle-300);
	}
	.vc-btn-delete:hover:not(:disabled) {
		color: var(--color-rose-500);
	}
	.vc-count {
		color: var(--color-rose-300);
		font-size: 1rem;
		line-height: 1;
	}

	/* Touch target min on mobile — the inner buttons are 32px visible but
	   the whole bar meets 44px for the group. Individual buttons pad out
	   on coarse-pointer devices. */
	@media (pointer: coarse) {
		.vc-btn {
			min-width: 2.4rem;
			min-height: 2.4rem;
		}
	}
</style>
