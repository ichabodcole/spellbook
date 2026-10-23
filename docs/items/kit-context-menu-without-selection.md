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
(d6d02ee3), on `impl/kit-document-pane-menu-rebased`, one commit over
`cycle/polish` that folds in the verifier's round below and keeps implementer
E's CRLF conversions.

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

### After the verifier's round

The no-stake verifier confirmed the item and found two gaps. Both fixes are
folded into the same commit.

- **A right-click on a link in the rendered view now goes to the browser's
  menu.** That keeps the browser's link entries (open in a new tab, copy the
  address), as images already did. Before, "Insert a link" there wrote one link
  inside another (`[link t[x](…)o b](…)`).
- **Raw view, caret or selection inside an existing link.** "Insert a link" or
  "Add link" is disabled, with the reason on hover ("not here").
  - The ⌘⇧K shortcut refuses the same way, with a "Can't link here" toast. The
    shortcut nested on base too.
  - A caret at either edge of a link is outside it.
  - The check is `insideLinkProblem`.
- **A menu with nothing usable now leaves the event to the browser.** In an
  ended session with only a caret, both views now give the browser's menu.
  - The raw editor now asks on right-click when read-only, too. Before, its
    context-menu handler was registered only when editable, so the two views
    disagreed.
  - Over a selection in an ended session, the menu shows Copy and a disabled Add
    note ("session ended"). Base enabled Add note there.
- New tests for the four mutations that survived:
  - Paste and Cut record `input.paste` and `delete.cut`.
  - A second Ctrl-click lets the browser's menu through.
  - The Link text field is absent over a selection.
  - The frontmatter mark clears after its moment.
- Re-checked in a real browser:
  - A right-click on the rendered link was left to the browser.
  - In raw, inside `[the bakery]`, the link act is disabled with its reason, and
    ⌘⇧K shows the toast and leaves the text alone.
  - In an ended session with a caret, both views leave the event to the browser.
    Over a selection, both show Copy and a disabled Add note.
  - The round-one checks still pass.

Not done: the verifier's nit that the build's `--kit-flash-tint` fallback is the
dark hex in both themes. The fallback is only used by a browser without
`color-mix()`; every modern one takes the `@supports` copy, which follows the
theme. A light-only fallback would mean a fixed colour in `document.css`, which
the theme test forbids. Every other `color-mix()` in the kit's sheets has the
same dark-only fallback.

### Rebased onto the CRLF fix

Implementer E's CRLF fix landed first on `cycle/polish`. It converts the raw
view's right-click and selection offsets to the daemon's count, which counts
each `\r\n` as two characters (`daemonOffset`).

The rebased menu keeps those conversions at the view's edge:

- The menu's offsets are in the daemon's count from both views.
- Cut and Paste convert them to the editor's count with `editorOffset` before
  touching the editor.
- The link check (`insideLinkProblem`) reads them against `shown`, the daemon's
  text, so the offsets and the text share one count.
- E's `DocumentView.crlf.test.tsx` passes unchanged except for one callback,
  which now returns a boolean to match the new `ContextMenuRequest` type.

New tests on a CRLF file:

- "Insert a link" at a caret after a CRLF line lands at the caret.
- Cut and Paste across a CRLF line take out and put back exactly the selection.
- Add note over a selection spanning a CRLF line anchors on the words selected.
- A caret inside a link after CRLF lines turns the link act off; a caret just
  past the link leaves it on.

Three mutants each turned red: skipping the edits' conversion, reading the link
check in the editor's count, and reporting editor offsets from the raw view.

Real-browser check on `c-crlf.md` (CRLF) and `a.md` (LF):

- Insert a link, Cut, and Paste back all land where they should.
- In the untouched CRLF file, a note across the line break is stored at daemon
  offsets 11–26, which read `line here.\r\nAno` in the file.
- A caret inside `[crlf ghost]` turns the link act off.

One thing seen, not fixed here, and probably one of E's filed line-ending
findings: after the first edit through the raw editor, the CRLF file's text
comes back with LF endings.

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
- `document/linkInsert.ts`: new `insideLinkProblem(text, from, to)`, used by the
  pane for the shortcut, the menu and the rendered view. `MarkdownView` leaves a
  right-click on a link to the browser. The raw view's context-menu handler is
  registered whether or not the editor is editable. `NoteAtSelection` takes
  `linkRefusal` and `noteRefusal`. The pane opens no menu without a usable act.
- `document/LinkPicker.tsx`: a "Link text" field when `kind === "wrap"` and
  there is no quote. `onChoose` gains a fourth `label` argument.
- `document/linkInsert.ts`: `linkInsertion` takes an optional `label`, which
  wins over the name and the heading text when there is no selection.
