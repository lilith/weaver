import { handleErrorWithSentry } from "@sentry/sveltekit";
import * as Sentry from "@sentry/sveltekit";
import { PUBLIC_SENTRY_DSN } from "$env/static/public";

Sentry.init({
	dsn: PUBLIC_SENTRY_DSN,
	enabled: !!PUBLIC_SENTRY_DSN,
	tracesSampleRate: 0,
	environment: import.meta.env.MODE
});

export const handleError = handleErrorWithSentry();
