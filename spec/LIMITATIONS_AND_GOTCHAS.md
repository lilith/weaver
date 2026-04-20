# Weaver — Limitations and Gotchas

*Engineering reality checks captured while building. Each entry: what
the unknown was, what burned time, how it was resolved, what file
embodies the resolution. Ordered roughly by cost-of-rediscovery. The
next agent should scan this end-to-end before making the same mistakes.*

---

## Convex runtime

### 1. `v.bytes()` accepts `ArrayBuffer`, not `Uint8Array`

**Burned:** first blob write crashed Convex on insert with "… is not a
supported Convex type." Spent ~15 min staring at the stack trace
before realizing Uint8Array ≠ ArrayBuffer in Convex's serializer.

**Fix:** slice into an ArrayBuffer at the boundary:
```ts
const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
await ctx.db.insert("blobs", { inline_bytes: buf, ... });
```
Readers get ArrayBuffer back — wrap in `new Uint8Array(arrBuf)` at
the boundary again. `convex/blobs.ts` has the canonical pattern.

### 2. Top-level `await` is not supported in Convex modules

**Burned:** "Top-level awaits in source files are unsupported" on
deploy. Happened when I tried `export const fn = (await
import(…)).something` as a lazy-resolver trick.

**Fix:** static import at the top of the file. Convex's bundler is
strict. `convex/expansion.ts` had to be reverted from dynamic import
to `import { internalMutation, internalQuery } from "./_generated/server.js"`.

### 3. Mutations can't do network I/O, only actions can

**Burned:** trying to call fal.ai / S3 from inside a mutation,
silently failed. Actions are the only place for network. Mutations
are transactional DB-only.

**Fix pattern:** `mutation → ctx.scheduler.runAfter(0, internalAction,
args) → action does network → action calls internalMutation to write
result`. See `convex/art.ts`'s `generateForEntity` → `storeArtResult`.

### 4. Inline-blob cap is operator-chosen; Convex can hold 1MB per field

**Burned:** spec 12 suggested 4KB inline cap; real location payloads
(options + canonical_features + prose) land 5–10KB and first real
import crashed on the 4983-byte bible. Bumped to 64KB and everything
fit.

**Fix:** `packages/engine/src/blobs/index.ts` has
`BLOB_INLINE_MAX_BYTES = 65536`. Large payloads (images) still go to
R2.

### 5. Query `ctx.db` has no `.patch` — only mutations do

**Burned:** 500 on `/worlds` after deploy. `resolveSession` was
patching `last_used_at` on every call, but a query ctx is read-only.
The cryptic "s.db.patch is not a function" error sent me down a long
debugging path.

**Fix:** session resolver is pure-read. `last_used_at` touch was
removed entirely for now; reintroduce via a mutation-only helper if
it ever matters. `convex/sessions.ts`.

### 6. Convex `session_token` arg ≠ Convex `ctx.auth.userId`

Magic-link auth is home-rolled with a `session_token` argument passed
per call. `ctx.auth.getUserIdentity()` is unused because we don't
have Convex-auth-configured yet. This satisfies the *spirit* of
`ISOLATION_AND_SECURITY.md` rule 4 (server-resolved identity, never
client-claimed `user_id`) but not the *letter*.

**Lint gate (apply at PR-review):** grep for `user_id:
v.id("users")` inside mutation `args`. Hits are a PR-blocker unless
the mutation is explicitly internal / background. Tracked in
`CLAUDE.md` known bugs.

### 7. `--history N` logs + `logs` stream: use `npx convex logs
--history 20 > /tmp/log.txt` in background, kill after a beat.

Streaming logs don't exit on their own; foreground runs hang the
shell. `kill %1` after ~6 seconds works.

---

## Convex schema migration

### 8. Schema validation blocks deploy on row-mismatch — use
`{ schemaValidation: false }` as an escape hatch only, then re-enable

**Burned:** adding required fields (e.g. `components.blob_hash`) broke
deploy with existing rows missing the field. Tried making fields
optional first but cascading requiredness forced a wipe.

**Fix:** for Wave-0 test data, deploy with `schemaValidation: false`,
run wipe-via-internal-mutation, re-deploy with strict schema.
Pattern in `convex/_dev.ts` `wipeWorldData`. For real data, use
`convex import` or a migration mutation.

---

## SvelteKit 2 / Svelte 5

### 9. Form `actions` do not get `parent()` — only `load` does

**Burned:** "parent is not a function" 500 on every `?/pick`.
Actions are top-level handlers, they can't inherit parent load data.

**Fix:** re-query inside the action. Each action re-resolves what it
needs (world, character) via `convexServer()` calls. Slightly more
traffic, correct isolation. `play/[world_slug]/[loc_slug]/+page.server.ts`.

### 10. `throw redirect(303, …)` inside try/catch gets swallowed

**Burned:** save-to-map action returned 500s instead of redirecting.
SvelteKit's `redirect()` throws a special object; a generic `catch`
ate it.

**Fix:** restructure so `redirect()` runs *outside* the try, or
`import { isRedirect } from "@sveltejs/kit"` and re-throw before
falling into fail(). See `save_cluster` action in
`play/[world_slug]/[loc_slug]/+page.server.ts`.

### 11. `<svelte:head>` cannot be inside `{#if}`

**Burned:** build error `<svelte:head> tags cannot be inside elements
or blocks`. Wanted to conditionally inject biome-palette CSS.

**Fix:** move the `{#if}` *inside* `<svelte:head>` (you can gate the
children, not the tag itself).

### 12. `<form>` cannot nest inside another `<form>`

**Burned:** journal page crashed on Svelte compile. Wanted an outer
save-cluster form with an inner dismiss form.

**Fix:** two sibling forms in a flex `<div>`. Each has its own
action. Trivial once you remember HTML's form-nesting rule.

### 13. `$env/static/public` requires every imported key declared at
build time

**Burned:** `PUBLIC_SENTRY_DSN is not exported by "\0virtual:env/static/
public"` on Cloudflare Pages build. Key was set locally but missing
on Pages.

**Fix:** use `import.meta.env.PUBLIC_X` for *optional* public vars —
Vite inlines them at build, undefined if missing, no error. Reserve
`$env/static/public` for *required* vars whose presence is
guaranteed across all environments.

### 14. SvelteKit `Write` tool (Claude Code): must `Read` before `Write`
over an existing file

**Burned:** after `sv create`, tried to `Write` replacement
`+page.svelte` and `+layout.svelte`. Tool silently no-op'd (no-error
path). Deploy served stock `sv create` output for a full redeploy
cycle before I noticed.

