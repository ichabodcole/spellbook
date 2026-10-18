---
type: item
title: Typing right after opening a document can be lost on the kit path
description:
  The pane's open-time read reply can land after an edit was sent and revert the
  client's copy; the next keystroke then sends the old text and the earlier
  typing is gone. Kit path only; the shipped client sends no second read.
status: draft
lifecycle: triage
id: 01a14eb6-f99c-750f-953b-69dcc00f60f6
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-18 }
tags: [kit, document, data-loss]
parent: feature/workspace-kit
from: 01a14dc5-70c3-7762-8b0a-db667fbc47c8
---

# Typing right after opening a document can be lost on the kit path

Found by the `scriptorium-kit-suggest-meta` verifier on 2026-10-18. It was
reproduced in a test and in a real browser. The cause is in code ported from
Story Studio's kit, so Story Studio has it too.

**Mechanism.**

1. The daemon's `open` broadcasts `state`, then pushes `version.text`.
2. The pane sees the document with no text yet, so it also sends `read`
   (`src/kit/document/DocumentPane.tsx`, around lines 611–614).
3. The human types. After 250 ms (`EDIT_DEBOUNCE_MS`) the edit is sent.
4. The `read` reply arrives after that, carrying the older text.
5. `daemonClient.ts`'s `version.text` case (around lines 660–667) skips a frame
   only while a write is pending, not once the write has been sent. So the
   client's copy, and the editor with it, goes back to the old text.
6. The daemon still holds the new text, but the human's next keystroke sends the
   old text plus that key, and the earlier typing is lost.

**Repro.** The race window is about one round trip, so locally it needs a busy
or slow daemon. In the verifier's browser repro, with 400 ms added each way,
`TYPED` was lost after one more key. Its test against the real `kitDaemon` and
`createDaemonClient` fails in two cases:

- a write flushed in the same tick as a re-open;
- a write flushed while a `read` is in flight.

The scripts are in that session's scratchpad (`ksm-race.test.ts`,
`ksm-pw/race2.ts` with `ksm-pw/lagproxy.ts`). The shipped Scriptorium keeps the
typing, because its client sends no second `read` on open.

## Definition of done

- [ ] A `version.text` older than an edit the client has already sent never
      replaces the client's copy. Both repro cases are tests that fail without
      the fix.
- [ ] Typing right after opening a document survives a slow daemon in a real
      browser.
- [ ] The fix is generic, and it is offered on kit-parity with the repro,
      because Story Studio's kit has the same code.
