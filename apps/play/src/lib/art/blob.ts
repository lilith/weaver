// Blob URL helper for the art-curation wardrobe.
//
// R2 public URL + content-hash → full image URL. Mirrors the scheme
// used in `convex/locations.ts` (legacy art_url) and
// `convex/art_curation.ts` (storage write path). Keep in sync if the
// content-addressing layout ever changes.

import { PUBLIC_R2_IMAGES_URL } from "$env/static/public";

export function blobUrl(hash: string | null | undefined): string | null {
	if (!hash || !PUBLIC_R2_IMAGES_URL) return null;
	return `${PUBLIC_R2_IMAGES_URL}/blob/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
}
