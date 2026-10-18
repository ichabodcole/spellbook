---
type: item
title: The kit prose ward misses a utility name followed by a colon
description:
  The kit prose ward's BARE cell catches a Tailwind utility name in kit comments
  (blur, columns) but not one written with a trailing colon (blur:); make the
  match ignore trailing punctuation.
status: draft
lifecycle: triage
id: 01a14cb0-b547-778d-978a-72411d231258
kind: chore
generated: { by: claude-opus-5-5, at: 2026-10-17 }
parent: feature/workspace-kit
from: features/workspace-kit/sessions/2026-10-17-panes.md
---

# The kit prose ward misses a utility name followed by a colon

Found by the panes cycle's `kit-port-context` implementer (2026-10-17). The kit
prose ward's BARE cell catches a Tailwind utility name in a kit comment (`blur`,
`columns`). It does not catch the same word written with a trailing colon
(`blur:`).

## Definition of done

- [ ] The BARE cell catches a utility name followed by a colon or other trailing
      punctuation, and a planted `blur:` turns it red.
