# Weaver — Decision Log

One-liner per locked decision, with rationale. Read this when you want to question a choice — the rationale is here, and if you have a better argument, we can revisit.

## Frontend

| Decision | Rationale |
|---|---|
| SvelteKit 5 (runes) over React | Mobile bundle size (~60% smaller for equivalent app), reactive-by-default matches Convex well, runes reduce boilerplate, built-in routing |
| Tailwind 4 over CSS modules | CSS variables for theme swap work perfectly with Tailwind's arbitrary value syntax, tokens are the same abstraction family |
| Vite 8 | Rolldown-based, fast dev server, PWA plugin ecosystem |
| Svelte 5 runes over stores | Runes are the new idiomatic primitive; stores are legacy |
| Motion for animation | Framer Motion's Svelte-friendly successor, lightweight |
| CodeMirror 6 over Monaco for inline script editor | Lightweight, mobile-friendly, embeddable; Monaco is too heavy for mobile |
| Mobile-first layout, desktop earns second pane | Family primary device is phones; desktop is bonus |

## Backend + DB

| Decision | Rationale |
|---|---|
| Convex over Supabase / custom Postgres | Reactive queries match game UX, zero backend boilerplate, FSL license allows self-host escape hatch if needed, built-in scheduled actions |
| Convex components / tables, not ORM | Direct schema is simpler, aligns with Convex's reactive model |
| BLAKE3 for content hashing | 5-10x faster than SHA-256, 256-bit security sufficient |
| Better Auth over Clerk / Auth0 | Self-hostable, direct Convex integration, not SaaS-locked |
| Resend magic links over Google OAuth | Kids don't have Google accounts; email is the universal path |

## LLM routing

| Decision | Rationale |
|---|---|
| Opus 4.7 for generation | Only model that handles 1M context + prompt caching + creativity at needed quality; $5/$25 is acceptable given cache discount |
| Haiku 4.5 for intent classification | 10x cheaper than Opus, plenty accurate for 8-atom classification with few-shot |
| Sonnet 4.6 for NPC chat + narration | Good prose at 1/3 Opus price; not for complex generation |
| Temperature 1.0 on narrative generation | Maximum creative range; world bible hard-constrains facts |
| Temperature 0.0 on classifiers | Determinism for caching |
| World bible prompt caching via `cache_control: ephemeral` | 90% input-cost reduction on cache hits; biggest single cost lever |

## Image generation

| Decision | Rationale |
|---|---|
| FLUX.2 [pro] via fal.ai for new art | Reference-image support (critical for character/style consistency), quality at $0.03/image |
| FLUX Kontext for prompt-based image edits | Reference-preserving edits |
| Nano Banana 2 as cheap-edit alternative | Lower cost for iterative tweaks; not for hero art |
| 1MP square for location art | Looks good on mobile, cheap |
| Biome fallback images pre-generated | Zero-latency first-view rendering while real art generates async |

## Storage

| Decision | Rationale |
|---|---|
| Content-addressed immutable blobs | Dedup, backup, versioning, forking all fall out for free |
| Cloudflare R2 for large blobs | Zero egress, 11-nines durability, cheap at $0.015/GB-month |
| Convex inline for small blobs (< 4KB) | Avoid R2 round-trip on hot path |
| Never GC blobs by default | Storage cheap; family worlds precious; history matters |
| Event log per-branch, flows settle before fork | Clean semantics, avoids cross-branch bugs |

## Runtime

| Decision | Rationale |
|---|---|
| Generator-based event-sourced durable runtime | JS has no Pluto; this is the closest equivalent; replay-deterministic |
| Three execution paths (JSON / inline script / module) | 95% / 4% / 1% of content; runtime dispatches cheapest |
| Inline script ~300 LOC interpreter | Small surface area, authorable by kids, no `eval` |
| Module capability sandbox (Wave 2) | Enforces read/write/publish manifest; untrusted modules safe to run |
| Version-pinned flows + escape handlers | Enables hot deploys without disrupting in-flight encounters |
| Deterministic RNG seeded from `(branch, turn, flow, op)` | Replayable, testable, fork-safe |

