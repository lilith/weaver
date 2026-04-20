// Thin factory for server-side Convex reads/writes.
// Client-side reactive queries will land when we actually need them;
// Wave 0 does all reads via SvelteKit load functions (SSR).

import { ConvexHttpClient } from "convex/browser";
import { PUBLIC_CONVEX_URL } from "$env/static/public";

export function convexServer(): ConvexHttpClient {
  return new ConvexHttpClient(PUBLIC_CONVEX_URL);
}
