<script lang="ts">
	// Hand-drawn inline SVG icons for the art wardrobe. Line weight and
	// stroke-cap kept uniform so they sit as a family on the page.
	//
	// Deliberately *not* using a library — each glyph here was drawn to
	// match the midnight-loom line work (ink-line, candle-warm on hover).

	type Name =
		| "eye_closed"
		| "eye_open"
		| "regen"
		| "trash"
		| "heart"
		| "chevron_left"
		| "chevron_right"
		| "pen"
		| "pin"
		| "close"
		| "spark";

	let { name, size = 18, title = undefined as string | undefined } = $props<{
		name: Name;
		size?: number;
		title?: string;
	}>();
</script>

{#if name === 'eye_closed'}
	<svg
		viewBox="0 0 24 24"
		width={size}
		height={size}
		fill="none"
		stroke="currentColor"
		stroke-width="1.5"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden={title ? undefined : true}
		role={title ? 'img' : undefined}
	>
		{#if title}<title>{title}</title>{/if}
		<!-- An eye, closed-ish; a single arc with a lash tick below. -->
		<path d="M3.2 12c2.8 3.4 5.9 5 8.8 5s6-1.6 8.8-5" />
		<path d="M5 14.4l-1.2 1.8" />
		<path d="M19 14.4l1.2 1.8" />
		<path d="M12 17v2" />
	</svg>
{:else if name === 'eye_open'}
	<svg
		viewBox="0 0 24 24"
		width={size}
		height={size}
		fill="none"
		stroke="currentColor"
		stroke-width="1.5"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden={title ? undefined : true}
		role={title ? 'img' : undefined}
	>
		{#if title}<title>{title}</title>{/if}
		<!-- Eye, open; almond shape with a filled pupil. -->
		<path d="M2.5 12c2.7-4.2 5.8-6.3 9.5-6.3s6.8 2.1 9.5 6.3c-2.7 4.2-5.8 6.3-9.5 6.3S5.2 16.2 2.5 12z" />
		<circle cx="12" cy="12" r="2.7" fill="currentColor" stroke="none" />
	</svg>
{:else if name === 'regen'}
	<!-- A three-quarter spiral arrow: not a library glyph. -->
	<svg
		viewBox="0 0 24 24"
		width={size}
		height={size}
		fill="none"
		stroke="currentColor"
		stroke-width="1.6"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden={title ? undefined : true}
		role={title ? 'img' : undefined}
	>
		{#if title}<title>{title}</title>{/if}
		<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
		<path d="M20 4.5v3.5h-3.5" />
	</svg>
{:else if name === 'trash'}
	<!-- An inked trash can — angled lid, two grain lines. -->
	<svg
		viewBox="0 0 24 24"
		width={size}
		height={size}
		fill="none"
		stroke="currentColor"
		stroke-width="1.5"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden={title ? undefined : true}
		role={title ? 'img' : undefined}
	>
		{#if title}<title>{title}</title>{/if}
		<path d="M5 7h14" />
		<path d="M9 7V5.5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5.5V7" />
		<path d="M6.5 7l.9 11.5A1.5 1.5 0 0 0 8.9 20h6.2a1.5 1.5 0 0 0 1.5-1.5L17.5 7" />
		<path d="M10.5 10.5v6" />
		<path d="M13.5 10.5v6" />
	</svg>
{:else if name === 'heart'}
	<!-- Votive heart — slightly asymmetric, hand-drawn feel. -->
	<svg
		viewBox="0 0 24 24"
		width={size}
		height={size}
		fill="none"
		stroke="currentColor"
		stroke-width="1.6"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden={title ? undefined : true}
		role={title ? 'img' : undefined}
	>
		{#if title}<title>{title}</title>{/if}
		<path d="M12 19.4s-6.7-4-8-8.2c-1.1-3.6 1.9-6.6 4.7-5.5 1.4.6 2.5 1.7 3.3 3.1.8-1.4 1.9-2.5 3.3-3.1 2.8-1.1 5.8 1.9 4.7 5.5-1.3 4.2-8 8.2-8 8.2z" />
	</svg>
{:else if name === 'chevron_left'}
	<svg
		viewBox="0 0 24 24"
		width={size}
		height={size}
		fill="none"
		stroke="currentColor"
		stroke-width="1.8"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden={title ? undefined : true}
		role={title ? 'img' : undefined}
	>
		{#if title}<title>{title}</title>{/if}
		<path d="M14.5 5.5L8 12l6.5 6.5" />
	</svg>
{:else if name === 'chevron_right'}
	<svg
		viewBox="0 0 24 24"
		width={size}
		height={size}
		fill="none"
		stroke="currentColor"
		stroke-width="1.8"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden={title ? undefined : true}
		role={title ? 'img' : undefined}
	>
		{#if title}<title>{title}</title>{/if}
		<path d="M9.5 5.5L16 12l-6.5 6.5" />
	</svg>
{:else if name === 'pen'}
	<!-- A quill nib, slanted; the tail is a feather mark. -->
	<svg
		viewBox="0 0 24 24"
		width={size}
		height={size}
		fill="none"
		stroke="currentColor"
		stroke-width="1.5"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden={title ? undefined : true}
		role={title ? 'img' : undefined}
	>
		{#if title}<title>{title}</title>{/if}
		<path d="M4 20l3.2-.9 10-10-2.3-2.3-10 10z" />
		<path d="M14.9 6.8l2.6-2.6a1.2 1.2 0 0 1 1.7 0l1.6 1.6a1.2 1.2 0 0 1 0 1.7l-2.6 2.6" />
		<path d="M5.5 17l1.7 1.7" />
	</svg>
{:else if name === 'pin'}
	<!-- A push-pin / bookmark — for "add to reference board". -->
	<svg
		viewBox="0 0 24 24"
		width={size}
		height={size}
		fill="none"
		stroke="currentColor"
		stroke-width="1.5"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden={title ? undefined : true}
		role={title ? 'img' : undefined}
	>
		{#if title}<title>{title}</title>{/if}
		<path d="M9 3h6l-1 4 3 3-3 3-4-1-2 5-2-2 5-2-1-4 3-3z" />
	</svg>
{:else if name === 'close'}
	<svg
		viewBox="0 0 24 24"
		width={size}
		height={size}
		fill="none"
		stroke="currentColor"
		stroke-width="1.6"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden={title ? undefined : true}
		role={title ? 'img' : undefined}
	>
		{#if title}<title>{title}</title>{/if}
		<path d="M6 6l12 12" />
		<path d="M18 6L6 18" />
	</svg>
{:else if name === 'spark'}
	<!-- Four-point spark / north star — matches the ✦ glyph used elsewhere. -->
	<svg
		viewBox="0 0 24 24"
		width={size}
		height={size}
		fill="currentColor"
		stroke="none"
		aria-hidden={title ? undefined : true}
		role={title ? 'img' : undefined}
	>
		{#if title}<title>{title}</title>{/if}
		<path d="M12 2l1.6 7.1L21 12l-7.4 2.9L12 22l-1.6-7.1L3 12l7.4-2.9z" />
	</svg>
{/if}
