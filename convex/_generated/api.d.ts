/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as _dev from "../_dev.js";
import type * as art from "../art.js";
import type * as auth from "../auth.js";
import type * as blobs from "../blobs.js";
import type * as characters from "../characters.js";
import type * as cli from "../cli.js";
import type * as effects from "../effects.js";
import type * as expansion from "../expansion.js";
import type * as flags from "../flags.js";
import type * as import_ from "../import.js";
import type * as journeys from "../journeys.js";
import type * as locations from "../locations.js";
import type * as narrative from "../narrative.js";
import type * as seed from "../seed.js";
import type * as sessions from "../sessions.js";
import type * as worlds from "../worlds.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  _dev: typeof _dev;
  art: typeof art;
  auth: typeof auth;
  blobs: typeof blobs;
  characters: typeof characters;
  cli: typeof cli;
  effects: typeof effects;
  expansion: typeof expansion;
  flags: typeof flags;
  import: typeof import_;
  journeys: typeof journeys;
  locations: typeof locations;
  narrative: typeof narrative;
  seed: typeof seed;
  sessions: typeof sessions;
  worlds: typeof worlds;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
