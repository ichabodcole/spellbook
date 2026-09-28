---
type: item
title: Scriptorium tells the human when a new version appears
description:
  A version created without activation (usually the agent's version-new) appears
  silently in the version menu; toast it, with an Activate button.
status: draft
lifecycle: backlog
id: 01a0e964-ccf2-771d-9fdc-5bbd6f3c16a2
kind: task
generated: { by: claude-opus-5-5, at: 2026-09-28 }
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
- [ ] The toast has an **Activate** action that sends the same `activate` the
      menu does. Decide whether it also offers **Diff** against the active
      version; that is the other thing Cole said he skips.
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
