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

// NPC memory decay — weekly compaction of oldest low-salience rows.
// Prevents prompt weight from compounding as a world ages.
crons.weekly(
  "npc-memory-compaction",
  { dayOfWeek: "monday", hourUTC: 7, minuteUTC: 15 },
  internal.npc_memory.gcNpcMemory,
);

// flow_transitions GC — diagnostic trail, 14-day horizon.
crons.weekly(
  "flow-transitions-gc",
  { dayOfWeek: "monday", hourUTC: 7, minuteUTC: 30 },
  internal.flows.gcFlowTransitions,
);

// Blob mark-sweep GC — 30-day horizon. Reclaims orphaned inline
// blobs (JSON payloads from old artifact_versions, stale expansion
// stream results, etc.) + emits an R2 keys manifest for the worker.
crons.weekly(
  "blobs-gc",
  { dayOfWeek: "monday", hourUTC: 7, minuteUTC: 45 },
  internal.blobs.gcBlobs,
);

export default crons;
