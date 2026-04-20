import { handleErrorWithSentry } from "@sentry/sveltekit";
import * as Sentry from "@sentry/sveltekit";

// Read via import.meta.env so a missing var compiles cleanly (unlike
// `$env/static/public` which errors at build time if the key isn't
// declared in every environment).
const dsn = (import.meta.env.PUBLIC_SENTRY_DSN as string | undefined) ?? "";

Sentry.init({
	dsn,
	enabled: !!dsn,
	tracesSampleRate: 0,
	environment: import.meta.env.MODE
});

export const handleError = handleErrorWithSentry();
