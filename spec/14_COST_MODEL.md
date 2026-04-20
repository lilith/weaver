# Weaver — Cost Model

## Pricing reference (April 2026, confirm before assuming)

### LLM (Anthropic)

| Model | Input $/MTok | Output $/MTok | Cache write $/MTok | Cache read $/MTok | Notes |
|---|---|---|---|---|---|
| Claude Opus 4.7 | $5 | $25 | 1.25× input | 0.10× input | Narrative, generation, complex reasoning |
| Claude Sonnet 4.6 | $3 | $15 | 1.25× input | 0.10× input | Chat NPCs, narration |
| Claude Haiku 4.5 | $1 | $5 | 1.25× input | 0.10× input | Intent classification, vision checks |

Cache read at 0.10× is the single biggest cost lever. The world bible (~5-15K tokens) gets cached on first call of a session; every subsequent call within 5 minutes pays 10% of normal input rate for those tokens. Cache TTL extends on hit.

### Image generation (fal.ai)

| Model | $/image | Notes |
|---|---|---|
| FLUX.2 [pro] 1MP | $0.03 | Primary generator |
| FLUX.2 [pro] 2MP (landscape) | $0.05 | Biome establishing shots |
| FLUX Kontext | $0.03 | Reference-preserving edits |
| Nano Banana 2 | $0.02 | Cheaper alternative for iterative edits |

### Infrastructure

| Service | Plan | Cost |
|---|---|---|
| Convex | Free | 0-1M function calls/mo, 5GB DB, up to 5 team members |
| Convex | Pro | $25/mo base + usage beyond included |
| Cloudflare Pages | Free | Unlimited bandwidth, 500 builds/mo |
| Cloudflare R2 | Pay-as-you-go | $0.015/GB-month storage, $0 egress |
| Resend | Free | 3,000 emails/mo, 100/day |
| Domain | Cloudflare Registrar | ~$12/year at cost |

## Per-action cost breakdown

Typical single-user actions:

| Action | Call sequence | Cost |
|---|---|---|
| Pick an option on an existing location | 0 LLM calls | $0 |
| Free-text → existing action (intent classify → dispatch to known handler) | 1 Haiku (500 in / 100 out) | ~$0.0005 |
| Examine something (inline narration via Sonnet) | 1 Haiku classify + 1 Sonnet narrate (2K cached in / 150 out) | ~$0.003 |
| Talk to an NPC (multi-turn Sonnet exchange) | 1 Haiku classify + 2-4 Sonnet turns | ~$0.02 |
| Create a new location (Opus full generation) | 1 Haiku + 1 Opus (8K cached in / 1.5K out) | ~$0.04 |
| Generate art for a new location | 1 FLUX.2 [pro] 1MP | $0.03 |
| Edit a location by prompt | 1 Opus edit | ~$0.04 |
| Edit an image by prompt (3 variants) | 3× FLUX Kontext | $0.09 |
| Build a full world bible | ~$1.30 (detailed in `05_WORLD_BIBLE_BUILDER.md`) | $1.30 |
| Regenerate a theme | 1 Opus | ~$0.02 |

## Session cost estimate

A typical 30-minute family-of-5 session:

- 150 option taps: $0 LLM
- 40 free-text actions resolving to existing content: $0.02
- 10 new location generations: $0.40
- 10 new art generations: $0.30
- 5 NPC conversations (3 turns each): $0.10
- 2 prompt-edits by a kid: $0.08
- **Session total: ~$0.90 (LLM + image)**

Per-session infrastructure: negligible on Convex free tier, negligible on R2 (storage is $0.015/GB-month and a session adds maybe 10MB).

## Family-size scaling

### Family of 5 — casual play (beta baseline)

- 4 sessions per week × $0.90 = **$3.60/wk LLM + image**
- Plus ~$1/wk for occasional prompt edits, theme regenerations, and world bible tweaks
- Plus cost buffer for experimentation: $2/wk
- **Total: ~$7-16/wk, call it $10/wk nominal**

Infrastructure: free tier. Convex free tier (1M function calls) covers ~40 hours of active play per month per world. A family of 5 playing 4 half-hour sessions per week = 10 hours/month, well under cap.

**Annual cost: ~$520 LLM + image, $0 infra = ~$520/year per family-world.**

Set per-world daily cap at **$5/day**, leaves ~50% headroom for bursts.

### Medium community — 20 players across multiple families

- Assume 20 players each doing 2 sessions per week = 40 sessions/wk × $0.90 = **$36/wk LLM + image**
- Plus heavier edit usage (community worlds get edited more) = +$10/wk
- Plus world bible builds for multiple sub-worlds = +$5/wk
- **Total: ~$50-60/wk content costs**

Infrastructure:
- Convex Pro tier $25/mo base covers 20 simultaneous users with headroom
- R2 cost ~$1/mo for ~100GB of accumulated content
- Resend stays on free tier
- **Infra: ~$7/wk**

**Annual cost: ~$3,100 content + ~$360 infra = ~$3,460/year.**

### Large community — 100+ simultaneous players

- 100 players × 2 sessions/wk × $0.90 = **$180/wk content baseline**
- Heavy community editing, world bible churn, experimentation: +$100/wk
- **Total: ~$280-400/wk content costs**

