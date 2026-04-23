// Flow runtime — step-keyed state machines (URGENT rule 3).
//
// The only authored-code surface above JSON options. A module is a
// named bag of step handlers; the runtime stores (module_name,
// current_step_id, state_json) per flow row and re-invokes the
// handler on step. NO generator replay, NO closure capture.
//
// Actions (Sonnet calls, ambient hooks, etc.) happen inside step
// handlers via the typed ModuleCtx. The runtime collects `says`, `ui`,
// `effects`, persists the new state + next step id, and hands back a
// transcript the caller renders.

/** Declarable override surface. Modules list their tunables here so
 *  (a) Opus can be told what's legally changeable in a proposal, and
 *  (b) runtime rejects `ctx.tune("typo")` at dispatch time instead of
 *  silently falling through to `undefined`.
 *
 *  Four kinds:
 *    - number:   single numeric value, with optional inclusive bounds
 *    - string:   single string value, with optional max length
 *    - template: a `{{placeholder}}` string; declared placeholders let
 *                the runtime interpolate with a typed vars map
 *    - boolean:  single flag
 */
export type OverridableSlot =
  | {
      kind: "number";
      default: number;
      min?: number;
      max?: number;
      description: string;
    }
  | {
      kind: "string";
      default: string;
      max_len?: number;
      description: string;
    }
  | {
      kind: "template";
      default: string;
      placeholders: string[];
      description: string;
    }
  | {
      kind: "boolean";
      default: boolean;
      description: string;
    };

/** Interpolate `{{key}}` markers in a template with values from `vars`.
 *  Flat grammar — no conditionals, no arithmetic — so Opus-proposed
 *  templates can't accidentally break step logic. Unknown placeholders
 *  in `vars` are ignored; missing placeholders render literally as the
 *  `{{key}}` text so the break is visible. */
export function interpolateTemplate(
  tpl: string,
  vars: Record<string, string | number | boolean> = {},
): string {
  return tpl.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (full, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      return String(vars[key]);
    }
    return full;
  });
}

/** Validate an incoming override value against its slot schema. Returns
 *  a reason-string on failure, null on success. Pure / sync so it's
 *  callable from both the apply mutation and the client-side UI check. */
export function validateOverride(
  slot: OverridableSlot,
  value: unknown,
): string | null {
  if (slot.kind === "number") {
    if (typeof value !== "number" || !Number.isFinite(value))
      return "expected a finite number";
    if (slot.min !== undefined && value < slot.min)
      return `below minimum ${slot.min}`;
    if (slot.max !== undefined && value > slot.max)
      return `above maximum ${slot.max}`;
    return null;
  }
  if (slot.kind === "string") {
    if (typeof value !== "string") return "expected a string";
    if (slot.max_len !== undefined && value.length > slot.max_len)
      return `longer than max_len ${slot.max_len}`;
    return null;
  }
  if (slot.kind === "template") {
    if (typeof value !== "string") return "expected a template string";
    // Reject placeholders that weren't declared — Opus drafting
    // `{{hp}}` when only `{{player}}` was declared is a bug we want
    // caught at apply time, not silently rendered as literal text.
    const used = new Set(
      Array.from(value.matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g)).map(
        (m) => m[1],
      ),
    );
    for (const k of used) {
      if (!slot.placeholders.includes(k))
        return `placeholder {{${k}}} not declared (allowed: ${slot.placeholders.join(", ")})`;
    }
    return null;
  }
  if (slot.kind === "boolean") {
    if (typeof value !== "boolean") return "expected a boolean";
    return null;
  }
  return "unknown slot kind";
}

/** Merge per-world overrides over module defaults. Unknown keys are
 *  dropped (logged by the caller if it cares). Type mismatches are
 *  dropped too — validation should've caught them at apply, but this
 *  is a belt-and-braces so a corrupted row can't crash the runtime. */
export function mergeOverrides(
  slots: Record<string, OverridableSlot> | undefined,
  overrides: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!slots) return out;
  for (const [key, slot] of Object.entries(slots)) {
    if (overrides && Object.prototype.hasOwnProperty.call(overrides, key)) {
      if (validateOverride(slot, overrides[key]) === null) {
        out[key] = overrides[key];
        continue;
      }
    }
    out[key] = slot.default;
  }
  return out;
}

/** Per-step output contract. */
export type StepResult<S = any> = {
  /** The step id to transition to. `"done"` or `"__done__"` terminates. */
  next: string;
  /** Replacement state (merged over the previous state). Omit for no change. */
  state?: Partial<S> | S;
  /** Lines to render now, in order. */
  says?: string[];
  /** Pending async Effects (from @weaver/engine/effects) to fire via the
   *  game's central router. Kept as `any[]` here to avoid circular types
   *  with the effects package. */
  effects?: any[];
  /** Present when the step yields waiting on user input. */
  ui?: {
    prompt?: string;
    choices?: Array<{ id: string; label: string }>;
    // Whether free-text input is accepted in addition to choices.
    free_text?: boolean;
  };
};

