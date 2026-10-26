---
type: item
title: A held version toast shown on another document goes stale
description:
  A new-version toast raised after its hold while another document is open stays
  up, offering Activate, after the agent activates or deletes that version from
  the CLI; versionSettled only judges the open document.
status: draft
lifecycle: triage
id: 01a17778-5509-703c-b1bd-9d94eb93f8f3
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-26 }
tags: [kit, chat]
from: items/scriptorium-chat-and-toast-nits.md
---

# A held version toast shown on another document goes stale

Found by the no-stake verifier of `scriptorium-chat-and-toast-nits`, round two
(2026-10-26).

The agent runs `version-new` on alpha.md, and the human opens cc.md within the
400 ms hold. The toast is then raised while cc.md is open, offering Activate
only. That part is right, and it names alpha.md.

The problem: if the agent then runs `activate` or `version-delete` on that
version from the CLI, the toast stays up. It still offers "Activate v2" and says
"You're still editing v1" until the human goes back to alpha.md. Pressing a
stale Activate after a delete gets the refusal "alpha has no v2", which is
harmless.

Cause: `versionSettled()` in `src/kit/chat/newVersions.ts` only judges a version
while its document is the open one. Base never raised this toast at all, so it
is not a regression.

## Definition of done

- [ ] A raised toast for a version on another document closes when that version
      becomes active or is deleted, whichever document is open.
- [ ] Tested; the test goes red with the old rule.
