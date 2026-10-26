---
type: item
title: Links and drop highlights are violet on Scriptorium's warm themes
description:
  The kit's brand token is violet, and Scriptorium's theme maps primary to its
  rubric but not brand, so rendered links, drag-and-drop overlays and other
  brand uses show violet against the cream and dark-brown themes.
status: stable
lifecycle: done
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

- [x] No violet shows on Scriptorium's kit surface in either theme.
- [x] Rendered links are in the text's own ink with a scribe-red (rubric)
      underline (Cole's pick, 2026-10-22, from mockups), in light and dark. A
      hover thickens the underline.
- [x] Every other `brand` use (drag-and-drop targets, the "agent listening" dot,
      backlink hovers, chips) takes the rubric or a neutral ink tint, whichever
      reads right in a browser, with no new colour added.
- [x] Every other spell looks the same, and its JS is unchanged. Its CSS carries
      only the kit's hooked classes, which paint identical pixels.
- [x] Checked in a real browser, light and dark, beside screenshots of before.

## Done and verified

Two commits on `impl/scriptorium-violet-brand-off-theme-2`, from `cycle/polish`:

1. **"Scriptorium's links and brand uses leave the kit's violet"**, the held
   work (707ff9f3) picked over. Scriptorium's `styles.css` maps `--color-brand`
   and `--color-on-brand` onto the rubric twice: in its `@theme`, and again in
   its light block, because base.css's unlayered light block would otherwise put
   `#7c3aed` back. It sets the kit's two link hooks,
   `--color-link: var(--color-ink)` and
   `--color-link-underline: var(--color-rubric)`, and a hovered link's underline
   goes to 2px (`.md-prose a:hover`). Drop targets, the "agent listening" dot,
   hovers, buttons and the spinner stay rubric.
2. **Cole's colour picks (cycle ruling 7, `theme-colours.html`)** for the five
   places where the rubric read wrongly. Each is a kit hook with a fallback to
   what the kit drew before, and Scriptorium sets them on `:root`:

| Where                                | Pick                            | Dark (computed)                             | Light (computed)                            |
| ------------------------------------ | ------------------------------- | ------------------------------------------- | ------------------------------------------- |
| `stable` chip                        | added green, 15% tint           | text `rgb(127,156,106)`, tint `/0.15`       | text `rgb(78,112,64)`, tint `/0.15`         |
| Cmd-clicked rows                     | selected at 7%, 2px bar at 70%  | `rgba(128,152,192,.07)`, bar `/.7`          | `rgba(63,95,143,.07)`, bar `/.7`            |
| Compare change marks                 | ink-dim at 70%, full on hover   | `rgba(163,155,136,.7)` → `rgb(163,155,136)` | `rgba(107,98,80,.7)` → `rgb(107,98,80)`     |
| Find's current match                 | amber 55%, 2px ink underline    | amber `/.55`, underline `rgb(236,230,216)`  | amber `/.55`, underline `rgb(42,37,28)`     |
| Agent's flash (passage)              | amber wash, amber 2px underline | amber `/.34`, underline `rgb(226,169,75)`   | amber `/.34`, underline `rgb(154,98,18)`    |
| Agent's flash (row: compare, header) | amber wash, 3px amber left bar  | bar `rgb(226,169,75)`, tint amber `/.26`    | bar `rgb(154,98,18)`, tint amber `/.26`     |
| Human's chat bubble                  | surface, 1px edge ring          | `rgb(28,26,21)`, ring `rgb(54,49,38)`       | `rgb(251,248,242)`, ring `rgb(217,207,189)` |

Before (the `cycle/polish` tip) the same spots were violet or fuchsia: the chip,
ref rows, bubble and marks `#a78bfa`/`#7c3aed`, the find match and flashes
`#e879f9`/`#a21caf`. The open row stays `bg-selected/15` with weight 500, and
ordinary find matches stay amber at 26%.

**Deliberate choices:**

- **The kit's `pointed` hue is mapped to amber** (`@theme` and the light block),
  so the raw view's current match and flash, and anything else that reads
  `pointed`, are amber too and no fuchsia is reachable. The flash's wash is
  therefore the kit's own strength over amber: 34% on a passage, 26% on a row,
  where the pick said about 30%. It still stands out from find matches (26%, no
  line) by its 2px amber underline or bar.
- **A highlight can't take a box-shadow**, so a flashed passage gets a 2px amber
  underline where a row gets the 3px left bar. The raw view's current match
  keeps CodeMirror's outline shape, in ink.
- **The mixes are on `:root`, one `color-mix()` per rule, not in `@theme`.**
  Tailwind 4.3 rewrites a `color-mix()` on a theme colour into the dark
  palette's literal plus an `@supports` copy that keeps the `var()`, and keeps
  that copy only for the first such declaration in a rule (measured in @theme
  and in a plain rule). With several in one rule, light mode got dark values.
  The test pins the shipped sheet.

**Checked in a real browser**: Playwright Chromium on scratch homes
(`NODE_ENV=test`), light and dark, the `cycle/polish` tip and this branch,
driven with real mouse and keyboard: open by row click, Cmd-click two rows, type
and send a message, Cmd-F, and `show --quote` / `show --hunk` from the CLI for
the flashes. A sweep of every computed colour on the page (canvas round-trip,
hue 255°–330° flagged) found violet in three places before and none after, in
both themes. The built stylesheet has no `#a78bfa` or `#e879f9`. `#7c3aed` and
`#a21caf` survive only in base.css's light block, which Scriptorium's later
light block overrides. The built JS has none.

**Other spells look the same; their CSS carries only the hooked classes.** The
ref row and chat bubble live in `src/kit/context` and `src/kit/chat`, which
every base.css importer scans. So bounty, digestify, grapevine, imago and
mind-mapper each ship the hooked classes in place of `bg-brand/10`, and their
`index.html` changes with the CSS hash. Their JS is byte-identical, and so is
every other spell's `dist` (astrolabe, glamour, magpie). Drawn in Chromium with
each spell's before and after sheet, in both themes, the old and new classes
paint identical pixels, a left bar and an edge included. Scriptorium's sheet
with every hook unset (`initial`) paints the same pixels as the brand mixes the
kit drew before.

`src/scriptorium/surface/theme.test.ts` pins every pick, the `pointed` mapping,
one mix per rule, and the shipped sheet. `src/kit/theme/theme.test.ts` pins the
hooks: no kit sheet declares one, every read has a fallback, and each fallback
is the old value.

**Found, not fixed:** the Tailwind behaviour above already affects one rule.
`::highlight(scriptorium-note)` in Scriptorium's `styles.css` mixes twice, and
its underline ships only as the dark amber literal, in light too. Nothing paints
that highlight since the cutover (no source names it), so nothing shows. The
`scriptorium-note*` rules look dead, which may be worth a backlog item.

## Port-back notes

Each hook is optional: no kit sheet declares it, every read falls back to what
the kit drew before, and `THEME_HOOKS` in `src/kit/theme/index.ts` lists them. A
theme that sets none looks as it did. Story Studio's locations are at
`2b03dc34`, read with `git -C … grep/show`.

- **Links, `.md-prose a`** (ours: `src/kit/theme/document.css`; SS:
  `packages/kit/src/theme/base.css`, line 174): `--color-link` (the words, else
  the brand) and `--color-link-underline` (else `currentColor`).
- **Find's current match, `::highlight(find-current)`** (ours: `document.css`;
  SS: `base.css`, line 367): `--color-find-current` (the wash, else pointed at
  40%) and `--color-find-current-mark` (the underline, else pointed).
