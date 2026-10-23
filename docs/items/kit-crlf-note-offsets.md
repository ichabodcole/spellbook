---
type: item
title: Notes in a CRLF file may land off by a character per line
description:
  The daemon's note offsets count each CRLF as two characters while the raw
  editor counts one, as reveals did before the broken-links item fixed them, so
  a note may paint late in a CRLF file.
status: stable
lifecycle: ready
id: 01a15842-5761-741a-abc6-23aa8c229bda
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-20 }
tags: [kit]
parent: feature/workspace-kit-follow-ups
from: cycle/2026-10-shell
cycle: 2026-10-polish
---

# Notes in a CRLF file may land off by a character per line

The `kit-broken-links-visible` builder (2026-10-20) fixed reveals in CRLF files
with `editorOffset` in `DocumentView.tsx`, which counts each `\r\n` once. Notes
the daemon places use the same daemon offsets, and were not checked.

## Definition of done

- [ ] A note placed by the agent in a CRLF file paints on its own words in raw,
      rendered and split views, with a test.
- [ ] Offered on kit-parity if the fix is in the kit.
