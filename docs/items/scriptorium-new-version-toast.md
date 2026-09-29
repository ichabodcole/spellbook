---
type: item
title: Scriptorium tells the human when a new version appears
description:
  A version created without activation (usually the agent's version-new) appears
  silently in the version menu; toast it, with an Activate button.
status: draft
lifecycle: ready
id: 01a0e964-ccf2-771d-9fdc-5bbd6f3c16a2
kind: task
generated: { by: claude-opus-5-5, at: 2026-09-28 }
cycle: 2026-09-scriptorium-from-real-use-2
---

# Scriptorium tells the human when a new version appears

**From Cole's real use, 2026-09-28.** He reviews a document and leaves notes,
and the agent answers by creating v2. Nothing tells him v2 exists. Unless the
agent says so in chat, he doesn't open the version menu, so he never activates,
saves or diffs the new version, and his feedback loop stalls silently.

**What exists today.** `ActiveVersionToast`
(`src/scriptorium/surface/components/ActiveVersionToast.tsx`, E42) fires when
the **active** version changes, whoever changed it: "Now editing v3 · …". But
`version-new` without `--activate`, the agent's normal path
(`src/scriptorium/backend/server.ts`, `version.new`), adds a version without
changing the active one. So that toast never fires, and the new version appears
in the menu with no signal.

**Wanted (Cole):** any new version, whether the agent or the human created it,
raises a toast that says so and carries an **Activate** button. Activating from
the toast makes that version the active one, and the existing toast then
confirms "Now editing v…".

## Definition of done

- [ ] A version created without activation raises a toast naming the document,
      the version (with its label, by the menu's rule) and who created it.
- [ ] The toast carries **two separate actions** (Cole, 2026-09-28):
      **Activate** makes the new version the active one (the same `activate` the
      menu sends), and nothing else. **Show diff** does not activate: it
      switches the document pane to compare mode (or stays in it) and compares
      the active version against the new one. They are two different use cases:
      "just activate it" versus "compare it with the one I'm on". There is no
      combined activate-and-diff action.
- [ ] Opening a document, reconnecting, or loading a snapshot is never announced
      as new, just as `ActiveVersionToast` tracks the versions it has seen per
      document.
- [ ] A version created _with_ activation raises one toast, not two: the
      existing "Now editing" toast covers it, and the new toast gives way to it.
- [ ] Check that the `Toasts` component can carry an action button; add one if
      it can't.
- [ ] Update the scriptorium SKILL.md: the agent no longer needs to announce a
      new version in chat. It can still say why it made one.

Conventions that apply (team practice, not written house-style rules): a notice
should carry the act that answers it, which here is Activate; and the surface is
conversation-primary, so the button is a shortcut and the human can still ask
the agent to activate.

## Done (2026-09-28)

A version that appears on the open document without becoming active raises a
toast: "New version: v3 · label", naming the document, the author (every version
records `author`, agent or human, so it is shown as known) and the version the
human is still editing. It carries two actions, per Cole's ruling:

- **Activate** sends the menu's `activate` and nothing else. The existing "Now
  editing" toast then confirms it, and the new-version toast withdraws.
- **Show diff** does not activate. It puts the pane in compare mode (or keeps it
  there) with the new version as the side compared against, so the view is
  active vs new. If the agent writes the version after the toast appears, the
  open comparison refreshes as the file changes.

Detection is pure and tested (`surface/state/newVersions.ts`): the versions seen
per document, the first sight of a document is a baseline, the first snapshot
after a reconnect is a baseline, and a version that is already active is left to
"Now editing", so a version created with activation raises one toast. A toast
withdraws when its version becomes active, is deleted, or its document stops
being the open one.

Decisions made in the build:

- **Duration.** `Toasts` gained action buttons. A toast with actions stays 15 s
  instead of 6 s, and any toast holds while the pointer is over it or focus is
  inside it, restarting its full time on release.
- **Other documents.** Only the open document raises the toast. A version made
  on another document is already said in the chat by the daemon, and is
  announced when the human next opens that document, since they have not seen
  it. This avoids an "open, then compare" sequence racing the compare view's
  guard.

Driven in a real browser against a live session: the agent's `version-new`
raised the toast, Show diff entered compare mode against the new version while
staying on v1, Activate moved to the new version with only the "Now editing"
toast showing, a hovered toast outlived its 15 s, and a reload announced
nothing.

**Toasts moved to the document pane** (Cole's ruling after the no-stake
verifier). Pinned bottom-right of the window, three stacked toasts covered the
conversation composer and blocked clicks on it and on Send. Every toast ("Now
editing", task, new version) now sits at the bottom-right of the document pane:
`DocumentPane` draws the stack through a `toasts` slot, anchored between the
document and the floating composer, so it follows a resize, narrows with a
narrow pane, and stays above the composer when the chat column is collapsed.
Checked in a real browser with three toasts up: the composer and Send took
clicks in both themes, at 820 px wide, and with the chat collapsed.
