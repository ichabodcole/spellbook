---
type: item
title:
  A second missed outside change after the banner is overwritten without asking
description:
  Once Save's unseen-change refusal raises the banner, a later Save counts as
  Keep mine; if the file changes outside again, unseen, that second change is
  overwritten without the human ever seeing it in the diff.
status: draft
lifecycle: triage
id: 01a17585-b354-7751-9164-583e44a4659e
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-25 }
parent: feature/workspace-kit-follow-ups
from: items/kit-save-overwrites-unseen-change.md
---

# A second missed outside change after the banner is overwritten without asking

Found by the verifier of
[kit-save-overwrites-unseen-change](./kit-save-overwrites-unseen-change.md)
(2026-10-25, probe P8). Save now refuses when the file changed outside and the
watch missed it, and raises the "Changed on disk" banner. Once the banner is up,
the next Save counts as the human's deliberate "Keep mine".

The gap: a document has edits; an outside write (theirs-1) is missed; Save is
refused and the banner rises. Then a second outside write (theirs-2) is also
missed. The human's next Save writes their text over theirs-2, which they never
saw in the diff. They chose to keep theirs over theirs-1, not over theirs-2.

Closing it means recording the file's hash when the conflict is raised and
re-checking it at Save: a different hash raises the banner again, with the new
diff.

## Definition of done

- [ ] Save after the banner writes only if the file still has the hash the
      banner was raised for; otherwise it refuses again, and the diff shows the
      newer text.
- [ ] A test misses two outside writes in a row and shows the second survives.
- [ ] Offered on kit-parity.

## Related Documents

- [Save can overwrite an outside change the file watch never reported](./kit-save-overwrites-unseen-change.md)
