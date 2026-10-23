---
type: item
title: A dropped file can be added where it already lives
description:
  Dropping a file on the context pane always asks where its copy should go;
  offer to add the original where it lives instead (as a listed document, or its
  folder as a set), which a browser drop can't name, so through the native
  picker preselected for that file.
status: draft
lifecycle: triage
id: 01a16627-61ce-7244-baf2-627b2b9340b6
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-22 }
tags: [kit, scriptorium]
parent: feature/workspace-kit-follow-ups
from: cycle/2026-10-polish
---

# A dropped file can be added where it already lives

Cole, 2026-10-22. He dragged a screenshot from his desktop onto Scriptorium's
context pane. The dialog asked where `<name>.png` should go: one of the current
sets or folders, or a new folder at a path. Most of the time he wants neither.
He wants the file brought in from where it already is, as a set if that's
needed, without choosing a destination.

**The constraint:** a browser drop hands the page the file's bytes and name,
never its path (`src/kit/workspace/picker.ts`, header). So the page can't know
where the dropped file lives, and copying it somewhere is all a plain drop can
do. The daemon's native picker returns a real path (the "Choose..." act).

**A likely shape (to confirm in design):** the drop dialog gets an "Add it from
where it is…" act. It opens the native file picker, ideally starting in the
folders a drop usually comes from (Desktop, Downloads). The chosen file is added
as a listed document (no copy), or its folder as a set, which is the same as
"Choose..." today. The copy-to-a-place path stays for when he wants a copy.

## Definition of done

- [ ] The drop dialog offers adding the original where it lives, and doing so
      adds the real file (no copy) as a listed document, with an option to add
      its folder as a set.
- [ ] Copying into a chosen place still works.
- [ ] The dialog says plainly why it asks (a browser can't see where a dropped
      file lives).
- [ ] Tested, checked in a real browser on macOS; offered on kit-parity.
