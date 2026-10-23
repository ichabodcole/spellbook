---
type: item
title: Right-click with no selection opens our menu, with Insert a link
description:
  With text selected, right-click opens the kit's menu (link, note); with only a
  caret it falls through to the browser's native menu. Open the kit's menu
  either way, and with no selection offer inserting a link (label and target) at
  the caret.
status: stable
lifecycle: ready
id: 01a16587-e5ec-7297-90ba-61a8a49eb7d6
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-22 }
tags: [kit, scriptorium]
parent: feature/workspace-kit-follow-ups
from: cycle/2026-10-cutover
cycle: 2026-10-polish
---

# Right-click with no selection opens our menu, with Insert a link

Cole, in his cutover trial (2026-10-22): selecting text and right-clicking opens
the kit's own menu (add a link, add a note), but right-clicking with only a
caret opens the browser's native menu. Switching between the two by whether
something is selected feels inconsistent. A link can go anywhere; a note needs a
passage. Not a regression: the shipped app behaves the same.

## Definition of done

- [x] Right-click in a document opens the kit's menu whether or not text is
      selected.
- [x] With no selection, the menu offers inserting a link at the caret, taking
      both the label and the target (the link picker); "Add a note" is absent or
      disabled with a reason, since a note needs a passage.
- [x] With a selection, the menu is as it is today.
- [x] The menu carries the basic edits the native menu gave: Cut, Copy and Paste
      (Cut and Copy only with a selection), and the keyboard shortcuts still
      work (Cole, 2026-10-22).
- [x] The native menu stays one gesture away (Cole, 2026-10-22: spell-check,
      translate and the OS's other entries matter). A page cannot open the
      native menu itself, so the native menu comes through two paths:
      right-clicking again while our menu is open, and Shift+right-click (or the
      platform's usual modifier). Our menu shows a footer line naming the
      gesture, such as "Right-click again for the browser menu".
- [ ] Tested, checked in a real browser in raw, rendered and split; offered on
      kit-parity. (Tested and checked; the offer is the lead's, from the
      port-back notes below.)

## Done and verified

`feat(kit): right-click always opens the document's menu, with Insert a link and the basic edits`
(deb0f493), on `impl/kit-document-pane-menu-reveal`.

Deliberate choices:

- **Add note is disabled, not hidden, with no selection.** It says why ("select
  text first", with the full reason on hover), so the act stays findable.
- **The rendered view has no caret.** With no selection there, Insert a link
  uses the point that was clicked. A click outside the text and outside any note
  still gets the browser's menu, because there is nowhere to place the act.
- **Insert a link** opens the existing picker, which now has a "Link text" field
  whenever there is no selection. That includes the shortcut pressed with only a
  caret. Left empty, the link's text is the document's name, as before.
- **Edits follow what the browser's menu offered.**
  - Raw editor, live session: Cut and Copy over a selection, and Paste.
  - Rendered view, which is read rather than typed in: Copy only, over a
    selection.
  - All of them go through the clipboard API. A cut or paste goes through the
    editor as the human's own edit, with one undo step.
  - If the browser refuses the clipboard, a toast says so and names the
    shortcut: "Couldn't paste. The browser did not let the page read the
    clipboard. ⌘V pastes as usual." A refused cut leaves the text alone.
- **The browser's menu.** A page can't open the native menu itself; it can only
  leave the event uncancelled.
  - A second right-click while our menu is open is left to the browser. This
    uses a capture-phase press recorded while the menu is open.
  - Shift-right-click goes straight to the browser's menu.
  - The footer reads "Right-click again for the browser menu", and its tooltip
    names Shift.
  - Side effect: Chrome's own right-click on macOS selects the word under the
    pointer, so after the browser's menu the next right-click usually finds a
    selection.

Checked in a real browser (Playwright Chromium, real mouse and keyboard, on a
scratch Scriptorium):

- **Raw:** with a caret, our menu opens with Insert a link, a disabled Add note,
  Paste and the footer. A second right-click and a Shift-right-click were not
  cancelled, and our menu closed. The third right-click opened ours again.
- **Insert a link:** wrote `[see B](./b.md)` at the caret.
- **Edits from the menu:** Copy, Paste and Cut each worked. ⌘V and ⌘Z still
  worked from the keyboard.
- **Rendered:** with no selection, Insert a link wrote a link at the point
  clicked. With a selection, the menu offered Add note, Add link and Copy, and
  Copy worked. The second-right-click and Shift paths passed through to the
  browser.
- **Split:** both halves open our menu, each with its own edits, and a second
  right-click passes through.
- **Clipboard refused:** in a context without clipboard permission, Paste showed
  the "Couldn't paste" toast.

Each new test was mutation-checked: six planted regressions, all turned red, all
restored byte-equal.

## Port-back notes

- `chat/NoteAtSelection.tsx`:
  - The menu opens for an empty range too. It shows Insert a link (`onAddLink`
    with `from === to`) and a disabled Add note that gives its reason.
  - New optional `edits` prop (`MenuEdits`: cut, copy, paste).
  - A footer line with the native-menu hint, exported as `NATIVE_MENU_HINT`.
- `document/DocumentView.tsx`:
  - `onContextMenu` is now `ContextMenuRequest`, which is exported. It receives
    `{ shiftKey }` and can return `false` to leave the event to the browser.
  - The raw view asks on every right-click.
  - `EditorHandle.replaceRange` takes an optional `userEvent` (default
    `"input.link"`).
- `document/MarkdownView.tsx`: asks on every right-click, too. With no
  selection, the point under the pointer stands in as the caret.
- `document/DocumentPane.tsx`:
  - `openMenu(via)` handles the native passthrough: Shift, or a context press
    recorded in the capture phase while the menu is open.
  - `menuEdits` builds the edits on the clipboard API, with toasts when the
    clipboard is refused.
- `document/LinkPicker.tsx`: a "Link text" field when `kind === "wrap"` and
  there is no quote. `onChoose` gains a fourth `label` argument.
- `document/linkInsert.ts`: `linkInsertion` takes an optional `label`, which
  wins over the name and the heading text when there is no selection.
