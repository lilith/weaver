// Server hooks. Runs in the Cloudflare Pages / Workers runtime so we
// can't use Node-only libraries here — @sentry/sveltekit bundles
// Node shims and breaks at cold-start. Server-side errors are logged
// to console.error and surface in Cloudflare Pages real-time logs.
// Client-side Sentry still fires (see hooks.client.ts) and will catch
// every UI-observed error with stack + breadcrumbs.

import type { Handle, HandleServerError } from "@sveltejs/kit";

export const handle: Handle = async ({ event, resolve }) => {
	const token = event.cookies.get("weaver_session");
	if (token) event.locals.session_token = token;
	return resolve(event);
};

export const handleError: HandleServerError = ({ error, event, status, message }) => {
	const e = error as Error & { data?: unknown };
	const stack = e?.stack ?? "";
	const url = event.url.pathname + event.url.search;
	console.error(`[weaver] ${event.request.method} ${url} → ${status}: ${message}`);
	if (stack) console.error(stack);
	if (e?.data) console.error("data:", JSON.stringify(e.data));
	return { message: e?.message ?? message };
};
