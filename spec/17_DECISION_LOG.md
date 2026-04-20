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
