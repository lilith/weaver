# Weaver — Playtest Log

*Dated observations from family playtest sessions, per feature. The authority for flag transitions in `FEATURE_REGISTRY.md`: a feature moves `playtesting → shipped` after positive observations accumulate here; moves `playtesting → pulled` if friction recurs.*

## How to use this file

- Each session gets a dated heading.
- Group observations by feature being tested.
- Record who played, how long, what happened, verdict.
- Link related `UX_PROPOSALS.md` items when observations surface deferred decisions.
- If a session surfaces a hard-to-reproduce bug, cross-reference `LIMITATIONS_AND_GOTCHAS.md` or file a known-bugs entry.

## Template

```markdown
## YYYY-MM-DD — <feature_name> playtest session <N>

**Participants:** (user emails or pseudonyms)
**Duration:** (real-world minutes)
**World:** (world slug)
**Feature flag state:** (which flags were on for the session)

### Observations
- Bullet points of what happened, what worked, what surprised.

### Frictions
- Bullet points of what didn't work.

### Verdict
- Keep flag on / flip flag off / redesign / ship / pull.
- Next action (with owner).
```

---

*Sessions are appended below as playtesting occurs. No sessions logged yet.*
