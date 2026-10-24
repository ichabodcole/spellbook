---
type: item
title:
  Opening a link's place misses frontmatter in rendered view and collapses the
  selection
description:
  Opening a broken frontmatter reference at its place highlights nothing in
  rendered view, and a cross-document open collapses the selection to the link's
  end in raw and split.
status: stable
lifecycle: done
id: 01a157b0-882a-76ca-a864-ff5e8a1e46d6
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-19 }
tags: [kit, document]
parent: feature/workspace-kit-follow-ups
from: cycle/2026-10-shell
cycle: 2026-10-polish
---

# Opening a link's place misses frontmatter in rendered view and collapses the selection

Found by the `kit-broken-links-visible` verifier on 2026-10-20, on the flagged
Scriptorium. Neither is caused by that item; both sit in the pane's general
`openAt` path, which the link check's list now uses for every entry.

- **Rendered view, frontmatter:** opening a broken frontmatter reference (for
  example `related: [./ghost.md]` on `d-block.md`) opens the document but shows
  nothing at the reference. The field strip is not highlighted. Body links and
  leaving links do highlight in rendered view.
- **Raw and split, cross-document:** opening a link in another document
  reproducibly collapses the selection to the link's end. The line is right. The
  older "missing heading" entry does the same.

## Definition of done

- [x] In rendered view, opening a frontmatter reference highlights its field in
      the header strip.
- [x] A cross-document open selects the link's whole range in raw and split.
- [x] Both are tested, and offered on kit-parity. (Tested; the offer is the
      lead's, from the port-back notes below.) Offered on kit-parity, message 48
      (2026-10-23).

## Done and verified

`fix(kit): opening a link's place marks a frontmatter field and keeps the selection`
(7afc8dcc on `cycle/polish`; first made as 7b13433d on
`impl/kit-document-pane-menu-reveal`).

Reproduced first, in a real browser (Playwright Chromium) on a scratch
Scriptorium, through the link check's list:

- **Frontmatter, rendered:** reproduced as filed. Nothing was marked.
- **Cross-document, raw and split:** it reproduces only when a passage is held
  in the document you leave. Opening another document clears that held selection
  in the same render as the reveal. The clear's effect ran after the reveal's
  and collapsed the range to its head, which is the link's end. With nothing
  held, the whole range was selected already.

The fixes:

- `frontmatterKeyAt` names the key whose entry holds the offset. The header
  marks that field with the kit's `data-flash` mark and scrolls it into view.
  The field can be a chip, a row, the description or the tags. On a delimiter,
  or for a key the header doesn't show (`title`), the whole header is marked.
- A reveal now spends the clear that came in the same render. A clear on its own
  still collapses the selection.
- **Found on the way, outside the item:** the `data-flash` mark never showed in
  any built surface. The build rewrites `color-mix()` into a fallback plus an
  `@supports` copy, and a keyframe can't hold that, so it dropped kit-flash's
  tinted frame. The compare view's change flash was invisible for the same
  reason. The tint now lives in a custom property that the keyframe reads, and a
  theme test refuses a `color-mix()` inside a keyframe. This touches
  `src/kit/theme/document.css`, which is implementer A's file.

Verified after the fix in a real browser:

- Every link-check entry, opened from `b.md` with a passage held there, selects
  its whole link in raw and in split. That covers a body link, a CRLF file, a
  frontmatter `related:` value and a missing heading.
- `d-block.md`'s `related` row is visibly tinted in rendered view, whether the
  document was already open or not.

Each new test was mutation-checked: the planted regression turned it red, and
the restore was byte-equal.

## Port-back notes

- `document/frontmatter.ts`: new `frontmatterKeyAt(text, offset)`. Pure.
- `document/FrontmatterHeader.tsx`: the description, tags and each row's
  `dt`/`dd` carry `data-field="<key>"`. New `headerFieldElements(header, key)`.
- `document/MarkdownView.tsx`: a flash inside the frontmatter marks the header
  field (`data-flash="on"`, for the flash's moment) instead of painting the
  body.
- `document/DocumentView.tsx`: the reveal effect records the current `clearSeq`
  as spent, so a clear in the same render does not collapse the reveal. Story
  Studio has the same two effects in the same order, so it has the same bug.
- `theme/document.css`: `[data-flash="on"]` sets `--kit-flash-tint`, and the
  keyframe reads it. Worth checking whether Story Studio's build drops the frame
  too.