- **The flash, `::highlight(doc-flash)` and `[data-flash="on"]`** (ours:
  `document.css`; SS: `base.css`, lines 372 and 378, and the reduced-motion rule
  at 391): `--color-flash-mark`, else transparent. It is a 2px underline on a
  passage, and a 3px inset left bar on a flashed row: a second inset shadow in
  `kit-flash`'s frames and in the reduced-motion rule.
- **The raw view's `.cm-searchMatch-selected` and `.cm-flash`** (ours and SS:
  `src/kit/document/DocumentView.tsx`; SS line 231): the same three hooks, with
  the current match's outline in the mark colour.
- **The `stable` chip** (ours and SS: `document/FrontmatterHeader.tsx`;
  `STATUS_TONE.stable` is SS line 89): a new `stable` `ChipTone`, which
  `STATUS_TONE.stable` uses in place of `brand`. Its classes read
  `--color-status-stable` (the words, else the brand) and
  `--color-status-stable-tint` (else the brand at 12%).
- **A ref-selected tree row** (ours and SS: `context/EntryTree.tsx`; SS line
  1215): `--color-ref-row` (else the brand at 10%) and `--color-ref-row-bar` (a
  2px inset left shadow, else transparent). **A port also updates SS's
  `packages/kit/src/shell/WorkspaceShell.refs.test.tsx:310`**, which asserts
  `bg-brand/10` on that row, as ours now asserts
  `bg-[color:var(--color-ref-row,`.
- **The compare gutter's ticks** (ours and SS: `document/CompareView.tsx`; SS
  line 336): `--color-change-tick` (else the brand at 65%) and
  `--color-change-tick-hover` (else the brand). "-mark" names only a line
  (`find-current-mark`, `flash-mark`).
- **The human's chat message** (ours and SS: `chat/ChatMessageView.tsx`; SS line
  114): `--color-human-bubble` (else the brand at 10%) and
  `--color-human-bubble-edge` (a 1px inset ring, else transparent).

In Tailwind arbitrary values the defaults are written `in_oklab`, as Tailwind
compiles `bg-brand/10`, so the default's computed value is unchanged. A theme
that sets a mix as a hook should give each `color-mix()` its own rule (see
above).
