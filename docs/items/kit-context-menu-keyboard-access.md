---
type: item
title: The document's context menu can't be reached or driven by keyboard
description:
  The kit's right-click menu has no role=menu, takes no arrow keys, and focus
  stays in the editor (Tab types a tab); Shift+F10 and the ContextMenu key don't
  open it on macOS Chromium. Present on base too.
status: draft
lifecycle: triage
id: 01a166b3-254a-77dd-905c-cbbe0d281b6e
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-22 }
tags: [kit, document, accessibility]
parent: feature/workspace-kit-follow-ups
from: cycle/2026-10-polish
---

# The document's context menu can't be reached or driven by keyboard

Found by the verifier of
[kit-context-menu-without-selection](kit-context-menu-without-selection.md)
(2026-10-23). It happens on base too:

- Once open, the menu has no `role=menu` and takes no arrow keys.
- Focus stays in the editor, so ArrowDown moves the caret and Tab types a tab
  into the document. Escape does close the menu.
- On macOS Chromium, Shift+F10 and the ContextMenu key fire no `contextmenu`
  event, so the menu can't be opened from the keyboard at all. Windows and Linux
  weren't checked.

## Definition of done

- [ ] The menu is a `role=menu` with `menuitem`s: focus moves into it when it
      opens, arrows move between items, Enter acts, and Escape returns focus to
      where it was.
- [ ] A keyboard shortcut opens it at the caret on every platform; the shortcut
      is decided and documented.
- [ ] Tested; checked with the accessibility tree in a real browser.
