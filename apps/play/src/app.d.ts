// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			/** Session cookie value hydrated by hooks.server.ts from the
			 * `weaver_session` cookie. Present when the user is signed in. */
			session_token?: string;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