Infrastructure:
- Convex Pro with high-volume tier: ~$100-150/mo = $25-35/wk
- R2: ~$5-10/wk as content accumulates
- **Infra: ~$30-45/wk**

**Annual cost: ~$15,000 content + ~$2,000 infra = ~$17,000/year.**

At this scale, community worlds need monetization. Options: subscription per player ($5/mo covers their slice + margin), community fund model, sponsor model. Outside Wave 1 scope.

## Cost controls

### Per-world daily cap

Enforced in the `cost_ledger` table. Before any LLM or image-gen call, the mutation checks current-day spend for the world. If over cap, the call is rejected and a graceful "the world is resting tonight" fallback renders instead.

```ts
async function checkBudget(ctx, world_id, estimated_cost) {
  const today_start = startOfDay(Date.now())
  const spent = await ctx.db.query("cost_ledger")
    .withIndex("by_world_day", q => q.eq("world_id", world_id).gte("created_at", today_start))
    .collect()
    .then(rows => rows.reduce((sum, r) => sum + r.cost_usd, 0))
  
  const world = await ctx.db.get(world_id)
  const cap = world.daily_cost_cap ?? 5.00
  
  if (spent + estimated_cost > cap) {
    throw new BudgetExceededError({ cap, spent, needed: estimated_cost })
  }
}
```

World owner sets cap in settings. Default: $5/day. Notification sent at 80% of cap. Hard stop at 100%.

### Per-user per-minute rate limits

Prevents accidental cost explosions (kid discovers free-text input and spams it).

- Free-text input: 10/minute per user.
- Location generation: 3/minute per user.
- Prompt edits: 3/minute per user.
- Art generation: 5/minute per user.

Enforced via Convex's built-in rate limiting or a simple counter in a per-user rate-limit table.

### Graceful degradation

When budget exhausted, actions gracefully downgrade:

| Normal behavior | Budget-exhausted behavior |
|---|---|
| Free-text → Opus create_location | Haiku classifies; if "create_location", say "the path is quiet tonight; try again tomorrow" |
| New location art generation | Use biome fallback permanently until tomorrow |
| NPC dialogue via Sonnet | Canned response from NPC's few-shot examples |
| Prompt edits | Queue until budget resets; notify user |

Players can always continue playing existing content; only new-content generation is gated.

### Monthly budget alerts

Weekly summary emailed to world owner:
- Total spend this week.
- Top spenders (by user).
- Top cost-drivers (location creation, art, edits, etc.).
- Projected monthly spend at current rate.

Useful for families setting a "we spent $X last month on Weaver" mental model.

## Cost attribution

Every `cost_ledger` row includes:
- world_id (required)
- branch_id (optional, if branch-attributable)
- user_id (optional, if user-attributable)
- kind: "opus" | "sonnet" | "haiku" | "flux_pro" | "flux_kontext" | etc.
- cost_usd: decimal to 6 places
- reason: short string ("create_location" | "edit_by_prompt" | "narrate_examine" | ...)
- created_at

This lets world owners slice cost by user (who's generating the most?), by kind (are we spending mostly on Opus or on images?), or by reason (editing is eating the budget).

UI: a "Costs" panel in world settings showing a 30-day cost chart, breakdown by user and by kind.

## Optimizations worth implementing Wave 1

1. **World bible caching**: single biggest lever. Ensure `cache_control: {type: "ephemeral"}` on every call. Estimated 60-80% input cost reduction.

2. **Intent classification caching**: Haiku responses for common inputs ("I go north", "I examine") are stable. Cache by input-hash with a 24h TTL. Free after first call per day per input-type.

3. **Biome fallback images**: pre-generate 8 generic fallback images per biome, serve until real art arrives. Zero cost per new location's first-view rendering.

4. **Progressive art quality**: generate thumbnail-size first ($0.01), queue full-size async. Player sees a stylized low-res immediately, HD arrives on next visit. Cuts initial art cost by 66%.

5. **Batch art generation**: fal.ai supports batch requests; generate 4-6 pending queue items in parallel for better throughput without cost savings (but lower latency means better player experience).

## Optimizations NOT worth it (Wave 1)

- **Switching to cheaper image models** (Nano Banana 2 saves $0.01/image). Not worth the quality degradation.
- **Self-hosting FLUX via Replicate or RunPod**. Break-even is ~1000 images/day; family usage is nowhere close.
- **Local Opus alternative**. No self-hostable model is close in quality for collaborative world-building at this scale.

## Summary budgeting guidance

For Lilith's closed beta: **set world daily cap to $5**. That's ~$150/month worst-case; realistic spend will be $30-50/month. Comfortable.

For a larger family network later: **per-world cap $10/day** with monthly billing transparency. Users paying $5/mo subscription more than covers cost.

For public worlds (Wave 4+): cap + monetization model. Not a Wave 1 concern.

## Integration into existing specs

- **`04_EXPANSION_LOOP.md`** — §"Rate limits & cost ceilings" links here; move specific dollar numbers here, keep concepts there.
- **`08_WAVE_1_DISPATCH.md`** — §"Budget expectations" links here.
- **`11_PROMPT_EDITING.md`** — §"Cost summary" references per-edit costs from this doc.
- **`09_TECH_STACK.md`** — add `cost_ledger` daily-cap enforcement to schema starter notes.