## Game design

| Decision | Rationale |
|---|---|
| Free-text expansion is the killer feature | Turns dead-ends into co-authorship; infinite world with bounded testing |
| Attribution via pseudonym, not real identity | Visible contribution is motivation; real identity is permission-only |
| Lazy materialization (locations don't exist until visited) | Infinite world with ~10K rows per active settlement |
| Combat hardcoded Wave 1, module Wave 2 | Ship MVP faster; refactor proves module boundary cleanly |
| Per-location chat threads | LoGD-style, natural social layer tied to place |
| 7-step onboarding for world bible | Long enough to build a rich foundation, short enough kids stay engaged |
| World bible is the canonical reference, injected everywhere | Facts constrained, creativity maxed — without it, AI drifts |

## Testing

| Decision | Rationale |
|---|---|
| State-space crawler + VLM screenshot eval + replay corpus | Three independent views; all cheap with AI cache |
| Auto-rollback on deploy via shadow environment + canary | Family-visible reliability; durable runtime makes this safe |
| Anonymization before replay corpus inclusion (minor sessions) | Privacy baseline non-negotiable |

## Privacy

| Decision | Rationale |
|---|---|
| On-device Whisper for voice input | Zero cost, perfect privacy, fast enough on modern devices |
| Content rating locked to "family" when minor linked | A family rating is a promise, not a setting |
| Guardian dashboard with full minor visibility | Transparency to both minor and guardian |
| Explicit opt-in for any cross-family content sharing | No surprises |

## Scope (what Wave 1 deliberately does NOT include)

| Deferred | Moved to | Rationale |
|---|---|---|
| Module system + browser designer | Wave 2 | Hardcoded Wave 1 lets us ship faster |
| New Day loop | Wave 2 | Not essential for closed beta fun |
| Branches / dreaming | Wave 3 | Blob storage in Wave 1 makes this easy later |
| Cross-branch character portability | Wave 3 | Depends on branches |
| Era chronicle | Wave 3 | Emergent from branch system |
| Voice for NPC conversations | Wave 3+ | Streaming STT adds cost + complexity |
| 2D tile view | Wave 4 (optional) | Text-first is the soul; tile is bonus |
| Public worlds | Wave 4+ | Compliance + moderation order-of-magnitude harder |

Each of these can be argued. Most have been argued. They stay deferred because shipping a family beta reveals more than designing in advance.

## Revisions (2026-04-19 spec-review session)

The following decisions from the original log were reversed or reframed. Entries above preserve the original rationale; this section supersedes them.

| Original decision | Revised decision | Rationale for change |
|---|---|---|
| Generator-based event-sourced durable runtime | **Step-keyed state-machine runtime** — `{ steps: { [id]: (ctx, state) => ({ next, effects }) } }` stored in `flows` with `current_step_id + state_blob_hash`; resume = handler lookup. | Generator-replay is a Temporal-sized commitment with subtle closure/non-determinism landmines. State machines give crash-safety and version-pinning with less moving-parts. See `01_ARCHITECTURE.md` §"Durable runtime." |
| Three execution paths (JSON / inline script / module) | **Two execution paths** — JSON with safe inline expressions (extended template grammar) + durable module. | The 95/4/1 split was a guess; the "4% inline" tier would have required a custom grammar, parser, editor, AI-authoring path. Collapsing into the template grammar + modules drops a maintenance burden. `03_INLINE_SCRIPT.md` marked deprecated. |
| Inline script ~300 LOC interpreter | **No inline-script interpreter.** | Use cases (conditional prose, seeded RNG, dice, small state writes) now served by safe inline expressions in `02_LOCATION_SCHEMA.md` §"Template grammar." |
| Module capability sandbox (Wave 2, QuickJS WASM isolate) | **Typed-proxy `ModuleCtx` — no runtime isolate in Wave 1-3.** Modules are trusted TypeScript compiled in. A real isolate returns only for user-authored modules in Wave 4+ (if ever). | Family-instance scope means all modules are trusted. No need to pay the complexity/cold-start cost of QuickJS. Proxy pattern kept for documentation + bug-catching. |
| Event log per-branch | **`flow_transitions` per-branch** — state-machine transition log replaces the event log as the replay primitive. | Events were specific to generator-replay; state-machine runtime uses transition log (step_from → step_to + effects) for debugging and replay tests. |
| Blob GC by reference counting | **Mark-sweep GC.** | Refcount across concurrent mutations is race-prone; mark-sweep is provably correct and no harder to implement. See `12_BLOB_STORAGE.md` §"Garbage collection." |
| Anonymization before replay corpus inclusion (minor sessions) | **No anonymization required.** Corpus is family-internal; per-family-instance deployment makes cross-family replay-corpus sharing a non-issue in Wave 1-3. | See `16_PRIVACY_AND_MINORS.md` collapse — minors/COPPA concerns are Wave 4+ (cross-family/public). |
| Guardian dashboard with full minor visibility | **No separate dashboard surface in Wave 1.** `is_minor`, `guardian_user_ids`, `per_day_cost_cap_usd` fields live in the schema; visible-to-instance-owner is sufficient. | Single-family instance = owner already sees everything. Guardian dashboard as a product surface belongs to Wave 4+ when cross-family adoption creates a real "grown-up reviews kid's activity" use case. |
| Mobile-first with ≤80KB initial bundle | **80KB is aspirational; realistic target is ~120-160KB.** | Stock SvelteKit + Convex client + Tailwind + auth + PWA baseline is already ~50KB before app code. Be honest about the real budget. See `FEASIBILITY_REVIEW.md` §3. |
| Multi-player reactive sync on shared location | **At-transition sync for durable state; reactive sync for chat + `location.*` state only.** | Continuous `this.*` sync would require resolving "who goes first when two players tap the same option" — a real design problem with no clean answer at this scope. At-transition sync keeps each player's turn-based pace while chat stays real-time where it matters. |

### New decisions (2026-04-19)

| Decision | Rationale |
|---|---|
| Multi-tenant isolation from day one | One family, many worlds + many forks; isolation between worlds is a security boundary. Every index starts with `[world_id, ...]`; `ctx.auth.userId` is the only trusted identity. See `ISOLATION_AND_SECURITY.md`. |
| `world_memberships` as the sole source of world-level permission | No global admin role; debug access is audit-logged and time-limited. |
| AI cache keys include `world_id` + `branch_id` | Even if prompts hash identically across worlds, cache entries don't collide. |
| User-sourced content in prompts gets delimiter-sanitized + tag-wrapped | Prompt-injection defense in depth, even in family scope. |
| `audit_log` table for auth-sensitive actions | Append-only, module-inaccessible, forensic trail. |
| Adversarial-isolation test category in the trinity (release-blocker) | Isolation bugs are security bugs, not style nits. |
| Admin debug surface with 30-min audited sessions, not a role | Operator support without a standing superuser. |
| Pre-world cost attribution via `world_drafts` | A kid can't burn $50 in the bible builder with no attribution trail. |

### Historical decisions that remain valid

These read differently in light of the revisions but are still the right calls:

- **CodeMirror 6 over Monaco** — still applies, now for the module-source editor (desktop advanced mode) rather than an inline-script editor.
- **BLAKE3, Convex, Tailwind 4, SvelteKit 5, Opus 4.7 + cache_control, FLUX.2, R2, never-GC-by-default** — unchanged.
- **Combat hardcoded Wave 1, module Wave 2** — unchanged; module boundary is the typed-proxy pattern defined in the revised runtime.
- **World bible as canonical reference, cached** — unchanged; cache keys updated for multi-tenant isolation.

## Revisions (2026-04-20 integration pass)

After Wave 0 Day 2-4 landed, several authoring/runtime decisions crystallized in code and need to be recorded here so the pattern isn't re-litigated:

| Decision | Rationale |
|---|---|
| **Draft/canon model for expansion-loop output** — expanded locations land with `draft=true`, visible only to the author. Canonical map growth is a deliberate save action. | The original "stub becomes canonical immediately" design made first-visit wandering irrevocable and noisy. Drafts let players explore, keep what matters, let the rest fade. Author-only visibility means one player's half-thought doesn't clutter the shared map. |
| **Journeys + journal replace the per-location "Save to map" card** — journey opens on first draft-from-canonical, closes on return; a single cluster panel asks "keep any of these?" at close. | The per-location prompt broke immersion by demanding a decision mid-dream. Deferring to the journey close is the pattern that lets the dream stay a dream until the player is back on their feet. See `19_JOURNEYS_AND_JOURNAL.md`. |
| **Click-into-nowhere chains to expansion** — options whose target slug doesn't resolve return `needs_expansion: { hint: option.label }` instead of failing silently. | Opus-generated options routinely reference locations that don't exist yet ("Climb higher", "Step into the light"). Silent no-op was a dead end; chaining into expansion turns every dangling option into a door. |
| **Biome-bias prompt fragment** in the expansion loop — Opus is nudged toward existing biomes + adjacent locations unless the player's input genuinely demands a new biome. | Opus without this tends to invent a fresh biome per expansion, fracturing the visual anchor. The bias keeps worlds visually coherent across hundreds of drafts without over-constraining creativity. |
| **Art pipeline = scheduler + R2 via S3 client, not the art_queue table** — `ctx.scheduler.runAfter(0, internal.art.generateForEntity)` on location insert/expand writes the result straight onto `entity.art_blob_hash + art_status`. The `art_queue` table is retained for future batch / retry scenarios. | Simpler than running a polling worker for the always-small family case. Scheduler gives async behavior with per-entity state living on the entity itself. |
| **Per-biome palette overrides** — biomes carry an optional `palette:` block (hue shift, background/ink tints, atmosphere tag) composed over the world theme at render time. | Per-world themes are too broad for the vibe differences between office / sewer / apartment. Per-biome palettes give room-sized variation without multiplying theme complexity. See `10_THEME_GENERATION.md` §"Per-biome palette overrides." |
| **`expansion_hint:` field on location frontmatter** — optional; fed into Opus's expansion prompt when generating a draft *from* that location. | Authored locations often have implicit tone/scope rules ("this is a contemplative spot, not combat") that Opus can't infer from biome + bible. Giving the author a one-line hint preserves intent. |
| **Shared-world household via `preauthorizeHousehold` + `reseatPrimaryOwner`** — one-shot internal mutations that seat N family accounts on a primary's worlds. Forward-only (re-run when new worlds are created). | Wave 0 family-instance model has 4 family members sharing worlds; multi-tenant schema already supports this, needed a batch convenience for the common case. Auto-share-on-seed is a future refinement. See `20_HOUSEHOLD_AND_SHARING.md`. |
| **Interim auth uses `session_token` argument, not `ctx.auth.userId`** — Convex mutations resolve user via `resolveSession(ctx, token)`. Swap to `ctx.auth.getUserIdentity()` when Better Auth lands. | Convex-native magic-link shipped before Convex custom-auth wiring was worth building; the risk is bounded because `user_id` is never client-trusted. See `CLAUDE.md` URGENT item 11. |

### Open questions for a future session

- **Character role enum** (`player_character` / `core_npc` / `travelling_npc` / `major_npc` / `minor_npc` / `antagonist` / `pet`) — three candidate enums are in flight across spec, extraction, and importer. Pick one canonical set. Recommendation: IMPORT_CONTRACT's `player_character | travelling_npc | antagonist | pet`. See `AUTHORING_AND_SYNC.md` §"Character role enum — OPEN QUESTION."
- **Cross-type relationships** (`characters[].relationships[].with:` targeting an npc slug) — accept or prune? Recommendation: accept. Same spec, §"Cross-type relationships — OPEN QUESTION."
- **Quiet Vale backup to a separate repo** — user-flagged 2026-04-20. Design spec pending (probably folds into `20_HOUSEHOLD_AND_SHARING.md`).
