---
type: item
title: Right-click with no selection opens our menu, with Insert a link
description:
  With text selected, right-click opens the kit's menu (link, note); with only a
  caret it falls through to the browser's native menu. Open the kit's menu
  either way, and with no selection offer inserting a link (label and target) at
  the caret.
status: draft
lifecycle: triage
id: 01a16587-e5ec-7297-90ba-61a8a49eb7d6
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-22 }
tags: [kit, scriptorium]
parent: feature/workspace-kit-follow-ups
from: cycle/2026-10-cutover
---

# Right-click with no selection opens our menu, with Insert a link

Cole, in his cutover trial (2026-10-22): selecting text and right-clicking opens
the kit's own menu (add a link, add a note), but right-clicking with only a
caret opens the browser's native menu. Switching between the two by whether
something is selected feels inconsistent. A link can go anywhere; a note needs a
passage. Not a regression: the shipped app behaves the same.

## Definition of done

- [ ] Right-click in a document opens the kit's menu whether or not text is
      selected.
- [ ] With no selection, the menu offers inserting a link at the caret, taking
      both the label and the target (the link picker); "Add a note" is absent or
      disabled with a reason, since a note needs a passage.
- [ ] With a selection, the menu is as it is today.
- [ ] The menu carries the basic edits the native menu gave: Cut, Copy and Paste
      (Cut and Copy only with a selection), and the keyboard shortcuts still
      work (Cole, 2026-10-22).
- [ ] Tested, checked in a real browser in raw, rendered and split; offered on
      kit-parity.
