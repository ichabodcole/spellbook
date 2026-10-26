---
type: item
title: Undo in a mixed-endings file changes a line's ending
description:
  Deleting a line break drops its ending mark with no history entry, so undo
  restores the break with the file's dominant ending instead of its own.
status: draft
lifecycle: ready
id: 01a17a85-0b9e-734c-9c78-77a6fe2dc015
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-26 }
parent: feature/workspace-kit-follow-ups
---

# Undo in a mixed-endings file changes a line's ending

Reported by Story Studio on the kit-parity grapevine channel (message 60,
2026-10-26), found while porting our line-ending fixes. Not yet reproduced here,
but our code has the shape they describe: `src/kit/document/lineEndings.ts`
keeps each break's ending as a mark, and nothing records a deleted mark in the
undo history.

In `one\r\ntwo\r\nthree\nfour\r\n`, backspace the LF after `three`, then undo
(Mod-Z). The break comes back unmarked, takes the file's dominant ending, and
reads back as `three\r\nfour`: a save then changes a line the human never
edited.

Story Studio's fix: `keepMarksInHistory` (through CodeMirror's
`invertedEffects`) and `restoreMarks` in their `lineEndings.ts`. They note that
an editor that keeps state through `toJSON({history})` / `fromJSON` drops those
effects; they now keep the live `EditorState`.

## Definition of done

- [ ] Deleting a line break and undoing it restores that break's own ending in a
      mixed-endings file, and a test pins the example above.
- [ ] Redo after that undo deletes the break again without changing any other
      line's ending.
