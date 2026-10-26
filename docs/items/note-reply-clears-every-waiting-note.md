---
type: item
title: A reply to one note clears the waiting mark on every note
description:
  notesWaiting treats any agent message newer than a note as its answer, so
  note-reply to one note (or any say) stops every other note from showing as
  waiting, though nothing was said to them.
status: draft
lifecycle: triage
id: 01a1759b-4cb1-72ff-b1fd-f47246421e50
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-25 }
parent: feature/workspace-kit-follow-ups
from: items/note-reply-cannot-overwrite.md
---

# A reply to one note clears the waiting mark on every note

Found by the verifier of
[note-reply-cannot-overwrite](./note-reply-cannot-overwrite.md) (2026-10-25).
The human left notes n1 and n3; `note-reply n3` alone took the owed list from
`[n3, n1]` to `[]`. The cause is `notesWaiting` (`src/kit/workspace/waiting.ts`,
around lines 154–180): any agent message newer than a note counts as its answer.
A plain `say` with no `about` clears every note the same way, on the base too;
the SKILL says notes wait "until you say something in the app".

That was coarse but consistent before there was a per-note reply. Now that
`note-reply` names the note it answers, the human's other notes lose their
waiting mark with nothing said to them.

## Definition of done

- [ ] A reply clears only the note it names; a plain `say` either clears none,
      or the rule is decided and the SKILL says which.
- [ ] Tested with two human notes and one reply.
- [ ] Offered on kit-parity.

## Related Documents

- [An agent's reply to a note can't overwrite the human's note](./note-reply-cannot-overwrite.md)