**Fix:** any pre-existing file — Read first, then Write. Edit
prefers match-and-replace which won't silently no-op.

---

## Cloudflare Pages runtime (Workers)

### 15. `pnpm dev` uses Vite's Node runtime; **Pages uses Workers**

**Burned:** `@sentry/sveltekit` server side imports Node builtins.
`pnpm dev` worked, local Playwright passed, Pages deploy threw
**`1101 Worker threw exception`** on every route. Cost one
commit-revert-commit cycle.

**Fix:** strip server-side Sentry; keep client-side only. For
future Node-adjacent server code: test locally with `wrangler pages
dev apps/play/.svelte-kit/cloudflare` — that's the *actual* runtime.
Add as a pre-push gate. Strong recommendation in
`CLAUDE.md`'s Investigation notes.

### 16. Set `NODE_VERSION=22` and `PNPM_VERSION=10` as Pages env vars

Pages' default build image picks older Node / pnpm. Vite 8 requires
22.12+. Without this the build fails opaquely.

---

## fal.ai / Anthropic

### 17. fal.ai key format: `<uuid>:<secret>` now, not just `<uuid>`

**Burned:** first FLUX call returned `Unauthorized`. Key looked
valid (36-char UUID). New fal.ai format is `<id>:<secret>`; dashboard
may show just the ID without the secret unless you copy "token" view.

**Fix:** regenerate, use the colon-separated string. Convex env
`FAL_KEY` needs the full thing.

### 18. Anthropic `temperature` is deprecated on some models

**Burned:** biome-theme generation script set `temperature: 0.8`.
Opus 4.7 rejected: "`temperature` is deprecated for this model."

**Fix:** omit `temperature` — models now pick appropriate default.
`scripts/gen-biome-themes.mjs` has the successful pattern.

### 19. Opus occasionally hallucinates invalid hex (Bengali digits!)

**Burned:** biome palette generator produced `#3a২a6e` (`২` = Bengali
2). JSON parsed, but browser rendering broke.

**Fix:** post-parse validation: strict `/^#[0-9a-fA-F]{6}$/` check.
Failed palettes → retry once. For Wave-0 I patched the single bad
value manually; production code needs the retry path.

---

## Packaging + ESM

### 20. `@noble/hashes` uses strict `exports` map — include `.js`
suffix in import paths

**Burned:** Convex esbuild "Could not resolve
`@noble/hashes/blake3`." Package's `exports` field only lists
`./blake3.js`, not `./blake3`.

**Fix:** `import { blake3 } from "@noble/hashes/blake3.js";` (with
suffix). `packages/engine/src/blobs/index.ts`.

### 21. `convex/_generated/api.js` is ESM but root `package.json` may
not be `"type": "module"`

**Burned:** Playwright test runner (bare Node ESM) couldn't import
the generated API. Error: "cannot import CommonJS module as named
export."

**Fix:** add `convex/package.json` with `{ "type": "module" }` as a
scoped override. SvelteKit's Vite handles either way — only raw-Node
consumers (tests, scripts) need this.

---

## Env var plumbing (two-location pattern)

### 22. Secrets live in TWO places, keep them in sync

- **Local `.env`** — for scripts the agent runs directly (Node CLI
  like `scripts/import-world.mjs`, `gen-biome-themes.mjs`, the
  Playwright harness).
- **Convex deployment env** — read by Convex functions at runtime.
  Set via `npx convex env set KEY VAL`.

