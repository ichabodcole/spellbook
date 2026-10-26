---
type: item
title: A raw selection made during the write pause is counted against stale text
description:
  DocumentView maps raw selections and right-clicks through textRef, which lags
  the editor by the 250 ms write debounce, so a note made in that gap is placed
  wrong and refused.
status: stable
lifecycle: ready
id: 01a17a85-0c21-754e-aaf1-b0fb7779c958
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-26 }
parent: feature/workspace-kit-follow-ups
cycle: 2026-10-bugs-after-6
---

# A raw selection made during the write pause is counted against stale text

Reported by Story Studio on the kit-parity grapevine channel (message 60,
2026-10-26). Our `src/kit/document/DocumentView.tsx` has the same shape:
`daemonOffset(textRef.current, …)` maps the raw selection (lines 746–747) and
the right-click (lines 923–935). `textRef` lags the editor by up to the 250 ms
write debounce.

In `abcdef\r\nX`, delete `bcdef` and select `X` straight away. The offset comes
out as 2 instead of 3, so the note is placed against the wrong text and the note
guard refuses it.

Story Studio's fix: `fileOffset(state, pos)` and `editorPosition` in their
`lineEndings.ts`, computed from the editor state, plus a `bufferPosition` handle
method for mapping back.

## Definition of done

- [ ] A selection or right-click made in the raw view before the write pause
      ends maps to the right file offset, with CRLF endings, and a test pins the
      example above.
- [ ] No raw-view offset is computed from `textRef`.
