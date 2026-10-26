---
type: item
title: Notes in a CRLF file may land off by a character per line
description:
  The daemon's note offsets count each CRLF as two characters while the raw
  editor counts one, as reveals did before the broken-links item fixed them, so
  a note may paint late in a CRLF file.
status: stable
lifecycle: done
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

- [x] A note placed by the agent in a CRLF file paints on its own words in raw,
      rendered and split views, with a test.
- [x] Offered on kit-parity if the fix is in the kit. _(The fix is in the kit.
      Not offered yet: the lead offers on kit-parity. The Port-back notes below
      are what to offer.)_ Offered on kit-parity, message 48 (2026-10-23).

## Done and verified

Commit `ae35c6c5` on `impl/kit-doctor-and-crlf-notes` (from `cycle/polish`).

**Reproduced first, in Chromium** (Playwright, scratch homes, `NODE_ENV=test`).
The test file was a CRLF file. One note came from the agent's `note --quote`;
the other came from the human, who selected with the mouse and typed in the
Notes panel. Three faults showed, and the third one was not in this item's
description:

- **Raw view, the agent's note.** It painted late, by a character for each line
  above it: "t quote in it." in place of "the agent quote".
- **Raw view, the human's note.** It painted on the right words, but the editor
  sent its own count, so the daemon stored the wrong quote: "the target ph" in
  place of "target phrase". That stored quote is what the agent reads.
- **Rendered view.** A note after a soft line break inside a paragraph painted
  nowhere. The projection kept each `\r\n` in its plain text, but the page holds
  one `\n` (HTML parsing converts it), so the text runs stopped aligning.

**The fix.**

- **`DocumentView`** now uses the daemon's count at its edges, as its `reveal`
  and `flash` props already did:
  - placed notes and the pending note come in through `editorOffset`;
  - the selection (`onSelect`) and the right-click (`onContextMenu`, including
    which notes are under the pointer) go out through `daemonOffset`, its new
    inverse.
- **`DocumentPane`'s Add link from the right-click** converts back to the
  editor's count before it touches the editor.
- **`projection.ts`** writes each `\r\n` as one `\n`. It finds the lines of a
  CRLF paragraph exactly, as it already did for a wrapped list item.

An LF file is untouched: every mapping returns early when there is no `\r`.

**Checked again in Chromium after the fix,** on a new scratch session. There
were four notes: two from the agent and two from the human, one made in raw and
one in rendered. All four painted on their words in raw, rendered and split. The
daemon stored the quotes that were chosen.

**Tests.**

- `DocumentView.crlf.test.tsx`:
  - `daemonOffset` round-trips;
  - placed notes paint on their words;
  - the pending note paints on its words;
  - the selection and the right-click report in the daemon's count, and the
    right-click finds the note under the pointer.
- `projection.test.ts`: a CRLF file projects to the LF file's plain text, its
  runs align, and a passage after a soft break maps both ways.
- `DocumentPane.linkInsert.test.tsx`: Add link from the right-click in a CRLF
  file wraps the words that were selected.

**Mutation checks.** Each of these was planted on its own, and each turned a
test red:

- dropping the conversion of notes;
- dropping the conversion of the pending note;
- dropping the conversion of the selection;
- dropping the conversion of the right-click range;
- dropping the conversion of the right-click position;
- making `daemonOffset` the identity;
- dropping the pane's conversion back for Add link;
- dropping the projection's `\r\n` handling, in `emit` and in `emitText`.

## Port-back notes

- **`document/DocumentView.tsx`:**
  - **New export: `daemonOffset(text, pos)`,** the inverse of `editorOffset`.
  - **New private helper: `notesInEditor`,** used by both `setNotes` dispatches.
  - The `pendingNote` effect maps through `editorOffset`.
  - `onSelect`'s `from`/`to` and `onContextMenu`'s `from`/`to` (and its
    `noteIds` hit test) are in the daemon's count. **This changes the contract
    of those callbacks:** a caller that used them as editor positions must map
    them back with `editorOffset`.
  - `textRef` moved up beside `notesRef`.
- **`document/DocumentPane.tsx`:** `askLinkAt` maps `at.from`/`at.to` through
  `editorOffset(shown, …)` before it uses the editor handle.
- **`document/projection.ts`:** `emit` and `emitText` treat `\r\n` as one `\n`.
- **Not touched:** typing in the raw editor of a CRLF file. CodeMirror's
  `doc.toString()` joins lines with `\n`, so an edit there may turn the file's
  line endings to LF. This was outside the item, and was not measured.