`.env.example` publishes *safe-public* values (R2 account ID, bucket
endpoints, public URLs, sender email, domain). Real secrets stay in
`.env` (gitignored). When you add a new secret, set it both places.

### 23. SvelteKit looks for `.env` in the *SvelteKit project root*,
not the monorepo root

`apps/play/.env` is the SvelteKit-visible file. Root `/home/lilith/
fun/weaver/.env` is for operator scripts. `PUBLIC_CONVEX_URL` needs
to be in `apps/play/.env` for the client.

### 24. `.env.local` (Convex-auto-written) is gitignored; `.env` is too

Both are gitignored by default. Convex dev writes deployment URLs
to `.env.local` for you — never overwrite it manually. Add
project-wide vars to `.env`.

---

## E2E test harness

### 25. Playwright needs `webServer` to start dev; can reuse existing

`apps/play/playwright.config.ts` spawns `pnpm dev` and waits on
`:5173`. `reuseExistingServer: true` in non-CI saves 5s per run.

### 26. Form action tests need the right headers

SvelteKit form actions return HTML by default; for JSON you need
`Accept: application/json` + `x-sveltekit-action: true`. Skipping
either means the harness gets a full HTML page instead of the
`{"type": "redirect" | "success", ...}` payload.

### 27. Isolation tests are cheap — 12 tests in 10s

Every world-scoped mutation should land with a matching isolation
test in the same PR. Pattern in `apps/play/tests/isolation.spec.ts`
— sign in as two throwaway users, try every mutation from the wrong
session. See URGENT rule 7 in `CLAUDE.md`.

---

## Convex CLI

### 28. `npx convex run 'module:fn' 'json'` wants JSON with escaped
quotes — use single-quote outside

```bash
npx convex run 'worlds:listMine' '{"session_token":"..."}'
```
not
```bash
npx convex run "worlds:listMine" "{\"session_token\":\"...\"}"
```

### 29. `_dev.devSignInAs` is your friend for dev + E2E

Creates-or-finds a user, issues a valid session token, no email.
Use in CI, scripts, and one-shot shells:
```bash
TOKEN=$(npx convex run '_dev:devSignInAs' '{"email":"x@y.com"}' \
  | python3 -c "import sys,re; print(re.search(r'\"session_token\":\s*\"([^\"]+)\"', sys.stdin.read()).group(1))")
export WEAVER_SESSION_TOKEN=$TOKEN
```

---

## Scheduler / async pattern for long work

### 30. Long operations (LLM, FLUX, R2 upload) go through
`ctx.scheduler.runAfter(0, internalAction, args)`

**Pattern:** mutation inserts a row with `status: queued` → schedules
an action → action does the work → action calls internalMutation to
write result → page refresh picks it up.

Keeps SSR renders fast. Never block on a long AI call in a user-
facing action — even if it takes 5s and "feels fine", it's a hidden
dependency that can flake.

### 31. `ctx.scheduler.runAfter` inside a mutation runs after the
mutation commits, not before

Good to rely on — you can schedule cleanup / AI work confidently at
any point in the mutation body.

---

## Dev velocity / "should have tried this sooner"

### 32. `wrangler pages dev apps/play/.svelte-kit/cloudflare`

Run this *before every push*. Catches Workers-runtime issues in 5s
locally that would otherwise cost a 45s Pages rebuild + runtime
500 to discover. Listed in `CLAUDE.md` as a Wave-2 pre-push habit.

### 33. Convex logs via background + kill, not streaming foreground

```bash
npx convex logs --history 20 > /tmp/log.txt &
sleep 6
kill %1
tail -40 /tmp/log.txt
```

### 34. Post-refactor DB wipe is safer than pretend-migration

For Wave-0 test data: `_dev.wipeWorldData` with a hardcoded confirm
literal. Don't try to migrate pre-schema-overhaul data for test
users. Fresh state is cheap; painful migrations are not.

### 35. Don't use `git add -A` when a parallel agent is editing other
files (e.g., the spec-review agent on `spec/`)

Stage your own files explicitly by name/directory. `git add -A`
accidentally co-committed the reviewer's in-progress spec changes
and forced a rewrite.

---

## Worth measuring but not yet

- **Cache hit rate on Anthropic** — expected 80%+ for expansion (same
  bible across calls in a 5-min window). Haven't verified with
  usage-page data.
- **R2 cold-start latency vs inline blob read** — inline wins for
  small payloads; R2 wins for images. Actual numbers unknown.
- **Playwright parallel-worker safety** — harness runs
  `workers: 1`. Multi-worker E2E needs a fresh Convex DB per run
  or unique user-email namespacing to avoid collisions.
- **Bundle size** — spec 09 aspired to ≤80KB initial. Current
  build emits 139KB server + ~30KB client-gzipped. Needs a real
  audit.

These are flagged in `spec/FEASIBILITY_REVIEW.md` at appropriate
sections.

---

## When this doc is wrong

Each entry above has a commit hash in git history and a file in the
repo that embodies the fix. If behaviour differs from this doc,
trust the code first, update this doc second. Stale gotchas are
worse than none.
