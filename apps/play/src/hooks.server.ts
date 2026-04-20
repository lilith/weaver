import type { Handle } from "@sveltejs/kit";

export const handle: Handle = async ({ event, resolve }) => {
	const token = event.cookies.get("weaver_session");
	if (token) event.locals.session_token = token;
	return resolve(event);
};
