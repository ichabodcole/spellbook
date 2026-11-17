---
type: item
title: Do the other spells' CLIs write to the wrong session too?
description:
  "Magpie, glamour, imago, bounty and astrolabe have their own CLIs, which the
  #137 fix doesn't cover; check whether an unpinned write can reach another live
  session."
status: draft
lifecycle: triage
id: 01a1eb65-f9eb-72a5-a6c0-c1857013a0ce
kind: research
generated: { by: claude-opus-5-5, at: 2026-11-17 }
from: items/kit-unpinned-verbs-write-to-another-session/sessions/2026-11-17-ambiguous-session.md
---

# Do the other spells' CLIs write to the wrong session too?

Found by the review of the #137 fix (2026-11-17). The fix refuses an unpinned
write when several sessions are live, but only in the kit's shared CLI
(`createWorkspaceCli` in `src/kit/workspace/verbs.ts`), which only Scriptorium
uses. Magpie, glamour, imago, bounty and astrolabe have their own `postCmd`
CLIs. If any of them targets "the newest session" when `--session` is left off,
an agent's write can land in another live session, as in #137.

## Definition of done

- [ ] Each spell's CLI is checked: how it picks a session without `--session`,
      and whether two of its sessions can be live at once.
- [ ] Each one that can misroute a write gets a bug item, or the shared refusal,
      with the reason recorded here.
