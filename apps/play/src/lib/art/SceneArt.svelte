<script lang="ts">
	// SceneArt — the art-curation wardrobe for a single entity.
	//
	// Mounts one reactive subscription to
	// `art_curation.getRenderingsForEntity`; routes actions/mutations
	// through `useConvexClient`. The component renders *nothing* visual
	// until the eye is opened, matching the spec's "text is the default"
	// stance — it only ever reserves the eye-icon slot in the header.
	//
	// Mode layouts (spec ART_CURATION.md §Wardrobe):
	//   banner        → 21:9 strip above the page title
	//   hero_full     → 16:9 above the page title (legacy-ish)
	//   portrait_badge→ 72px circular badge beside the byline
	//   tarot_card    → 3:5 card in a popover anchored next to the title
	//   illumination  → CSS variable + class on document to drop-cap the
	//                   next ".story-prose" paragraph's first letter
	//   ambient_palette→ CSS variable tint the page backdrop

	import { useConvexClient, useQuery } from 'convex-svelte';
	import { api } from '$convex/_generated/api';
	import type { Id } from '$convex/_generated/dataModel';
	import { blobUrl } from './blob.js';
	import { MODE_META, modeMeta } from './modes.js';
	import Icon from './Icon.svelte';
	import ModePicker from './ModePicker.svelte';
	import VariantControls from './VariantControls.svelte';

	let {
		entityId,
		worldSlug,
		sessionToken,
		artCurationEnabled
	} = $props<{
		entityId: string;
		worldSlug: string;
		sessionToken: string;
		artCurationEnabled: boolean;
	}>();

	// Parent gates this component behind the flag already — mounting it
	// implies artCurationEnabled === true. We still accept the prop as
	// an explicit guard so the component is safe to mount eagerly, and
	// so the `useQuery` subscription can skip cleanly if the flag flips.
	const client = useConvexClient();

	// -----------------------------------------------------------------
	// Reactive renderings subscription. The closure form lets useQuery
	// react to prop changes and also support "skip" when disabled.
	// -----------------------------------------------------------------
	const query = useQuery(api.art_curation.getRenderingsForEntity, () =>
		artCurationEnabled
			? {
					session_token: sessionToken,
					world_slug: worldSlug,
					entity_id: entityId as Id<'entities'>
				}
			: 'skip'
	);

	// Derived view: modes that have at least one non-hidden variant,
	// the currently selected mode, and the currently selected variant.
	let selectedMode = $state<string | null>(null);
	let variantIndex = $state(0); // index into the mode's variants array
	let expanded = $state(false); // eye open?
	let pickerOpen = $state(false); // mode-picker visible?
	let busyAction = $state<string | null>(null); // in-flight action key
	let conjuringMode = $state<string | null>(null);
	let toast = $state<{ kind: 'ok' | 'err'; text: string } | null>(null);
	let feedbackDraft = $state<string | null>(null); // null = closed; "" = open empty
	let tarotPopover = $state(false);

	const rendering = $derived.by(() => {
		const d: any = query.data;
		if (!d) return null;
		return d;
	});

	const availableModes = $derived.by((): string[] => {
		if (!rendering) return [];
		return Object.keys(rendering.modes).filter(
			(m) => (rendering.modes[m] ?? []).length > 0
		);
	});

	const waveModes = $derived.by((): string[] => {
		return rendering?.wave_2_modes ?? Object.keys(MODE_META);
	});

	const currentMode = $derived.by((): string | null => {
		if (selectedMode && rendering?.modes?.[selectedMode]?.length) return selectedMode;
		// top-voted mode with at least one variant
		if (availableModes.length === 0) return null;
		const byUp = [...availableModes].sort((a, b) => {
			const av = rendering!.modes[a][0]?.upvote_count ?? 0;
			const bv = rendering!.modes[b][0]?.upvote_count ?? 0;
			return bv - av;
		});
		return byUp[0];
	});

	const currentVariants = $derived.by((): any[] => {
		const m = currentMode;
		if (!m || !rendering) return [];
		return rendering.modes[m] ?? [];
	});

	const currentVariant = $derived.by(() => {
		const list = currentVariants;
		if (!list.length) return null;
		const idx = Math.min(Math.max(variantIndex, 0), list.length - 1);
		return list[idx];
	});

	const hasAnyArt = $derived(availableModes.length > 0);

	// Whenever the current mode's variant list shrinks (e.g. after a
	// delete), keep variantIndex in bounds.
	$effect(() => {
		const len = currentVariants.length;
		if (variantIndex >= len) variantIndex = Math.max(0, len - 1);
	});

	// Ambient-palette side effect: when the display falls back to or
	// explicitly selects ambient_palette, warm the page backdrop with
	// the candle-palette. Clears on unmount / mode change.
	let ambientTint = $state(false);
	$effect(() => {
		const wantAmbient =
			expanded && (currentMode === 'ambient_palette' || currentMode === null);
		ambientTint = wantAmbient && hasAnyArt && currentMode === 'ambient_palette';
	});

	// -----------------------------------------------------------------
	// Toast — fades after 2.5s
	// -----------------------------------------------------------------
	let toastTimer: ReturnType<typeof setTimeout> | null = null;
	function flash(kind: 'ok' | 'err', text: string) {
		toast = { kind, text };
		if (toastTimer) clearTimeout(toastTimer);
		toastTimer = setTimeout(() => {
			toast = null;
			toastTimer = null;
		}, 2500);
	}

	// -----------------------------------------------------------------
	// Actions
	// -----------------------------------------------------------------
	async function conjure(mode: string) {
		if (!client) return;
		conjuringMode = mode;
		busyAction = `conjure:${mode}`;
		try {
			await client.action(api.art_curation.conjureForEntity, {
				session_token: sessionToken,
				world_slug: worldSlug,
				entity_id: entityId as Id<'entities'>,
				mode
			});
			selectedMode = mode;
			variantIndex = 0;
			pickerOpen = false;
			flash('ok', mode === 'ambient_palette' ? 'palette extracted.' : 'brewing…');
		} catch (e) {
			console.error('[art] conjure failed', e);
			flash('err', (e as Error).message ?? 'conjure failed');
		} finally {
			conjuringMode = null;
			busyAction = null;
		}
	}

	async function regen() {
		if (!client || !currentVariant) return;
		busyAction = 'regen';
		try {
			await client.action(api.art_curation.regenVariant, {
				session_token: sessionToken,
				world_slug: worldSlug,
				rendering_id: currentVariant.id
			});
			// The new row lands top of the variants list once ready; move
			// to index 0 so the user sees the in-flight brewing tile.
			variantIndex = 0;
			flash('ok', 'brewing a fresh one…');
		} catch (e) {
			console.error('[art] regen failed', e);
			flash('err', (e as Error).message ?? 'regen failed');
		} finally {
			busyAction = null;
		}
	}

	async function deleteVariant() {
		if (!client || !currentVariant) return;
		busyAction = 'delete';
		try {
			await client.mutation(api.art_curation.deleteVariant, {
				session_token: sessionToken,
				world_slug: worldSlug,
				rendering_id: currentVariant.id
			});
			flash('ok', 'tucked away.');
		} catch (e) {
			console.error('[art] delete failed', e);
			flash('err', (e as Error).message ?? 'delete failed');
		} finally {
			busyAction = null;
		}
	}

	async function upvote() {
		if (!client || !currentVariant) return;
		busyAction = 'upvote';
		try {
			await client.mutation(api.art_curation.upvoteVariant, {
				session_token: sessionToken,
				world_slug: worldSlug,
				rendering_id: currentVariant.id
			});
			flash('ok', 'pinned to the board.');
		} catch (e) {
			console.error('[art] upvote failed', e);
			flash('err', (e as Error).message ?? 'upvote failed');
		} finally {
			busyAction = null;
		}
	}

	async function submitFeedback() {
		if (!client || !currentVariant) return;
		const comment = (feedbackDraft ?? '').trim();
		if (!comment) {
			feedbackDraft = null;
			return;
		}
		busyAction = 'feedback';
		try {
			await client.mutation(api.art_curation.addFeedback, {
				session_token: sessionToken,
				world_slug: worldSlug,
				rendering_id: currentVariant.id,
				comment
			});
			flash('ok', 'noted for the next pass.');
			feedbackDraft = null;
		} catch (e) {
			console.error('[art] feedback failed', e);
			flash('err', (e as Error).message ?? 'feedback failed');
		} finally {
			busyAction = null;
		}
	}

	function nextVariant() {
		if (currentVariants.length <= 1) return;
		variantIndex = (variantIndex + 1) % currentVariants.length;
	}
	function prevVariant() {
		if (currentVariants.length <= 1) return;
		variantIndex =
			(variantIndex - 1 + currentVariants.length) % currentVariants.length;
	}

	// -----------------------------------------------------------------
	// Event handlers
	// -----------------------------------------------------------------
	function toggleEye() {
		if (!artCurationEnabled) return;
		if (!expanded) {
			// Opening
			if (!hasAnyArt) {
				pickerOpen = true;
			}
			expanded = true;
		} else {
			// Closing — collapse the picker, popover, and feedback too
			expanded = false;
			pickerOpen = false;
			tarotPopover = false;
			feedbackDraft = null;
		}
	}

	function selectMode(mode: string) {
		selectedMode = mode;
		variantIndex = 0;
		if (mode === 'tarot_card') tarotPopover = true;
	}

	function openPicker() {
		pickerOpen = true;
	}
	function closePicker() {
		pickerOpen = false;
	}
	function openFeedback() {
		feedbackDraft = '';
	}

	// -----------------------------------------------------------------
	// Illumination: set a CSS var on :root while this drop-cap mode is
	// showing. The +page.svelte prose uses data-illumination to swap
	// first-letter styling. Cleans up on teardown.
	// -----------------------------------------------------------------
	let illuminationUrl = $state<string | null>(null);
	$effect(() => {
		if (!expanded || currentMode !== 'illumination') {
			illuminationUrl = null;
			return;
		}
		const url = currentVariant?.blob_hash ? blobUrl(currentVariant.blob_hash) : null;
		illuminationUrl = url;
	});
	$effect(() => {
		if (typeof document === 'undefined') return;
		const root = document.documentElement;
		if (illuminationUrl) {
			root.style.setProperty('--illumination-url', `url("${illuminationUrl}")`);
			root.dataset.illumination = 'on';
		} else {
			root.style.removeProperty('--illumination-url');
			delete root.dataset.illumination;
		}
		return () => {
			root.style.removeProperty('--illumination-url');
			delete root.dataset.illumination;
		};
	});

	// Ambient tint side-effect on :root.
	$effect(() => {
		if (typeof document === 'undefined') return;
		const root = document.documentElement;
		if (ambientTint) root.dataset.ambientTint = 'on';
		else delete root.dataset.ambientTint;
		return () => {
			delete root.dataset.ambientTint;
		};
	});

	// When the wardrobe is opened with zero art, auto-open the picker.
	$effect(() => {
		if (expanded && !hasAnyArt && !pickerOpen && !conjuringMode) {
			pickerOpen = true;
		}
	});
