import type { Handle, HandleServerError } from "@sveltejs/kit";
import { sequence } from "@sveltejs/kit/hooks";
import { handleErrorWithSentry, sentryHandle } from "@sentry/sveltekit";
import * as Sentry from "@sentry/sveltekit";

const SENTRY_DSN = process.env.PUBLIC_SENTRY_DSN ?? "";

Sentry.init({
	dsn: SENTRY_DSN,
	enabled: !!SENTRY_DSN,
	tracesSampleRate: 0,
	environment: process.env.NODE_ENV ?? "production"
});

const sessionHandle: Handle = async ({ event, resolve }) => {
	const token = event.cookies.get("weaver_session");
	if (token) event.locals.session_token = token;
	return resolve(event);
};

export const handle: Handle = sequence(sentryHandle(), sessionHandle);

const localErrorLogger: HandleServerError = ({ error, event, status, message }) => {
	const e = error as Error & { data?: unknown };
	const stack = e?.stack ?? "";
	const url = event.url.pathname + event.url.search;
	console.error(`[weaver] ${event.request.method} ${url} → ${status}: ${message}`);
	if (stack) console.error(stack);
	if (e?.data) console.error("data:", JSON.stringify(e.data));
	return { message: e?.message ?? message };
};

export const handleError = handleErrorWithSentry(localErrorLogger);
