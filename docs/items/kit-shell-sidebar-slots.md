---
type: item
title: The shell passes the context pane's slots through
description:
  WorkspaceShell threads askLocation, beforeMove and uncheckedMoveNote, the
  refusal hint and Notes' addUnavailable to the panes, so an app on the shell
  keeps the slots the panes cycle added.
status: stable
lifecycle: done
id: 01a15621-4cbc-7631-993b-c7f56626f53c
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-19 }
tags: [kit, shell]
parent: feature/workspace-kit
blocked_by: [01a15621-4526-739e-9a62-6a499cfa8561]
cycle: 2026-10-shell
---

# The shell passes the context pane's slots through

The panes cycle gave our `ContextSidebar` and Notes slots that Story Studio's
shell doesn't pass: `askLocation`, `beforeMove` with `beforeMoveTimeoutMs` and
`uncheckedMoveNote`, the refusal `notice` (the "To go on: …" hint), and Notes'
`addUnavailable`. An app on the shell would lose them, and Scriptorium needs
every one: it has no home workspace, and its move plan confirms through
`beforeMove`.

## Definition of done

- [x] `WorkspaceShell` takes each slot as an optional prop and hands it to the
      pane, unchanged.
- [x] A test shows each one reaching its pane through the shell. _(Offered on
      kit-parity, message 46, 2026-10-20.)_
- [x] Without them, the shell behaves as Story Studio's does.
- [x] Offered on kit-parity together with the slots themselves.

## Done and verified

`3e3ad9dd` (on `impl/kit-shell-sidebar-slots`, from the shell port at
`4e3c90ba`) adds the slots to `WorkspaceShell` and
`WorkspaceShell.slots.test.tsx`. That test runs over a real daemon in the
happy-dom harness. For each slot, it checks the slot reaching its pane and the
shell's behaviour without it. Planted regressions turned it red: each
pass-through dropped in turn, the notice rule forced either way, and the fixes
the verifier asked for (below). Only one survives, the owned refusal toasted
with the column open. The stand-in toast is dismissed in the same effect flush,
because the column is open, so nothing is ever shown.

Choices:

- **Names.** Two slots are renamed at the shell, where the bare name would be
  ambiguous. Notes' `addUnavailable` is `notesAddUnavailable`. The
  outside-change toast's `onShowDiff` is `onShowOutsideDiff`, because the shell
  already has an `onShowDiff` for the new-version toast. Like that one, it hands
  the app the `DocView`, not the slug. The others keep the sidebar's names.
- **One refusal, one place.** The shell toasts `lastError` and clears it.
  - If an app gives `notice` (even `null`), it owns the daemon's refusals. The
    shell then neither toasts them nor clears `lastError`, and the app's
    `onDismissNotice` (usually `daemon.clearError`) lets a refusal go. So a
    refusal is never both a toast and a notice, and the notice is not cleared
    under the app's feet.
  - **The human always sees a refusal (the lead's ruling).** While the context
    column is collapsed, its notice is out of sight. So the shell also toasts an
    owned refusal, under its title (`lastErrorTitle`, such as "That link didn't
    open"), and still leaves `lastError` for the app to clear. With the column
    open, the notice alone shows it. The toast follows the column's state when
    the refusal arrives. A refusal shown while the column is open is not toasted
    again if the human then collapses the column.
  - **The stand-in toast goes when the notice comes into sight.** The shell
    keeps the toast's id, and dismisses it when the column reopens or when
    `lastError` clears. Without that, a reopened column showed the refusal twice
    for the toast's 5 s life.
  - **Not done: re-toasting the same refusal repeated while collapsed** after
    its toast expired. The daemon client keeps a refusal as its text alone
    (`lastError`), so an identical repeat changes nothing that the shell can
    see. Telling the repeat apart needs a per-refusal sequence in
    `context/daemonClient.ts`, a neighbour module with its own port-back. That
    belongs to a separate item, not this one. Meanwhile, the refusal still
    stands in the notice, which reopening the column shows.
  - The notice itself is a string. An app that wants the title in it reads
    `daemon.lastErrorTitle`, as the `notice` prop's doc says.
  - The session-ended message stays the shell's own toast, with its burst guard.
    Accepted: for one render, before the shell clears it, an app that derives
    its notice from `lastError` passes "session ended" through the notice too.
  - Without `notice`, the shell toasts every refusal, as before.
- **`askLocation` needs its dialog rendered.** The app renders
  `useAskLocation().dialog` itself. It portals, so `centre` is a fine place, and
  the prop's doc says so.

Verifier fixes, as fixup commits on `3e3ad9dd`:

- The collapsed-column toast, with its title. It is dismissed when the column
  reopens or the refusal clears.
- Tests for the edges:
  - an owned refusal while collapsed (toasted once, under its title);
  - one while open (the notice alone, shown once);
  - a `notice` of `null` that still owns refusals;
  - a session ended under an owned notice, which is still toasted;
  - "See the difference" handed the right document, with two open and a real
    outside rewrite on disk.

## Port-back notes

Offered together with the slots themselves (ContextSidebar's `askLocation`,
`beforeMove`, `beforeMoveTimeoutMs`, `uncheckedMoveNote`, Notes'
`addUnavailable`, and `OutsideChangeToasts`' `onShowDiff`, from the panes and
document-pane cycles). Without those slots, none of this applies.

- `WorkspaceShellProps` gains eight optional props, grouped at its end:
  `askLocation`, `beforeMove`, `beforeMoveTimeoutMs`, `uncheckedMoveNote`,
  `notice`, `onDismissNotice`, `notesAddUnavailable` and `onShowOutsideDiff`.
  Each is passed straight to its pane. Absent, each pane gets `undefined`, which
  is the pane's own default.
- The `lastError` toast effect changes when `notice !== undefined`, except for
  `SESSION_ENDED`. It neither clears `lastError` nor toasts the refusal, unless
  the context column is collapsed; then it toasts the refusal under its title,
  keeps the toast's id, and dismisses it when the column reopens or `lastError`
  clears. That is the only change in behaviour, and only for an app that passes
  `notice`.
- `OutsideChangeToasts` in the shell gets `onShowDiff` when the app gives
  `onShowOutsideDiff`, mapped from the slug to the `DocView` as the new-version
  toast's is.
- Story Studio has no home-less app, so it would pass none of these, and its
  shell would behave as it does today.
