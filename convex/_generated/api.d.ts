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
import type * as art_curation from "../art_curation.js";
import type * as auth from "../auth.js";
import type * as blobs from "../blobs.js";
import type * as characters from "../characters.js";
import type * as classify from "../classify.js";
import type * as cli from "../cli.js";
import type * as cost from "../cost.js";
import type * as crons from "../crons.js";
import type * as diagnostics from "../diagnostics.js";
import type * as effects from "../effects.js";
import type * as entity_edit from "../entity_edit.js";
import type * as eras from "../eras.js";
import type * as expansion from "../expansion.js";
import type * as flags from "../flags.js";
import type * as flows from "../flows.js";
import type * as import_ from "../import.js";
import type * as journeys from "../journeys.js";
import type * as locations from "../locations.js";
import type * as map from "../map.js";
import type * as mentorship from "../mentorship.js";
import type * as modules_combat from "../modules/combat.js";
import type * as modules_counter from "../modules/counter.js";
import type * as modules_dialogue from "../modules/dialogue.js";
import type * as narrative from "../narrative.js";
import type * as npc_memory from "../npc_memory.js";
import type * as seed from "../seed.js";
import type * as sessions from "../sessions.js";
import type * as themes from "../themes.js";
import type * as worlds from "../worlds.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  _dev: typeof _dev;
  art: typeof art;
  art_curation: typeof art_curation;
  auth: typeof auth;
  blobs: typeof blobs;
  characters: typeof characters;
  classify: typeof classify;
  cli: typeof cli;
  cost: typeof cost;
  crons: typeof crons;
  diagnostics: typeof diagnostics;
  effects: typeof effects;
  entity_edit: typeof entity_edit;
  eras: typeof eras;
  expansion: typeof expansion;
  flags: typeof flags;
  flows: typeof flows;
  import: typeof import_;
  journeys: typeof journeys;
  locations: typeof locations;
  map: typeof map;
  mentorship: typeof mentorship;
  "modules/combat": typeof modules_combat;
  "modules/counter": typeof modules_counter;
  "modules/dialogue": typeof modules_dialogue;
  narrative: typeof narrative;
  npc_memory: typeof npc_memory;
  seed: typeof seed;
  sessions: typeof sessions;
  themes: typeof themes;
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
