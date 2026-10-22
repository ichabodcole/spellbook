---
type: item
title: Long text overflows the End session dialog
description:
  When the human ends a session, the dialog's long content (the restore command
  with its CLI path) runs past the dialog's edge instead of wrapping inside it.
status: stable
lifecycle: done
id: 01a1658c-602a-7138-97cc-ea2c7c22cf0f
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-22 }
tags: [kit, shell]
parent: feature/workspace-kit
from: cycle/2026-10-cutover
cycle: 2026-10-cutover
---

# Long text overflows the End session dialog

Cole, in his cutover trial (2026-10-22): ending a session opens the dialog that
names the session and gives the command to bring it back. With a long CLI path
in that command, the content runs past the dialog's edge instead of wrapping
inside it. Probably not a regression.

The command itself already has `break-all whitespace-pre-wrap`
(`src/kit/shell/SessionEnd.tsx`, `data-slot="restore-command"`), so the overflow
likely comes from a parent that won't shrink (a flex or grid child without
`min-w-0`) or from another line in the dialog. Find it in a real browser before
fixing.

## Definition of done

- [x] With a very long restore command, session id and path, every part of the
      End session dialog stays inside the dialog, in both the confirm and the
      ended states, at desktop and narrow widths.
- [x] A test pins it, checked in a real browser; offered on kit-parity.
      _(Offered on kit-parity, message 47, 2026-10-22.)_

## Done and verified

Fixed on `impl/kit-session-end-dialog-overflow` in the kit commit
`fix(kit): long text wraps inside the End session dialog`.

- **The culprit was the question, not the command block.** In the confirm state,
  `DialogDescription` says "it can be reopened with {command}" as plain prose. A
  long CLI path with no hyphens is one unbreakable word there. The dialog is a
  `grid` with no column template, and its implicit column grows to its widest
  child's min-content. One word about 2,600 px wide stretched every row: the
  title, the question, the warning and the button row. In a real Chromium, the
  dialog's `scrollWidth` was 3,032 against a `clientWidth` of 382 (1280 px) or
  446 (480 px), in light and dark. End session sat about 2,600 px off screen and
  could not be clicked with the mouse. The ended state and the chip's popover
  held, because their command is the `break-all` `<code>`. Hyphens hide the bug:
  a path with hyphens breaks at them and stays inside.
- **The fix, in `src/kit/shell/SessionEnd.tsx`.** Two exported class constants
  are applied to every place long text can reach. `FIT`
  (`grid-cols-[minmax(0,1fr)]`) goes on every grid: the dialog, the ended
  description, `EndedDetails` and the popover. It stops one column from growing
  past its box. `WRAP` (`wrap-anywhere`) goes on every line of text: the title
  (which also gets `pr-6`, clear of the close button), the question, the
  warning, the notice and the ended sentence. It breaks inside a long token only
  when the token would not fit. The button row also gets `flex-wrap`.
  `break-all` stays on the command block.
- **The test is `src/kit/shell/SessionEnd.test.tsx`, with 5 tests.** It covers
  confirm, ending, ended, `EndedDetails` and the chip's popover, using a long
  path, a long session id, a long warning and a long notice. Its check is
  generic: every grid in the dialog must have `FIT`, and every text node outside
  a button must sit under an element with `wrap-anywhere` or `break-all`. A line
  added later without a wrap fails it. I planted six regressions, and each one
  failed the test: the question without `WRAP`, an empty `FIT`, an empty `WRAP`,
  the warning without `WRAP`, the popover without `FIT`, and the command without
  `break-all`.
- **Checked in a real browser.** I used Playwright Chromium on scratch homes,
  with the skill copied into an 8-level nested directory and a document with a
  180-character name made unsaved, so that the real warning shows. I checked
  1280 px and 480 px, in light and dark. In both the confirm and the ended
  states, and in the popover, no element extends past the dialog's content box.
  I also added a clone of the title holding a 160-character session id, and it
  stayed inside too. End session is now clickable with the real mouse.
