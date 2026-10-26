---
type: item
title: bounty's latest pointer and list title go stale
description:
  Closing a keyed board deletes bounty-latest.json instead of pointing it back
  at a still-running board, so unpinned verbs exit 5; list reads titles from the
  discovery file and misses init --title.
status: draft
lifecycle: triage
id: 01a176ad-1bd5-71a6-834c-2a18ecd6382e
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-25 }
from: items/bounty-grapevine-skill-review.md
---

# bounty's latest pointer and list title go stale

Found by the SKILL review and confirmed by its verifier (2026-10-25):

- **The latest pointer.** With an unkeyed board A running, open a keyed board K
  and close it: `bounty-latest.json` is deleted rather than pointed back at A,
  so unpinned `state`, `add` and `close` exit 5 "no running bounty session"
  while `list` shows A running.
- **`list`'s title.** `list` reads each board's title from the discovery file,
  so after `init --title Reseeded` it still shows the old title while `state`
  shows the new one.

## Definition of done

- [ ] Closing a board points `latest` at the newest board still running, or
      removes it only when none is.
- [ ] `list` shows the current title.
- [ ] Both tested.

## Related Documents

- [Review bounty + grapevine SKILL.md for accuracy and usefulness](./bounty-grapevine-skill-review.md)
