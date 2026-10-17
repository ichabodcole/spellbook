---
type: item
title: "Kit writes check, then write: a concurrent link swap can slip between"
description:
  Every guarded kit write checks its target and then calls the syscall, so an
  attacker with raw disk access racing a link swap between the two can redirect
  it; out of scope for the wiki-layer cycle by Cole's call, recorded here.
status: draft
lifecycle: triage
id: 01a14911-a352-7688-b85d-85a392b2be5b
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-17 }
tags: [kit, security]
parent: feature/workspace-kit
---

# Kit writes check, then write: a concurrent link swap can slip between

Found by the third re-verifier of the wiki-layer cycle's security fixes
(2026-10-17). `src/kit/workspace/disk.ts` checks each target (own places, links,
twins) and then writes. A concurrent process with raw disk access can swap a
link in between. Cole ruled on 2026-10-17 that the cycle defends against planted
links but not concurrent races, since the kit cannot create links itself.

## Definition of done

- [ ] A decision on whether to close the window (for example, open-by-handle
      with `O_NOFOLLOW` all the way down, or `openat` from a pinned folder
      handle), recorded here.
- [ ] If yes: a racing test that swaps a link during a write is refused.
