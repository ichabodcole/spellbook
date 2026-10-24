---
type: item
title: A file with lone CR line endings breaks the rendered view
description:
  With old-Mac \r-only line endings, the rendered view paints no notes, offers
  no Add note, and a selection stores a note over the whole body without
  warning, on base and fix alike.
status: stable
lifecycle: ready
id: 01a16682-ca6f-702a-abc7-6f9d9bcfb2a9
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-22 }
tags: [kit, document]
parent: feature/workspace-kit-follow-ups
from: cycle/2026-10-polish
priority: high
cycle: 2026-10-release-6
---

# A file with lone CR line endings breaks the rendered view

Found by the CRLF-notes verifier (2026-10-23), on the base and on the fix alike.
`projection.ts` folds only `\r\n`. A file whose lines end in a lone `\r` (old
Mac endings) breaks the rendered view in three ways:

- it paints no notes;
- its right-click has no "Add note";
- selecting "alpha" stored a note over the whole body (offsets 9 to 191), with
  no warning.

Rare, but it silently attaches a note to the wrong text.

## Definition of done

- [ ] Lone-`\r` files render, note and select correctly in rendered, raw and
      split. Or Scriptorium normalises or refuses them with a clear message.
- [ ] No note is ever stored over a range the human didn't select.
- [ ] Tested; offered on kit-parity.
