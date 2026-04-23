// Counter module — the tiniest proof of the step-keyed runtime. Used
// by isolation tests + CLI smoke tests to confirm start/step/state
// persistence works without burning LLM tokens. Also the simplest
// module_overrides demo: the "target" ships as a tunable slot so the
// admin-UI → Opus → apply loop has something trivial to exercise.

import type { ModuleDef } from "@weaver/engine/flows";

type CounterState = { n: number; target: number };

export const counterModule: ModuleDef<CounterState> = {
  name: "counter",
  schema_version: 1,
  entry: "counting",
  manifest: {
    reads: ["flow.state"],
    writes: ["flow.state"],
    emits: [],
  },
  overridable: {
    default_target: {
      kind: "number",
      default: 5,
      min: 1,
      max: 1000,
      description:
        "Where counter runs stop if the caller didn't pass `target` in initial_state.",
    },
    tick_label: {
      kind: "template",
      default: "Count: {{n}}/{{target}}",
      placeholders: ["n", "target"],
      description: "Shown on each count tick.",
    },
    final_label: {
      kind: "template",
      default: "Final count: {{n}} (target {{target}}).",
      placeholders: ["n", "target"],
      description: "Shown once when the counter finishes or is stopped.",
    },
  },
  steps: {
    counting: (ctx, state, input) => {
      const cur = state.n ?? 0;
      const target = state.target ?? ctx.tune<number>("default_target");
      if (input?.choice === "stop" || cur >= target) {
        return {
          next: "done",
          says: [ctx.template("final_label", { n: cur, target })],
        };
      }
      const next = cur + 1;
      return {
        next: "counting",
        state: { n: next, target },
        says: [ctx.template("tick_label", { n: next, target })],
        ui: {
          choices: [
            { id: "continue", label: "Continue" },
            { id: "stop", label: "Stop" },
          ],
        },
      };
    },
    done: { terminal: true },
  },
};
