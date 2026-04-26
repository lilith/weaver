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
import type * as atlas_ai from "../atlas_ai.js";
import type * as atlases from "../atlases.js";
import type * as auth from "../auth.js";
import type * as blobs from "../blobs.js";
import type * as characters from "../characters.js";
import type * as classify from "../classify.js";
import type * as cli from "../cli.js";
import type * as code_proposals from "../code_proposals.js";
import type * as cost from "../cost.js";
import type * as crons from "../crons.js";
import type * as diagnostics from "../diagnostics.js";
import type * as effects from "../effects.js";
import type * as entity_edit from "../entity_edit.js";
import type * as eras from "../eras.js";
import type * as event_summaries from "../event_summaries.js";
import type * as events from "../events.js";
import type * as expansion from "../expansion.js";
import type * as flags from "../flags.js";
import type * as flows from "../flows.js";
import type * as graph from "../graph.js";
import type * as import_ from "../import.js";
import type * as journeys from "../journeys.js";
import type * as locations from "../locations.js";
import type * as map from "../map.js";
import type * as mentorship from "../mentorship.js";
import type * as module_proposals from "../module_proposals.js";
import type * as modules_combat from "../modules/combat.js";
import type * as modules_counter from "../modules/counter.js";
import type * as modules_dialogue from "../modules/dialogue.js";
import type * as narrative from "../narrative.js";
import type * as npc_memory from "../npc_memory.js";
import type * as seed from "../seed.js";
import type * as sessions from "../sessions.js";
import type * as stats from "../stats.js";
import type * as themes from "../themes.js";
import type * as tile_library from "../tile_library.js";
import type * as tile_picker from "../tile_picker.js";
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
  atlas_ai: typeof atlas_ai;
  atlases: typeof atlases;
  auth: typeof auth;
  blobs: typeof blobs;
  characters: typeof characters;
  classify: typeof classify;
  cli: typeof cli;
  code_proposals: typeof code_proposals;
  cost: typeof cost;
  crons: typeof crons;
  diagnostics: typeof diagnostics;
  effects: typeof effects;
  entity_edit: typeof entity_edit;
  eras: typeof eras;
  event_summaries: typeof event_summaries;
  events: typeof events;
  expansion: typeof expansion;
  flags: typeof flags;
  flows: typeof flows;
  graph: typeof graph;
  import: typeof import_;
  journeys: typeof journeys;
  locations: typeof locations;
  map: typeof map;
  mentorship: typeof mentorship;
  module_proposals: typeof module_proposals;
  "modules/combat": typeof modules_combat;
  "modules/counter": typeof modules_counter;
  "modules/dialogue": typeof modules_dialogue;
  narrative: typeof narrative;
  npc_memory: typeof npc_memory;
  seed: typeof seed;
  sessions: typeof sessions;
  stats: typeof stats;
  themes: typeof themes;
  tile_library: typeof tile_library;
  tile_picker: typeof tile_picker;
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
