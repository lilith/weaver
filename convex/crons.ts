// Scheduled tasks. Convex wires these up automatically on deploy.
//
// Keep tasks small + idempotent; Convex runs crons with a best-effort
// scheduler, so missed ticks are acceptable and collisions are fine.

import { cronJobs } from "convex/server";
import { internal } from "./_generated/api.js";

const crons = cronJobs();

// GC old runtime_bugs weekly. `info` severity > 7d and `warn`/`error`
// > 30d get deleted; active bugs stay visible. See
// convex/diagnostics.ts gcRuntimeBugs for the policy.
crons.weekly(
  "runtime-bugs-gc",
  { dayOfWeek: "monday", hourUTC: 7, minuteUTC: 0 },
  internal.diagnostics.gcRuntimeBugs,
);

export default crons;
