// Display-side metadata for the art-curation mode catalog.
//
// The engine's MODE_PROMPTS owns the FLUX side; this file owns the
// human-readable side (labels, one-line teasers, layout hints). Keep
// the mode-keys in lockstep with `packages/engine/src/art/prompts.ts`
// — the WAVE_2_MODES list returned by the backend is the source of
// truth for which modes the UI offers at any given time.

export type ModeLayout =
	| "banner" // 21:9 strip above title
	| "portrait" // 72px circular badge beside byline
	| "tarot" // 3:5 card in popover
	| "drop_cap" // illuminated initial on .story-prose
	| "ambient" // palette tint; no figurative layer
	| "hero_full"; // legacy 16:9 above title (opt-in v2)

export type ModeMeta = {
	key: string;
	label: string;
	tagline: string;
	layout: ModeLayout;
	/** Whether variants ever fill a blob (ambient_palette does not). */
	uses_blob: boolean;
};

export const MODE_META: Record<string, ModeMeta> = {
	ambient_palette: {
		key: "ambient_palette",
		label: "ambient",
		tagline: "a palette. no picture.",
		layout: "ambient",
		uses_blob: false
	},
	banner: {
		key: "banner",
		label: "banner",
		tagline: "a strip of atmosphere above the title.",
		layout: "banner",
		uses_blob: true
	},
	portrait_badge: {
		key: "portrait_badge",
		label: "portrait",
		tagline: "a face, shoulders-up, beside the name.",
		layout: "portrait",
		uses_blob: true
	},
	tarot_card: {
		key: "tarot_card",
		label: "tarot",
		tagline: "a single-card vignette, pulled aside.",
		layout: "tarot",
		uses_blob: true
	},
	illumination: {
		key: "illumination",
		label: "illumination",
		tagline: "an illuminated drop-cap, margin vines.",
		layout: "drop_cap",
		uses_blob: true
	},
	hero_full: {
		key: "hero_full",
		label: "hero",
		tagline: "a full establishing shot up top.",
		layout: "hero_full",
		uses_blob: true
	}
};

export function modeMeta(key: string): ModeMeta {
	return (
		MODE_META[key] ?? {
			key,
			label: key,
			tagline: "",
			layout: "banner",
			uses_blob: true
		}
	);
}
