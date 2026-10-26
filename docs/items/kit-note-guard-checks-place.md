---
type: item
title: The note guard checks where a selection is, not only its text
description:
  "The daemon's seen guard checks that a note's range shows the selected text,
  but not where: the same words elsewhere, or an uncuttable run that contains
  them, still pass, and uncuttable runs are stored whole."
status: draft
lifecycle: triage
id: 01a1765b-e655-70f4-9178-f1607f1be78d
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-25 }
parent: feature/workspace-kit-follow-ups
from: items/kit-lone-cr-line-endings.md
---

# The note guard checks where a selection is, not only its text

From [kit-lone-cr-line-endings](./kit-lone-cr-line-endings.md) (2026-10-25).
That item added a daemon guard: `note.add` carries `seen`, what the human
selected as the page showed it, and `showsSelection` in
`src/kit/document/projection.ts` refuses a range that doesn't show it. It
stopped the whole-body note the item was about, and its verifiers found no
honest selection it refuses. Two gaps remain, recorded there as the reason its
"no note over text the human didn't select" box stays unticked:

- **Uncuttable runs are stored whole.** A selection that starts or ends inside a
  run the projection can't cut (inline code, a line with an entity or escape)
  stores the whole run. In a rich document about 22% of random placed ranges
  hold more than 20 unselected characters; base is the same.
- **The place is not checked.** The same words elsewhere, or an uncut run
  elsewhere that contains them, pass.

Closing both needs the page to send where the selection was (for example offsets
in the projection's rendered text), and the projection to cut inside runs it
treats as whole today.

A verifier also suggested a cleaner seam: let `showsSelection` take a projector
and keep the projection cache in a small object the session owns, instead of the
module-level `lastProjected` cache and the exported `checkProjections.made` test
counter.

## Definition of done

- [ ] The page sends the selection's place, and the guard refuses a range that
      doesn't start and end where the selection did (within one run's slack).
- [ ] A selection inside an uncuttable run stores only what was selected, or the
      item says why it can't.
- [ ] The verifier's fuzz (`accepts`, `shift` and the page-DOM fuzz) shows no
      honest refusals and fewer stored unselected characters than base.
- [ ] Offered on kit-parity.

## Related Documents

- [A file with lone CR line endings breaks the rendered view](./kit-lone-cr-line-endings.md)