export type TerminalStep = { terminal: true };

/** Executor context passed to every step handler. */
export interface ModuleCtx {
  /** Seeded per (flow_id, step_id); same seed → same rolls, so AI-cached
   *  prompts don't desync. */
  rng: () => number;
  /** Integer in [lo, hi] inclusive. */
  rng_int: (lo: number, hi: number) => number;
  /** Roll NdK. */
  dice: (n: number, sides: number) => number;
  /** Pick from a list. */
  pick: <T>(items: T[]) => T;
  /** Current world clock turn number. */
  turn: number;
  /** Milliseconds since epoch — stamped at step dispatch time. */
  now: number;
  /** The flow's own state (read-only for the handler; return `state` in
   *  the StepResult to mutate). */
  state: Readonly<Record<string, unknown>>;
  /** The caller's character (id + name + pseudonym + shallow state). */
  character: {
    id: string;
    name: string;
    pseudonym: string;
    state: Record<string, unknown>;
  };
  /** The NPC the flow is dialogue-with (if any). */
  speaker_slug?: string;
  /** Narrative AI — Sonnet via assembleNarrativePrompt. Always in-character. */
  narrate: (prompt: string, extra?: { max_tokens?: number; speaker?: string }) => Promise<string>;
  /** Scribble a narration line immediately (shows on next render). */
  say: (text: string) => void;
  /** Look up a declared tunable. Throws synchronously if the key wasn't
   *  declared in the module's `overridable` schema — typos fail loud.
   *  Runtime merges per-world overrides on top of defaults before step
   *  dispatch, so this read is O(1) in-memory. */
  tune: <T = unknown>(key: string) => T;
  /** Look up a declared template slot and interpolate it with `vars`.
   *  Throws if the key isn't a template slot. Flat `{{placeholder}}`
   *  grammar only — deliberately weaker than the main template engine
   *  so AI-proposed overrides can't escape into step control flow. */
  template: (
    key: string,
    vars?: Record<string, string | number | boolean>,
  ) => string;
}

export type StepHandler<S = any> = (
  ctx: ModuleCtx,
  state: S,
  input?: StepInput,
) => Promise<StepResult<S>> | StepResult<S>;

export type StepInput = {
  choice?: string;
  text?: string;
  [k: string]: unknown;
};

export type ModuleDef<S = any> = {
  name: string;
  schema_version: number;
  /** Step id that `start` enters on. Defaults to `"open"`. */
  entry?: string;
  /** Either a handler or a terminal marker. */
  steps: Record<string, StepHandler<S> | TerminalStep>;
  /** Authoring manifest — reads/writes/emits declared for future cap
   *  enforcement. For Wave 1-3 trusted-TS modules, informational only. */
  manifest?: {
    reads?: string[];
    writes?: string[];
    emits?: string[];
  };
  /** Declared override surface. Step handlers read tunables via
   *  `ctx.tune(key)` and templates via `ctx.template(key, vars)`. The
   *  Convex runtime loads `module_overrides` for (world, module_name),
   *  merges over these defaults, and attaches the resolved map to the
   *  step's ctx. See spec/MODULE_AND_CODE_PROPOSALS.md. */
  overridable?: Record<string, OverridableSlot>;
};

/** A step is terminal if it's `{terminal: true}` OR the module lacks a
 *  handler for this step id. Either way, the runtime marks the flow
 *  completed and stops. */
export function isTerminal(
  step: StepHandler | TerminalStep | undefined,
): step is TerminalStep | undefined {
  return !step || (step as TerminalStep).terminal === true;
}

/** Factory for `ctx.tune` / `ctx.template` given a module's declared
 *  slots + the per-world override map. Loud failure on undeclared keys;
 *  automatic `{{placeholder}}` interpolation for templates. Safe to
 *  call per step — no IO. */
export function makeOverrideAccessors(
  mod: ModuleDef,
  overrides: Record<string, unknown>,
): {
  tune: ModuleCtx["tune"];
  template: ModuleCtx["template"];
} {
  const slots = mod.overridable ?? {};
  const resolved = mergeOverrides(slots, overrides);
  return {
    tune<T = unknown>(key: string): T {
      const slot = slots[key];
      if (!slot) {
        throw new Error(
          `tune("${key}"): module "${mod.name}" has no such overridable slot`,
        );
      }
      return resolved[key] as T;
    },
    template(key, vars = {}) {
      const slot = slots[key];
      if (!slot) {
        throw new Error(
          `template("${key}"): module "${mod.name}" has no such overridable slot`,
        );
      }
      if (slot.kind !== "template") {
        throw new Error(
          `template("${key}"): slot is "${slot.kind}", not "template" (use ctx.tune)`,
        );
      }
      return interpolateTemplate(resolved[key] as string, vars);
    },
  };
}

/** Build a seeded RNG. Deterministic per (seed_string). */
export function makeSeededRng(seed: string): ModuleCtx["rng"] {
  // xmur3 + mulberry32 — tiny, not crypto, fine for game rolls.
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
