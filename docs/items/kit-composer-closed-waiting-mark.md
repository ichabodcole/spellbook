---
type: item
title: With the composer closed, nothing shows a message is waiting
description:
  When the human closes the floating composer, the chat rail shows no waiting
  mark, so E53's sign that a message is waiting on the agent is lost.
status: stable
lifecycle: ready
id: 01a157b8-baa0-701e-a5b1-51a0667b4fbe
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-19 }
tags: [kit, scriptorium]
parent: feature/workspace-kit
from: cycle/2026-10-shell
cycle: 2026-10-shell
---

# With the composer closed, nothing shows a message is waiting

Found by the Atlas comparison (C6) on 2026-10-20. With the chat column collapsed
and the floating composer closed, the rail carries no mark that a message is
waiting on the agent. E53's waiting mark is one of the shipped behaviours the
port must not lose.

## Definition of done

- [x] With the composer closed, the chat rail shows a waiting mark while a
      message waits on the agent, and its "may be stuck" state after 30 s.
- [ ] Tested, and offered on kit-parity.

## Done and verified

Commit `119d0833` on `impl/kit-composer-closed-waiting-mark` (from `cycle/shell`
at `de8dd5d8`). Kit work, not a port: Story Studio's `develop` (`2846a475`) has
the same gap.

- **The mark.** While the column is collapsed and the float closed, the rail's
  composer button (`chat-float-show`) carries a `WaitingDot` at its corner
  (`data-slot="chat-rail-waiting"`). It reads `unheard` while no agent listens,
  pulses while one does, and is static `stalled` once the daemon says so.
- **One mark for both waits.** `waitingOnAgent` in `shell/rail.ts` folds the
  human's message (`state.waiting`) and the notes owed an answer
  (`notesWaiting`) into one mark. It uses the rules their own badges use
  (`badgeFor`, `owedSummary`) and picks the loudest: stalled, then unheard, then
  working. A pulse beside a stuck or unheard wait would be false liveness. The
  words name each wait, so "may be stuck" is said only of the one that is. The
  words are the button's accessible name and title, for example
  `Show the composer (your message: took this in, then went quiet; may be stuck)`.
  The dot itself is `aria-hidden`, so a screen reader does not hear it twice.
- **When it clears.** The mark is the daemon's state drawn again, with no local
  flag (one state, one meaning). It goes when the wait ends. It also goes when
  the human opens the composer or the column, because the rail button goes with
  them and the float's own line carries the badge. If the float is closed again
  while the wait still holds, the mark comes back, because it is still true. A
  "seen" flag that hid a wait still in force would be a second state.
- **Beside the unseen mark.** The two never stand for the same fact, so both are
  kept. The unseen mark is the agent's news: a separate 8 px attention-coloured
  button under the rail's buttons, which opens the conversation. The waiting
  mark is the human's question, waiting: a 6 px dot on the composer button's
  corner, in the badge colours. An agent answer swaps one for the other. The
  test checks this.
- **Never faded.** The dot does not fade in reader mode. The unseen mark does
  not fade either: a stuck wait asks for attention. The button under it still
  fades.

Tests:

- `shell/rail.test.ts` covers the rule: words, loudness, unheard and the snooze.
- `shell/WorkspaceShell.railWaiting.test.tsx` runs over a real daemon. It covers
  unheard, then working once a tail starts, then cleared by the answer with the
  unseen mark taking over. It also covers stalled (static, "may be stuck"),
  reopening the composer or the column, re-closing while the wait holds, and a
  note owed an answer.

Checked in a real browser on the flagged Scriptorium (`SCRIPTORIUM_KIT=1`,
scratch home). With no agent listening, the rail button's dot was `unheard`,
faint and static. Once a `tail` started it was `working` and pulsing. It turned
`stalled`, static in the attention colour with "may be stuck" in its name, 30 s
after the message was sent. When the agent answered (`say`), the waiting dot
went and the unseen mark appeared.

Offering it on kit-parity is the lead's job, so that box is left open.

## Port-back notes

- **New in `shell/rail.ts`:
  `waitingOnAgent(waiting, notesWaiting, agentListening)`.** It is DOM-free and
  imports `owedSummary` and `badgeFor`/`labelOf` from `chat/`.
- **`WorkspaceShell.tsx`:**
  - `composerWaiting` is computed beside `notesOwed`.
  - The rail's `chat-float-show` `ColumnButton` is wrapped in a `relative` span.
  - The button's label carries the wait's words.
  - An `aria-hidden` `WaitingDot` sits at the button's top-right corner.
  - No other route changes.
- **New test file: `shell/WorkspaceShell.railWaiting.test.tsx`.** It uses the
  fixture daemon and an agent tail, as `WorkspaceShell.noteWaiting.test.tsx`
  does.
- **The same gap is in Story Studio's `develop` at `2846a475`.** Its
  `chat-float-show` button carries no waiting mark.
