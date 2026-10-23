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
- [x] Rendered links are in the text's own ink with a scribe-red (rubric)
      underline (Cole's pick, 2026-10-22, from mockups), in light and dark. A
      hover thickens the underline.
- [x] Every other `brand` use (drag-and-drop targets, the "agent listening" dot,
      backlink hovers, chips) takes the rubric or a neutral ink tint, whichever
      reads right in a browser, with no new colour added.
- [x] Every other spell's `dist` and look are unchanged.
- [x] Checked in a real browser, light and dark, beside screenshots of before.

## Done and verified

The change is in commit "Scriptorium's links and brand uses leave the kit's
violet" on `impl/scriptorium-violet-brand-off-theme`. Scriptorium's `styles.css`
maps `--color-brand` and `--color-on-brand` onto the rubric twice: in its
`@theme`, and again in its light block, because base.css's unlayered light block
would otherwise put `#7c3aed` back. It also sets the kit's two new link hooks:
`--color-link: var(--color-ink)` and
`--color-link-underline: var(--color-rubric)`. A hovered link's underline goes
to 2px (`.md-prose a:hover`).

**Deliberate choice: rubric, not an ink tint, for drop targets.** The mockup's
card C tinted the drop row with ink. A token remap can give `brand` only one
value, though. Splitting drop targets from the dot and the hovers would mean new
class names in `src/kit/context`, which every spell's stylesheet scans, and that
would break the byte-identical `dist` rule. Rubric is also what the shipped
Scriptorium drew for drops (`bg-rubric/15 ring-rubric/50`) and for the `stable`
chip. In the browser it reads as an accent, not a warning, in both themes.

**Checked in a real browser**: Playwright Chromium on scratch homes, light and
dark, with before screenshots. Computed values:

| What                                            | Dark                                   | Light                                 |
| ----------------------------------------------- | -------------------------------------- | ------------------------------------- |
| Link text                                       | ink `rgb(236,230,216)`                 | ink `rgb(42,37,28)`                   |
| Link underline                                  | rubric `rgb(208,112,79)`, 2px on hover | rubric `rgb(168,67,42)`, 2px on hover |
| Drop row, "agent listening" dot, backlink hover | rubric                                 | rubric                                |

The built stylesheet has no `#a78bfa`. `#7c3aed` survives only in base.css's
light block, which a later Scriptorium light block overrides.
`src/scriptorium/surface/theme.test.ts` pins all of this, the shipped
stylesheet's cascade order included. Every other spell's `dist` is
byte-identical: the shasum of every `dist` file was taken before and after.

**Left open, the first box: `--color-pointed`.** Fuchsia `#e879f9` / `#a21caf`
is still on the page. The kit uses it for the current find match and the flash
when the agent points at a passage (`doc-flash`, `find-current`, compare
`data-flash`). It is not `brand`, and it is not violet strictly, but it is the
one purple-family hue left. Every warm token already means something nearby:

- attention is the find match;
- rubric is the pending note;
- selected is the selection.

Remapping it is a design call for Cole, not a token swap.

## Port-back notes

- **`src/kit/theme/document.css`, `.md-prose a`:** two optional hooks, declared
  by no kit sheet.
  - `color: var(--color-link, var(--color-brand))`
  - `text-decoration-color: var(--color-link-underline, currentColor)`

  With neither set, the computed style is what it was. Story Studio's rule is in
  `packages/kit/src/theme/base.css` (`.md-prose a`, at `2b03dc34`), with the
  same three declarations. The hooks let a theme set a link in its ink with an
  accent underline, without overriding the rule.
