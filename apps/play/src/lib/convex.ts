// Thin factory for server-side Convex reads/writes.
// Client-side reactive queries will land when we actually need them;
// Wave 0 does all reads via SvelteKit load functions (SSR).

import { ConvexHttpClient } from "convex/browser";
import { PUBLIC_CONVEX_URL } from "$env/static/public";

/** Convex HTTP client with a small retry wrapper on native-fetch
 *  flakes. Node 24's undici occasionally throws `TypeError: fetch
 *  failed` on parallel SSR loads; the convex client doesn't retry,
 *  so we do. One retry with 100ms backoff clears the common case. */
export function convexServer(): ConvexHttpClient {
	const base = new ConvexHttpClient(PUBLIC_CONVEX_URL);
	return wrapWithRetry(base);
}

function wrapWithRetry(client: ConvexHttpClient): ConvexHttpClient {
	const origQuery = client.query.bind(client);
	const origMutation = client.mutation.bind(client);
	const origAction = client.action.bind(client);
	const shouldRetry = (e: unknown) => {
		const msg = String((e as Error | undefined)?.message ?? "");
		return msg.includes("fetch failed") || msg.includes("ECONNRESET");
	};
	const retry = async <T>(fn: () => Promise<T>): Promise<T> => {
		// Up to 3 attempts total, 150ms / 400ms backoff. Enough to ride
		// out undici socket-pool flutter under parallel SSR load without
		// masking real server errors.
		const backoffs = [150, 400];
		let lastErr: unknown;
		for (let i = 0; i <= backoffs.length; i++) {
			try {
				return await fn();
			} catch (e) {
				lastErr = e;
				if (i === backoffs.length || !shouldRetry(e)) throw e;
				// eslint-disable-next-line no-console
				console.warn(`[convex retry #${i + 1}] ${(e as Error).message}`);
				await new Promise((r) => setTimeout(r, backoffs[i]));
			}
		}
		throw lastErr;
	};
	(client as unknown as { query: typeof client.query }).query = ((...args: unknown[]) =>
		retry(() => (origQuery as (...a: unknown[]) => Promise<unknown>)(...args))) as typeof client.query;
	(client as unknown as { mutation: typeof client.mutation }).mutation = ((...args: unknown[]) =>
		retry(() => (origMutation as (...a: unknown[]) => Promise<unknown>)(...args))) as typeof client.mutation;
	(client as unknown as { action: typeof client.action }).action = ((...args: unknown[]) =>
		retry(() => (origAction as (...a: unknown[]) => Promise<unknown>)(...args))) as typeof client.action;
	return client;
}
