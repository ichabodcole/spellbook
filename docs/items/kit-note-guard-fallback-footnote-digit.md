---
type: item
title:
  The note guard's fallback refuses an honest selection holding a real digit
  that matches a footnote number
description:
  When the guard's walk runs out of budget on a long repetitive run, its
  fallback strips every page-only footnote number from seen, including a real
  digit in the text, and refuses an honest selection.
status: draft
lifecycle: triage
id: 01a1765b-e6ee-71df-8c9f-ea3a46ca5ff2
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-25 }
parent: feature/workspace-kit-follow-ups
from: items/kit-lone-cr-line-endings.md
---

# The note guard's fallback refuses an honest selection holding a real digit that matches a footnote number

Found by the last verifier of
[kit-lone-cr-line-endings](./kit-lone-cr-line-endings.md) (2026-10-25). When
`showsSelection`'s walk runs past its work budget on a long repetitive run, it
falls back to `foundWhole`. That tries `seen` as given (which still holds a
page-only footnote number) or with every page-only token removed, which also
removes a real digit equal to a footnote number.

Document: a code block of dashes, then `version 1 notes[^1] end.`. Selecting
from inside the block to after the footnote number gives `seen` = dashes +
`version 1 notes1`. At 300 dashes the walk accepts it; at 3,000 and 20,000 the
fallback refuses it. With `version 2` every size is accepted. The human is told
to use the raw view; nothing wrong is stored.

## Definition of done

- [ ] The fallback skips a page-only token only where the range's text doesn't
      match at that point (one linear greedy pass), instead of stripping every
      occurrence.
- [ ] The case above is accepted at every size, with the budget forced to 0, and
      the round-3 wrong shapes are still refused.

## Related Documents

- [A file with lone CR line endings breaks the rendered view](./kit-lone-cr-line-endings.md)
