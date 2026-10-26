---
type: item
title:
  A grapevine hold can't be ended early, and tails it stops leave no handoff
description:
  After stop --hold, roll is refused though the hold's own refusal says to run
  it, and live tails exit 6 with no tail.* line naming the next act; only stop
  --hold 1 shortens a hold, and nothing says so.
status: draft
lifecycle: triage
id: 01a176ad-1a0d-7549-8367-6ceb7b8419f5
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-25 }
from: items/bounty-grapevine-skill-review.md
---

# A grapevine hold can't be ended early, and tails it stops leave no handoff

Found by the SKILL review and its verifier (2026-10-25), both on scratch homes.

- **`roll` can't end a hold.** After `stop --hold N`, `roll` (and
  `roll --force`) takes the cold path into `ensureDaemon`, which refuses on
  `holdActive()` (`src/grapevine/backend/cli.ts` around 446 and 1520). The
  refusal's own text says "… or run `grapevine roll`", and it carries no `hint`.
  So the documented upgrade window (`stop --hold`, swap, `roll`) can only end by
  waiting. Only `stop --hold 1` shortens an active hold, and nothing says so.
- **Tails end without a handoff.** `stop` (and `--hold`) has no live-subscriber
  guard, unlike `restart` and `roll`. Live tails log "stream dropped …
  reconnecting…", then exit 6 with the held conflict and print no `tail.*` line
  naming the next act; they don't come back when the hold lapses.

Related:
[grapevine-stuck-daemon-refusal-gaps](./grapevine-stuck-daemon-refusal-gaps.md).

## Definition of done

- [ ] `roll` releases an active hold and respawns (or a named verb does), and
      the hold's refusal names a verb that works.
- [ ] A tail that meets a hold prints a `tail.*` handoff line naming how to
      resume (`start`, then `--since <last id>`), or waits out the hold.
- [ ] The SKILL describes the upgrade window as it then behaves.

## Related Documents

- [Review bounty + grapevine SKILL.md for accuracy and usefulness](./bounty-grapevine-skill-review.md)