- **Second round, after the no-stake verifier passed it.** The kit commit
  `fix(kit): the End session dialog fits a short window, and the popover is checked whole`
  adds three things:
  - **Height.** With a long path and the warning, the confirm dialog is 758 px
    tall. In a 420×560 window it ran from −100 to 660 px, so its title and
    buttons were cut off and a click on End session landed on the overlay.
    `TALL` (`max-h-[calc(100dvh-2rem)] overflow-y-auto`) on `DialogContent` caps
    it at 16 to 544 px, and the dialog scrolls inside. In Chromium at 420×560,
    in light and dark, the real mouse now clicks End session.
  - **Popover title.** `PopoverTitle` gets `WRAP`.
  - **Popover test.** The popover test now runs the generic check over the whole
    popover, not just `EndedDetails`.
  - **Mutation checks.** Five more regressions, each planted and each failing
    the test:
    - a new unwrapped line after `PopoverTitle`;
    - `PopoverTitle` showing `{command}`;
    - `PopoverTitle` without `WRAP`;
    - an empty `TALL`;
    - `TALL` left off the dialog.

  I re-ran the 1280 and 480 px checks at 800 px high, in light and dark. Nothing
  overflows, and every confirm uses the real mouse. The test now has 6 tests.
  Its header says what it cannot see: it checks classes, not layout, so a
  `whitespace-nowrap`, a minimum width, or long text inside a button can still
  get past it.

A separate finding is left alone: at 1280 px the dialog is 384 px wide, not the
`sm:max-w-md` it asks for. `DialogContent`'s own `sm:max-w-sm` wins. Its
`size="md"` prop is the kit's way to get the wider dialog. That is a design
choice, not part of this bug.

The second box is still open. Its test and its browser check are done. All that
remains is to offer the change on kit-parity, which is the lead's to do.

## Port-back notes

Story Studio's `packages/kit/src/shell/SessionEnd.tsx` has the same bug, from
the same structure: a `grid` dialog with no column template, and a confirm
description that says `{command}` as prose. The fix carries over unchanged.
Story Studio's file is not the same as ours was, though, so the test needs
adapting.

- **`SessionEnd.tsx`.**
  - New exports: `FIT`, `WRAP` and `TALL`.
  - `FIT` goes on `DialogContent`, the ended `DialogDescription`, `EndedDetails`
    and `PopoverContent`.
  - `TALL` goes on `DialogContent`.
  - `WRAP` goes on both dialog titles, `PopoverTitle`, the confirm description,
    `end-notice` and `EndedMessage`'s sentence.
  - `pr-6` goes on the confirm title.
  - `flex-wrap` goes on the button row.
  - A header comment says why.
  - Story Studio has no `end-warning`, so that line has nothing to port.
- **`SessionEnd.test.tsx`.** It has no app names in it, and needs Tailwind v4.1
  or later for `wrap-anywhere`. Four adaptations:
  - Story Studio's `SessionEndDialog` takes `title` (the project's title), not
    `sessionId`. Pass a long `title` and assert it, in place of `LONG_ID`.
  - It has no `warning` prop. Drop `warning={WARNING}` and the `end-warning`
    assertion.
  - Its wording is about projects: "Close {title}?", "Project closed",
    "Closing…", "Close project" and the chip's "Closed". The test matches no
    wording, only `data-slot`s, which are the same (`session-end-dialog`,
    `restore-command`, `end-notice`, `session-ended-details`, `ended-chip`,
    `ended-popover`). So nothing else changes, but check this if Story Studio
    renames a slot.
  - Its `EndedDetails`, `EndedChip` and `PopoverTitle` are shaped like ours, so
    the popover tests carry over as they are. Its `lib/registerDom.ts` and
    `lib/testDom.ts` are at the same relative paths, so the imports hold.
