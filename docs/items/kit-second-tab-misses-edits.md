---
type: item
title: A second tab doesn't see edits typed in the first
description:
  On the kit daemon, an edit in one tab never reaches another tab on the same
  session (editActive sends no version.text to other sockets); the shipped
  Scriptorium shows it within 500 ms.
status: stable
lifecycle: triage
id: 01a14e5f-1882-73d8-95fd-3bf540bd4a9f
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-18 }
tags: [kit, scriptorium]
parent: feature/workspace-kit
from: 01a14dc5-6f94-7529-ac57-306dea4e021a
---

# A second tab doesn't see edits typed in the first

Found by the `scriptorium-kit-document-centre` verifier on 2026-10-18. With
`SCRIPTORIUM_KIT=1`, a document is open in two tabs on the same session. Tab 2
types an edit, and tab 1, in rendered view, never shows it, even after 5 s. The
shipped Scriptorium shows it within 500 ms.

The cause is in the kit daemon. `editActive` (`src/kit/workspace/server.ts`,
around line 3097) sends no `version.text` to the other sockets. When both tabs
edit in raw, the last writer wins on both surfaces, so this loses no data that
the shipped app doesn't already lose. It is a regression in what the human sees,
though, and it should be fixed before the cutover.

## Definition of done

- [ ] An edit typed in one tab reaches every other tab on the session that shows
      that version, and a test pins it.
- [ ] A tab doesn't receive its own edit back as an outside change.
- [ ] The change is generic, and it is offered on kit-parity.
