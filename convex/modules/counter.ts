// Counter module — the tiniest proof of the step-keyed runtime. Used
// by isolation tests + CLI smoke tests to confirm start/step/state
// persistence works without burning LLM tokens.

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
  steps: {
    counting: (ctx, state, input) => {
      // Initialize on first enter.
      const cur = state.n ?? 0;
      const target = state.target ?? 5;
      if (input?.choice === "stop" || cur >= target) {
        return {
          next: "done",
          says: [`Final count: ${cur} (target ${target}).`],
        };
      }
      const next = cur + 1;
      return {
        next: "counting",
        state: { n: next, target },
        says: [`Count: ${next}/${target}`],
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
