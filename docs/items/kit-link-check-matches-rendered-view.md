---
type: item
title: The link check counts what the rendered view draws
description:
  link-check, backlinks and graph count some links the rendered view doesn't
  draw and miss some it does, so the broken-links sign and the agent's graph
  disagree with the page.
status: draft
lifecycle: triage
id: 01a176c6-11ee-740d-9dba-55fb8b0aa584
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-25 }
parent: feature/workspace-kit-follow-ups
from: items/scriptorium-chat-and-toast-nits.md
---

# The link check counts what the rendered view draws

link-check, backlinks and graph count some links the rendered view doesn't draw
and miss some it does, so the broken-links sign and the agent's graph disagree
with the page.

Bullets 24, 25, 26, 29 and 30 of the nits item, re-checked on 2026-10-25: an
unclosed `<./x` is counted though the view draws no link; `a&amp;b.md` is looked
up literally while the view opens `a&b.md`; reference-style links (`[x][r]`,
`[r][]`, `[r]`), labels nested two deep and parentheses two deep are drawn but
missed; a link after a line ending in `[` before a list line is counted though
the view ends the paragraph; cells beyond the header are counted though the view
drops them. Evidence is in the re-check report the item records.

## Definition of done

- [ ] Each of the cases above is counted by `link-check`, `backlinks` and
      `graph` if and only if the rendered view draws it as a link, with the
      target the view opens.
- [ ] Each case is a test that compares against the renderer's own parse.
- [ ] The SKILL's "reference-style unsupported" line is updated.

## Related Documents

- [Scriptorium: small chat and toast leftovers](./scriptorium-chat-and-toast-nits.md)
