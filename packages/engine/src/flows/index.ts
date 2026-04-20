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
};

/** A step is terminal if it's `{terminal: true}` OR the module lacks a
 *  handler for this step id. Either way, the runtime marks the flow
 *  completed and stops. */
export function isTerminal(
  step: StepHandler | TerminalStep | undefined,
): step is TerminalStep | undefined {
  return !step || (step as TerminalStep).terminal === true;
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
