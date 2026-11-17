---
type: item
title: "Scriptorium: Tab leaves the editor instead of indenting"
description:
  "GitHub #144: in 5.1.0 the editable keymap had no Tab binding, so Tab moved
  focus out; develop's kit DocumentView.tsx appends indentWithTab, shipped in
  6.0.0."
status: draft
lifecycle: dropped
id: 01a1eabe-f393-71bf-99d5-20093d99f42a
kind: bug
generated: { by: claude-opus-5-5, at: 2026-11-17 }
tags: [kit, scriptorium, editor]
parent: feature/workspace-kit-follow-ups
source: "#144"
---

# Scriptorium: Tab leaves the editor instead of indenting

Filed as GitHub #144, seen in the 5.1.0 bundle. Tab in the markdown editor moved
focus to the next control instead of indenting; Shift-Tab moved it back. The
editable keymap was `[Mod-s, ...historyKeymap, ...defaultKeymap]`, and
`defaultKeymap` binds neither key.

Story Studio's fix (`704744a`) appends `indentWithTab` after `defaultKeymap`, in
the editable keymap only. A keyboard user leaves with Escape, then Tab.

Develop appears to have it. `src/kit/document/DocumentView.tsx` appends
`indentWithTab` (from the document pane port, `a0b3d793`, in 6.0.0), and
`DocumentView.tab.test.tsx` exists. Not checked in Scriptorium's browser yet.
The issue also asks to check that no window-level handler in Scriptorium
swallows Escape before CodeMirror sees it.

**Dropped on filing (2026-11-17):** a check found GitHub #144 already
implemented in spellbook 6.0.0, so the issue was closed with the evidence and
there is nothing to do here.

## Definition of done

- [ ] Tab indents and keeps focus, Shift-Tab outdents, Escape then Tab leaves,
      and read-only leaves Tab alone. Tested.
- [ ] No window-level Escape handler in Scriptorium gets in the way, checked in
      a real browser.
- [ ] #144 answered and closed once released.
