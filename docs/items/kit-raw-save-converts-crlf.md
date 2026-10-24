---
type: item
title: Saving after a raw edit turns a CRLF file into LF
description:
  Typing in the raw editor and saving rewrites a CRLF or mixed-ending file with
  LF endings throughout, because CodeMirror's doc joins lines with \n; a
  rendered-only edit keeps CRLF.
status: stable
lifecycle: ready
id: 01a16682-c980-74c1-9c75-f2092e214ed9
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-22 }
tags: [kit, document]
parent: feature/workspace-kit-follow-ups
from: cycle/2026-10-polish
priority: high
cycle: 2026-10-release-6
---

# Saving after a raw edit turns a CRLF file into LF

Measured by the CRLF-notes verifier (2026-10-23) on the base and on the fix,
with the same result on both. A 61-byte file with 6 CRLF endings came back as 57
bytes with 0 CRLF and 6 LF after typing " X" in the raw editor and pressing
Cmd-S. Each of these converts the whole file:

- a mixed-ending file;
- Enter in a CRLF file;
- Add link through the editor.

An Add link in the rendered view, then Save, keeps CRLF. The cause: CodeMirror's
`doc.toString()` joins lines with `\n`. A whole-file line-ending change on save
is a surprise in a git diff. It may also orphan notes whose quote holds `\r\n`.

## Definition of done

- [ ] Saving after a raw edit keeps the file's line endings: CRLF stays CRLF. A
      mixed file keeps the dominant ending, or each line's own, whichever is
      decided.
- [ ] Notes whose quote spans a line break still match after the save.
- [ ] Tested on CRLF, mixed and LF files, and checked in a real browser.
- [ ] Offered on kit-parity.
