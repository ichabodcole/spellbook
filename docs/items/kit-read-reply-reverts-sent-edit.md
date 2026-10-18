---
type: item
title: Typing right after opening a document can be lost on the kit path
description:
  The pane's open-time read reply can land after an edit was sent and revert the
  client's copy; the next keystroke then sends the old text and the earlier
  typing is gone. Kit path only; the shipped client sends no second read.
status: stable
lifecycle: active
id: 01a14eb6-f99c-750f-953b-69dcc00f60f6
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-18 }
tags: [kit, document, data-loss]
parent: feature/workspace-kit
from: 01a14dc5-70c3-7762-8b0a-db667fbc47c8
cycle: 2026-10-document-pane
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

- [x] A `version.text` older than an edit the client has already sent never
      replaces the client's copy. Both repro cases are tests that fail without
      the fix.
- [x] Typing right after opening a document survives a slow daemon in a real
      browser.
- [ ] The fix is generic, and it is offered on kit-parity with the repro,
      because Story Studio's kit has the same code.

## Done and verified

Fixed in `13b03e71` (the client and its tests) and `82b9e219` (the flagged
Scriptorium's rebuilt kit surface), on `impl/kit-read-reply-reverts-sent-edit`
from `cycle/document-pane` at `9e043863`.

**The approach: order by request id, not by time.** The daemon takes one
socket's frames in the order they were sent, and `open` and `read` answer
synchronously with the frame's `rid` echoed as `requestId`. So a reply whose
request id is lower than the newest edit sent for that `doc@version` was read
before the daemon took the edit. `daemonClient.ts` records the id of each edit
it sends (`sentEdit`, by `doc@version`) and passes over such a reply. Every
other `version.text` is taken as before:

- a frame that answers no request (a link rewrite, Reload/`revert`, `merge`,
  `activate`, a change on disk), because it is the daemon's news;
- a reply to a request sent after the edit;
- a reply for another version.

The other options were weighed and not taken:

- **A sequence the daemon sends with `version.text`.** The only one is `rev`,
  and it is set only on link rewrites. Adding a per-socket "edits taken" counter
  would change the protocol on both sides for what request ids already give.
- **Tracking edits until the daemon acknowledges them.** `edit` has no
  acknowledgement, so this needs a new frame.
- **Not sending the pane's extra `read`.** It fixes case B only. Case A's stale
  text is the `open`'s own reply, and suppressing the `read` would depend on
  knowing that a push is coming.

The fix needs no timer, no protocol change and nothing in the daemon. It lives
in the client every surface shares, so a `read` an app sends itself is covered
too.

**Tests** (`src/kit/context/daemonClient.test.ts`, `writeText`):

- the verifier's cases A and B against the real fixture daemon. Each fails
  without the fix (the client's copy goes back to `# Solo\n`), with a later
  request as the fence;
- a fake-socket test that pins which replies are passed over.

The verifier's own `ksm-race.test.ts` (cases A, B and C, against the real
`kitDaemon`) passes on this branch.

**Checked:**

- **Real browser.** The flagged Scriptorium (`SCRIPTORIUM_KIT=1`) ran behind the
  400 ms-each-way lag proxy on 127.0.0.1, with a scratch HOME, SCRIPTORIUM_HOME
  and TMPDIR and `open` stubbed. The script opened a fresh document, typed
  `TYPED` the moment its text showed, then typed one more key.
  - With the fix, all three runs passed: the editor and the daemon both held
    `TYPEDQ`.
  - With the guard removed and the surface rebuilt, the run failed: the editor
    reverted within a second, and the daemon ended with `Q` alone.
- **Mutations.** Five were planted, and each turned the suite red:
  - guard removed;
  - guard inverted;
  - guard also drops unanswered frames;
  - keyed by document, not version;
  - edit id never recorded.
- **The rest of the client.** The agent's edits, Reload, version switches and
  merges all reach the client as broadcasts, with no `requestId`, so they are
  untouched. A second tab keeps its own ids and its own `sentEdit`.
  `resolveAppState` (the `state` case), the pane's line numbers and `textOffer`
  all read the client's `texts` and are unchanged. The full gate is green.
- **The shipped Scriptorium is unchanged.** Its plugin files are byte-identical
  to the base, apart from `dist/kit/`. Help, `open --no-open`, `state` and
  `close` on a scratch home match the base, apart from session ids.

## Port-back notes

- `packages/kit/src/context/daemonClient.ts` at Story Studio `b6d5956` has the
  same `version.text` case and `fireWrite` (only names differ), and its
  `DocumentPane.tsx` sends the same open-time `read`, so the bug is there too.
  The change ports as is:
  - a `sentEdit` map (`textKey(doc, version)` to the edit's request id), set in
    `fireWrite` once `send` returns an id;
  - in the `version.text` case, after the existing pending-write skip, a skip
    when `requestId` is a number lower than `sentEdit`'s id for that version.
- It relies on two things Story Studio's daemon also does at `b6d5956`:
  - `replyRaw` echoes `rid` as `requestId`;
  - `open` and `read` answer synchronously, in arrival order. An app verb that
    answers a `read`-like request after an `await` would still be safe, because
    a reply computed later only carries newer text.
- The two daemon-backed tests use the kit's fixture app and `seedDocs`, and port
  with the file.
