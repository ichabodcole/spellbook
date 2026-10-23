---
type: item
title: Links and drop highlights are violet on Scriptorium's warm themes
description:
  The kit's brand token is violet, and Scriptorium's theme maps primary to its
  rubric but not brand, so rendered links, drag-and-drop overlays and other
  brand uses show violet against the cream and dark-brown themes.
status: stable
lifecycle: ready
id: 01a16581-e0c9-70fe-a9a0-7525d5ef8f23
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-22 }
tags: [kit, scriptorium]
parent: feature/workspace-kit-follow-ups
from: cycle/2026-10-cutover
cycle: 2026-10-polish
---

# Links and drop highlights are violet on Scriptorium's warm themes

Cole, in his cutover trial (2026-10-22): links in a rendered document are
purple, and dragging an item in the left sidebar shows a purple overlay. Both of
Scriptorium's themes are warm (cream in light, dark brown in dark), and the
violet doesn't belong.

The kit's `--color-brand` is violet (`src/kit/theme/base.css`, mind-mapper's
thread tier). Scriptorium's `surface/kit/theme.css` maps `--color-primary` and
`--color-ring` to its rubric, but not `--color-brand`, which the kit uses
directly for links, drop targets and drop cursors, backlink hovers, the compare
gutter, chips and more. The shipped Scriptorium had no violet.

**The mockups** (2026-10-22, `link-colours.html` in the lead's scratchpad)
compared verdigris, bronze, olive, faded indigo, the rubric, and ink with a
rubric underline. Cole chose the last: the most manuscript-like and the least
loud, easier on the eyes over time, and still readable. The reference screenshot
of the violet is `~/Downloads/marker-mage-1792714983173.png`.

## Definition of done

- [ ] No violet shows on Scriptorium's kit surface in either theme.
- [ ] Rendered links are in the text's own ink with a scribe-red (rubric)
      underline (Cole's pick, 2026-10-22, from mockups), in light and dark. A
      hover thickens the underline.
- [ ] Every other `brand` use (drag-and-drop targets, the "agent listening" dot,
      backlink hovers, chips) takes the rubric or a neutral ink tint, whichever
      reads right in a browser, with no new colour added.
- [ ] Every other spell's `dist` and look are unchanged.
- [ ] Checked in a real browser, light and dark, beside screenshots of before.
