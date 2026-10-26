---
type: item
title: A missed-change Save refusal shows four messages in three vocabularies
description:
  On a Save refused for an unseen outside change the human gets an error box,
  the banner, a toast and a chat line, naming the same choice three ways; a
  clean document's refusal reads as a failure though the kit protected the file.
status: draft
lifecycle: triage
id: 01a17585-b3f1-7130-b253-563e85932519
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-25 }
parent: feature/workspace-kit-follow-ups
from: items/kit-save-overwrites-unseen-change.md
---

# A missed-change Save refusal shows four messages in three vocabularies

Found by the verifier of
[kit-save-overwrites-unseen-change](./kit-save-overwrites-unseen-change.md)
(2026-10-25). Screenshots: `shot-brq-1.png` and `shot-brq-2diff.png` in that
session's scratch.

When Save is refused for an outside change the watch missed, the human sees four
messages at once:

- a red error box in the context column: "See the difference" / "Keep mine" /
  "Take the file's";
- the banner, with the same three words;
- the toast: "Reload" / "Keep";
- the chat line: "Save overwrites… Revert takes…".

The toast and the chat line predate this fix: a delivered watch event already
named one choice three ways. For a clean document the error box says "Save wrote
nothing" while the chat says the text was reloaded, which reads as a failure
when the kit protected the file.

## Definition of done

- [ ] One vocabulary for the choice across banner, toast and chat.
- [ ] No error box when the refusal has already raised the banner, or when a
      clean document was simply reloaded.
- [ ] Checked in a real browser; offered on kit-parity.

## Related Documents

- [Save can overwrite an outside change the file watch never reported](./kit-save-overwrites-unseen-change.md)