</script>

{#if artCurationEnabled}
	<div class="scene-art-slot">
		<!-- Eye affordance — always visible, top-right of the art slot. -->
		<button
			type="button"
			class="wardrobe-eye"
			class:wardrobe-eye-filled={hasAnyArt}
			class:wardrobe-eye-open={expanded}
			onclick={toggleEye}
			aria-expanded={expanded}
			aria-label={expanded ? 'close the wardrobe' : 'open the wardrobe'}
		>
			{#if expanded}
				<Icon name="eye_open" size={18} />
			{:else}
				<Icon name="eye_closed" size={18} />
			{/if}
		</button>

		{#if expanded}
			<!-- Layouts. Only one layout layer renders at a time. -->
			{@const variant = currentVariant}
			{@const meta = currentMode ? modeMeta(currentMode) : null}
			{@const url = variant?.blob_hash ? blobUrl(variant.blob_hash) : null}
			{@const isGenerating =
				variant && (variant.status === 'queued' || variant.status === 'generating')}
			{@const isFailed = variant && variant.status === 'failed'}

			{#if pickerOpen || (!hasAnyArt && !conjuringMode)}
				<div class="wardrobe-overlay">
					<ModePicker
						modes={waveModes}
						busyMode={conjuringMode}
						onPick={(m) => conjure(m)}
						onClose={closePicker}
					/>
				</div>
			{:else if meta?.layout === 'banner'}
				<div class="art-banner-wrap" class:art-dim={isGenerating || isFailed}>
					{#if url && !isGenerating}
						<img
							src={url}
							alt=""
							class="art-banner-img"
							loading="lazy"
							onerror={(e) => {
								(e.target as HTMLImageElement).style.display = 'none';
							}}
						/>
					{:else if isGenerating}
						<div class="art-brew">
							<span class="font-hand text-candle-300">weaving an image…</span>
						</div>
					{:else if isFailed}
						<div class="art-brew">
							<span class="font-hand text-rose-400">the thread snagged</span>
						</div>
					{/if}
				</div>
			{:else if meta?.layout === 'hero_full'}
				<div class="art-hero-wrap" class:art-dim={isGenerating || isFailed}>
					{#if url && !isGenerating}
						<img src={url} alt="" class="art-hero-img" loading="lazy" />
					{:else if isGenerating}
						<div class="art-brew">
							<span class="font-hand text-candle-300">weaving the scene…</span>
						</div>
					{:else if isFailed}
						<div class="art-brew">
							<span class="font-hand text-rose-400">the thread snagged</span>
						</div>
					{/if}
				</div>
			{:else if meta?.layout === 'portrait'}
				<div class="art-portrait-wrap">
					{#if url && !isGenerating}
						<img src={url} alt="" class="art-portrait-img" loading="lazy" />
					{:else}
						<div class="art-portrait-fallback">
							<Icon name="spark" size={22} />
						</div>
					{/if}
				</div>
			{:else if meta?.layout === 'tarot'}
				<!-- Tarot: show a compact thumbnail affordance; full card in popover. -->
				<div class="art-tarot-anchor">
					<button
						type="button"
						class="art-tarot-peek"
						onclick={() => (tarotPopover = !tarotPopover)}
						aria-label="open tarot card"
					>
						{#if url && !isGenerating}
							<img src={url} alt="" class="art-tarot-thumb" loading="lazy" />
						{:else}
							<span class="font-hand text-candle-300">a card, drawn.</span>
						{/if}
					</button>
					{#if tarotPopover}
						<div class="art-tarot-popover" role="dialog" aria-label="tarot card">
							<button
								type="button"
								class="art-tarot-close"
								onclick={() => (tarotPopover = false)}
								aria-label="close"
							>
								<Icon name="close" size={14} />
							</button>
							{#if url && !isGenerating}
								<img src={url} alt="" class="art-tarot-img" />
							{:else if isGenerating}
								<div class="art-brew">
									<span class="font-hand text-candle-300">shuffling…</span>
								</div>
							{/if}
						</div>
					{/if}
				</div>
			{:else if meta?.layout === 'ambient'}
				<!-- Ambient palette: purely backdrop; show a small confirmation. -->
				<div class="art-ambient-confirm">
					<span class="font-hand text-candle-300">the room warms a shade.</span>
				</div>
			{:else if meta?.layout === 'drop_cap'}
				<!-- Drop-cap: the side effect above sets --illumination-url on :root.
				     The .story-prose first-letter uses it. No visible block here. -->
				<div class="art-illumination-confirm">
					<span class="font-hand text-candle-300">an illumination, set in the margin.</span>
				</div>
			{/if}

			<!-- Mode dots + controls: visible whenever the wardrobe is open and
			     we aren't inside the picker. Each dot is a mode; filled =
			     variants exist, outlined = none. Controls apply to the
			     currently-displayed variant. -->
			{#if !pickerOpen && hasAnyArt}
				<div class="wardrobe-strip">
					<ul class="mode-dots" role="tablist" aria-label="art modes">
						{#each waveModes as key (key)}
							{@const count = rendering?.modes?.[key]?.length ?? 0}
							{@const filled = count > 0}
							{@const active = currentMode === key}
							<li>
								<button
									type="button"
									class="mode-dot"
									class:mode-dot-filled={filled}
									class:mode-dot-active={active}
									onclick={() => {
										if (filled) selectMode(key);
										else {
											selectedMode = null;
											pickerOpen = true;
										}
									}}
									role="tab"
									aria-selected={active}
									title={filled
										? `${MODE_META[key]?.label ?? key} — ${count} variant${count === 1 ? '' : 's'}`
										: `${MODE_META[key]?.label ?? key} — not yet conjured`}
									aria-label={filled
										? `${MODE_META[key]?.label ?? key}, ${count} variant${count === 1 ? '' : 's'}`
										: `conjure ${MODE_META[key]?.label ?? key}`}
								></button>
							</li>
						{/each}
						<li class="mode-dots-add">
							<button
								type="button"
								class="mode-dot-add"
								onclick={openPicker}
								aria-label="open wardrobe picker"
								title="open wardrobe"
							>
								+
							</button>
						</li>
					</ul>

					<div class="variant-controls-wrap">
						{#if currentVariant}
							<VariantControls
								upvoteCount={currentVariant.upvote_count ?? 0}
								haveMultipleVariants={currentVariants.length > 1}
								busy={busyAction !== null}
								onRegen={regen}
								onDelete={deleteVariant}
								onUpvote={upvote}
								onFeedback={openFeedback}
								onPrev={prevVariant}
								onNext={nextVariant}
							/>
						{/if}
					</div>
				</div>

				{#if meta && variant}
					<div class="variant-byline-row">
						<p class="variant-byline font-hand">
							{meta.label}
							{#if currentVariants.length > 1}
								· {variantIndex + 1} of {currentVariants.length}
							{/if}
							{#if (variant.upvote_count ?? 0) > 0}
								· {variant.upvote_count} ♥
							{/if}
						</p>
						<!-- Prominent "roll again" — tap-to-cycle the current mode
							 into a fresh variant. Variants accumulate; use the dots
							 above to flip back. -->
						<button
							type="button"
							class="roll-again font-hand"
							disabled={busyAction !== null}
							onclick={regen}
							title="roll again in this mode"
						>
							{#if busyAction === 'regen'}
								<span class="weave-spinner" aria-hidden="true"></span>
								brewing…
							{:else}
								↻ roll again
							{/if}
						</button>
					</div>
				{/if}
			{/if}

			{#if feedbackDraft !== null}
				<div class="feedback-panel">
					<label class="font-hand text-candle-300" for="art-feedback-input">
						a note for the next gen
					</label>
					<textarea
						id="art-feedback-input"
						class="storybook-input feedback-input"
						rows="2"
						maxlength="500"
						placeholder="warmer light, fewer figures, something mossier…"
						bind:value={feedbackDraft}
					></textarea>
					<div class="feedback-panel-actions">
						<button
							type="button"
							class="feedback-cancel"
							onclick={() => (feedbackDraft = null)}
						>
							cancel
						</button>
						<button
							type="button"
							class="storybook-button feedback-submit"
							disabled={busyAction === 'feedback' || !(feedbackDraft?.trim())}
							onclick={submitFeedback}
						>
							save note
						</button>
					</div>
				</div>
			{/if}
		{/if}

		{#if toast}
			<div class="art-toast" class:art-toast-err={toast.kind === 'err'}>
				<span class="font-hand">{toast.text}</span>
			</div>
		{/if}
	</div>
{/if}

<style>
	/* --------------------------------------------------------------
	   Outer slot. The host .scene-art region in the parent collapses
	   when flag is on; we just float the eye + whatever layout the
	   current mode demands. Relative positioning so the popover and
	   eye have an anchor.
	   -------------------------------------------------------------- */
	.scene-art-slot {
		position: relative;
		display: block;
		/* Reserve a sliver so the floated eye has an anchor when no art
		   is rendered yet. Keeps the eye from overflowing into the
		   header above it and preserves a 44px tap target. */
		min-height: 28px;
		margin-bottom: 0.25rem;
	}
	.scene-art-slot:has(.art-banner-wrap),
	.scene-art-slot:has(.art-hero-wrap),
	.scene-art-slot:has(.wardrobe-overlay) {
		min-height: 0;
	}

	/* --------------------------------------------------------------
	   Eye affordance
	   -------------------------------------------------------------- */
	.wardrobe-eye {
		position: absolute;
		top: -6px;
		right: -4px;
		z-index: 3;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 44px;
		height: 44px;
		padding: 0;
		background: transparent;
		border: none;
		color: var(--color-mist-600);
		cursor: pointer;
		transition: color 160ms ease;
	}
	/* When the wardrobe is showing art, nudge the eye into the art's top
	   corner so it floats over the image rather than hovering above it. */
	.scene-art-slot:has(.art-banner-wrap) .wardrobe-eye,
	.scene-art-slot:has(.art-hero-wrap) .wardrobe-eye,
	.scene-art-slot:has(.wardrobe-overlay) .wardrobe-eye {
		top: 0.35rem;
		right: 0.35rem;
		color: var(--color-mist-200);
		background: rgba(12, 10, 24, 0.55);
		border-radius: 3px;
	}
	.scene-art-slot:has(.art-banner-wrap) .wardrobe-eye:hover,
	.scene-art-slot:has(.art-hero-wrap) .wardrobe-eye:hover,
	.scene-art-slot:has(.wardrobe-overlay) .wardrobe-eye:hover {
		background: rgba(12, 10, 24, 0.8);
	}
	.wardrobe-eye:hover,
	.wardrobe-eye:focus-visible {
		color: var(--color-candle-300);
		outline: none;
	}
	.wardrobe-eye::after {
		/* The "has art" dot — only on when renderings exist. */
		content: '';
		position: absolute;
		right: 7px;
		bottom: 7px;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: transparent;
		border: 1px solid currentColor;
		transition: background 160ms ease, border-color 160ms ease,
			box-shadow 220ms ease;
	}
	.wardrobe-eye-filled::after {
		background: var(--color-candle-300);
		border-color: var(--color-candle-300);
		box-shadow: 0 0 6px rgba(249, 213, 122, 0.6);
	}
	.wardrobe-eye-open {
		color: var(--color-candle-300);
	}

	/* --------------------------------------------------------------
	   Banner — 21:9 above title
	   -------------------------------------------------------------- */
	.art-banner-wrap {
		position: relative;
		aspect-ratio: 21 / 9;
		width: 100%;
		border-radius: var(--radius-card);
		overflow: hidden;
		margin-bottom: 0.6rem;
		box-shadow: var(--shadow-panel);
		background: linear-gradient(145deg, var(--color-velvet-800), var(--color-ink-900));
		border: 1px solid rgba(159, 140, 210, 0.14);
	}
	.art-banner-img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.art-banner-wrap::after {
		/* Ink-wash top/bottom vignette so title text stays readable when
		   banner abuts it. */
		content: '';
		position: absolute;
		inset: 0;
		pointer-events: none;
		background:
			linear-gradient(180deg, rgba(12, 10, 24, 0.45) 0%, transparent 30%),
			linear-gradient(0deg, rgba(12, 10, 24, 0.7) 0%, transparent 55%);
	}

	/* --------------------------------------------------------------
	   Hero (legacy 16:9)
	   -------------------------------------------------------------- */
	.art-hero-wrap {
		position: relative;
		aspect-ratio: 16 / 9;
		width: 100%;
		border-radius: var(--radius-card);
		overflow: hidden;
		margin-bottom: 0.6rem;
		box-shadow: var(--shadow-panel);
		background: linear-gradient(145deg, var(--color-velvet-800), var(--color-ink-900));
		border: 1px solid rgba(159, 140, 210, 0.14);
	}
	.art-hero-img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	/* --------------------------------------------------------------
	   Portrait badge — 72px circle, floated
	   -------------------------------------------------------------- */
	.art-portrait-wrap {
		float: left;
		margin: 0 0.85rem 0.25rem 0;
		width: 72px;
		height: 72px;
	}
	.art-portrait-img,
	.art-portrait-fallback {
		width: 72px;
		height: 72px;
		border-radius: 50%;
		object-fit: cover;
		box-shadow: 0 0 0 2px var(--color-ink-900),
			0 0 0 3px rgba(232, 160, 36, 0.45),
			0 0 20px rgba(232, 160, 36, 0.22);
	}
	.art-portrait-fallback {
		display: flex;
		align-items: center;
		justify-content: center;
		background: linear-gradient(145deg, var(--color-velvet-700), var(--color-ink-900));
		color: var(--color-candle-300);
	}

	/* --------------------------------------------------------------
	   Tarot — 3:5 card in a popover
	   -------------------------------------------------------------- */
	.art-tarot-anchor {
		position: relative;
		display: block;
	}
	.art-tarot-peek {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.35rem 0.7rem;
		background: linear-gradient(145deg, rgba(31, 26, 56, 0.7), rgba(20, 17, 40, 0.9));
		border: 1px solid rgba(232, 160, 36, 0.3);
		border-radius: 0.4rem;
		color: var(--color-candle-200);
		cursor: pointer;
		transition: border-color 160ms ease, box-shadow 200ms ease;
	}
	.art-tarot-peek:hover {
		border-color: var(--color-rose-400);
		box-shadow: 0 0 16px rgba(240, 80, 128, 0.25);
	}
	.art-tarot-thumb {
		width: 32px;
		height: 48px;
		object-fit: cover;
		border-radius: 2px;
		box-shadow: 0 0 0 1px rgba(232, 160, 36, 0.5);
	}
	.art-tarot-popover {
		position: absolute;
		top: calc(100% + 0.5rem);
		left: 0;
		width: 230px;
		padding: 0.5rem;
		z-index: 5;
		background:
			linear-gradient(180deg, #1a1634 0%, #0c0a18 100%),
			radial-gradient(circle at top, rgba(232, 160, 36, 0.18), transparent 55%);
		border: 1px solid rgba(232, 160, 36, 0.55);
		box-shadow:
			0 0 0 1px rgba(12, 10, 24, 0.9),
			0 0 30px rgba(232, 160, 36, 0.3),
			var(--shadow-panel);
	}
	.art-tarot-popover::before {
		/* An art-nouveau double-border look — cheap but effective. */
		content: '';
		position: absolute;
		inset: 5px;
		border: 1px solid rgba(253, 213, 122, 0.25);
		pointer-events: none;
	}
	.art-tarot-img {
		display: block;
		width: 100%;
		aspect-ratio: 3 / 5;
		object-fit: cover;
		border: 1px solid rgba(232, 160, 36, 0.4);
	}
	.art-tarot-close {
		position: absolute;
		top: 4px;
		right: 4px;
		z-index: 2;
		width: 22px;
		height: 22px;
		padding: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: rgba(12, 10, 24, 0.85);
		border: 1px solid rgba(232, 160, 36, 0.4);
		color: var(--color-mist-400);
		border-radius: 2px;
		cursor: pointer;
	}
	.art-tarot-close:hover {
		color: var(--color-rose-400);
		border-color: var(--color-rose-400);
	}

	/* --------------------------------------------------------------
	   Ambient + illumination confirmation strips — no image, just a
	   small acknowledgement line.
	   -------------------------------------------------------------- */
	.art-ambient-confirm,
	.art-illumination-confirm {
		padding: 0.5rem 0.75rem;
		border-left: 2px solid var(--color-candle-400);
		background: linear-gradient(to right, rgba(232, 160, 36, 0.08), transparent 80%);
		font-size: 0.95rem;
	}

	.art-dim::after {
		content: '';
		position: absolute;
		inset: 0;
		background: rgba(12, 10, 24, 0.5);
	}
	.art-brew {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		background:
			radial-gradient(circle at 30% 30%, rgba(240, 80, 128, 0.14), transparent 55%),
			radial-gradient(circle at 70% 70%, rgba(92, 224, 181, 0.1), transparent 55%),
			linear-gradient(135deg, var(--color-velvet-700), var(--color-ink-900));
	}

	/* --------------------------------------------------------------
	   Mode dots + variant controls strip
	   -------------------------------------------------------------- */
	.wardrobe-strip {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		margin-top: 0.35rem;
		flex-wrap: wrap;
	}
	.mode-dots {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		list-style: none;
		padding: 0;
		margin: 0;
	}
	.mode-dots-add {
		display: inline-flex;
		align-items: center;
		margin-left: 0.3rem;
		padding-left: 0.5rem;
		border-left: 1px solid rgba(159, 140, 210, 0.18);
	}
	.mode-dot {
		display: inline-block;
		width: 28px;
		height: 28px;
		padding: 0;
		background: transparent;
		border: none;
		cursor: pointer;
		position: relative;
	}
	.mode-dot::before {
		content: '';
		position: absolute;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		width: 9px;
		height: 9px;
		border: 1px solid var(--color-mist-600);
		border-radius: 50%;
		background: transparent;
		transition: background 140ms ease, border-color 140ms ease,
			transform 140ms ease, box-shadow 180ms ease;
	}
	.mode-dot:hover::before {
		border-color: var(--color-candle-300);
		transform: translate(-50%, -50%) scale(1.15);
	}
	.mode-dot-filled::before {
		background: var(--color-mist-400);
		border-color: var(--color-mist-400);
	}
	.mode-dot-active::before {
		background: var(--color-candle-300);
		border-color: var(--color-candle-300);
		box-shadow: 0 0 10px rgba(249, 213, 122, 0.7);
	}
	.mode-dot:focus-visible::before {
		box-shadow: 0 0 0 3px rgba(240, 80, 128, 0.35);
	}
	.mode-dot-add {
		font-family: var(--font-display);
		font-size: 1.1rem;
		line-height: 1;
		color: var(--color-mist-400);
		background: transparent;
		border: 1px dashed rgba(159, 140, 210, 0.4);
		border-radius: 3px;
		width: 22px;
		height: 22px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		transition: color 140ms ease, border-color 140ms ease;
	}
	.mode-dot-add:hover {
		color: var(--color-candle-300);
		border-color: var(--color-candle-300);
	}

	.variant-controls-wrap {
		display: inline-flex;
	}

	.variant-byline {
		color: var(--color-mist-400);
		font-size: 1rem;
		line-height: 1.25;
		margin-top: 0.15rem;
	}

	/* --------------------------------------------------------------
	   Picker overlay — sits where the banner/hero would be
	   -------------------------------------------------------------- */
	.wardrobe-overlay {
		margin-bottom: 0.6rem;
	}

	/* --------------------------------------------------------------
	   Feedback panel
	   -------------------------------------------------------------- */
	.feedback-panel {
		margin-top: 0.75rem;
		padding: 0.85rem 1rem;
		background: linear-gradient(145deg, rgba(31, 26, 56, 0.78), rgba(20, 17, 40, 0.92));
		border: 1px solid rgba(232, 160, 36, 0.25);
		border-radius: var(--radius-button);
		box-shadow: 0 0 0 1px rgba(12, 10, 24, 0.4) inset;
	}
	.feedback-panel > label {
		display: block;
		font-size: 1.15rem;
		margin-bottom: 0.35rem;
	}
	.feedback-input {
		width: 100%;
		resize: vertical;
	}
	.feedback-panel-actions {
		display: flex;
		justify-content: flex-end;
		align-items: center;
		gap: 0.6rem;
		margin-top: 0.5rem;
	}
	.feedback-cancel {
		background: transparent;
		border: none;
		color: var(--color-mist-600);
		cursor: pointer;
		font-family: var(--font-serif);
		text-decoration: underline;
		text-decoration-color: rgba(138, 127, 172, 0.3);
	}
	.feedback-cancel:hover {
		color: var(--color-rose-400);
	}
	.feedback-submit {
		padding: 0.45rem 1rem;
		font-size: 1rem;
		min-height: 2.25rem;
	}

	/* --------------------------------------------------------------
	   Toast
	   -------------------------------------------------------------- */
	.art-toast {
		position: absolute;
		top: 0.1rem;
		right: 3.2rem;
		z-index: 4;
		padding: 0.3rem 0.7rem;
		background: rgba(12, 10, 24, 0.95);
		border: 1px solid rgba(232, 160, 36, 0.4);
		color: var(--color-candle-200);
		border-radius: 3px;
		font-size: 1rem;
		box-shadow: 0 4px 18px rgba(0, 0, 0, 0.6);
		animation: toast-in 180ms ease-out;
	}
	.art-toast-err {
		border-color: var(--color-rose-500);
		color: var(--color-rose-300);
	}
	@keyframes toast-in {
		from {
			opacity: 0;
			transform: translateY(-4px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	/* --------------------------------------------------------------
	   Roll-again row — byline + the prominent recycle action.
	   -------------------------------------------------------------- */
	.variant-byline-row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.75rem;
		margin-top: 0.25rem;
	}
	.roll-again {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.35rem 0.8rem;
		background: rgba(232, 160, 36, 0.1);
		border: 1px solid rgba(232, 160, 36, 0.35);
		color: var(--color-candle-300);
		border-radius: 3px;
		font-size: 1rem;
		cursor: pointer;
		transition: background 140ms ease, border-color 140ms ease;
		min-height: 36px;
	}
	.roll-again:hover:not(:disabled) {
		background: rgba(232, 160, 36, 0.18);
		border-color: var(--color-candle-300);
	}
	.roll-again:disabled {
		opacity: 0.55;
		cursor: wait;
	}
	@media (pointer: coarse) {
		.roll-again {
			min-height: 44px;
			padding: 0.5rem 1rem;
		}
	}

	/* --------------------------------------------------------------
	   Narrow-viewport adjustments
	   -------------------------------------------------------------- */
	@media (max-width: 420px) {
		.wardrobe-eye {
			width: 40px;
			height: 40px;
		}
		.art-tarot-popover {
			width: 200px;
		}
	}
</style>
