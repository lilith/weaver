#!/usr/bin/env node
// scripts/test-loop.mjs — the "test locally before deploy" gate.
//
// Runs the full local verification in one command. Non-interactive;
// structured output so an agent can parse pass/fail without asking the
// user. Suitable for pre-push hooks and /loop cadences.
//
// Stages:
//   1. unit tests (vitest, pure logic, no network)
//   2. convex-test integration tests (in-memory Convex, no network)
//   3. svelte-check (needs convex codegen to have run)
//
// Deliberately does NOT include:
//   - npx convex codegen — that hits the single-tier dev deployment.
//     Run it explicitly via `pnpm run push-convex` when you want to
//     sync types + push schema.
//   - Playwright e2e — also hits the dev deployment. Run via
//     `pnpm -C apps/play exec playwright test` when you're ready.
//
// Exit code: 0 if every stage green, 1 on first failure. Continue-on-
// error mode is `--all` (runs every stage and reports at the end).
//
// Usage:
//   node scripts/test-loop.mjs          # stop-on-first-failure
//   node scripts/test-loop.mjs --all    # run everything, report last

import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const ALL_MODE = process.argv.includes("--all");

const STAGES = [
	{
		name: "unit",
		cmd: "pnpm",
		args: ["run", "test:unit"],
		why: "pure-logic tests — no Convex, no network",
	},
	{
		name: "convex-test",
		cmd: "pnpm",
		args: ["run", "test:convex"],
		why: "in-memory Convex — owner gate, optimistic concurrency, isolation",
	},
	{
		name: "svelte-check",
		cmd: "pnpm",
		args: ["-C", "apps/play", "check"],
		why: "Svelte + TS type-check of the admin surfaces",
	},
];

function run(stage) {
	const t0 = performance.now();
	const res = spawnSync(stage.cmd, stage.args, {
		stdio: ["ignore", "pipe", "pipe"],
		env: process.env,
	});
	const ms = Math.round(performance.now() - t0);
	const stdout = res.stdout?.toString() ?? "";
	const stderr = res.stderr?.toString() ?? "";
	const ok = res.status === 0;
	return { ok, ms, stdout, stderr, exit: res.status ?? 1 };
}

function printResult(stage, r) {
	const tag = r.ok ? "✓" : "✗";
	console.log(
		`${tag} ${stage.name.padEnd(14)} ${String(r.ms).padStart(5)}ms  — ${stage.why}`,
	);
	if (!r.ok) {
		// Show the tail of output so the agent has something to chew on.
		const out = (r.stdout + r.stderr).trim().split("\n").slice(-40).join("\n");
		console.log("----\n" + out + "\n----");
	}
}

const t0 = performance.now();
const results = [];
for (const stage of STAGES) {
	const r = run(stage);
	printResult(stage, r);
	results.push({ stage, r });
	if (!r.ok && !ALL_MODE) break;
}
const totalMs = Math.round(performance.now() - t0);
const failed = results.filter((x) => !x.r.ok);
console.log(
	`\n${failed.length === 0 ? "✓ all green" : `✗ ${failed.length} stage${failed.length === 1 ? "" : "s"} failed`} in ${totalMs}ms`,
);
process.exit(failed.length === 0 ? 0 : 1);
