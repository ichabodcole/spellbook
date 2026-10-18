---
type: item
title: The flagged Scriptorium edits documents in the kit's document pane
description:
  "Put DocumentPane in the interim frame's centre with a minimal workspace
  context, wire the held selection to chat and notes, and fill Scriptorium's
  slots: trust, stale, split view."
status: draft
lifecycle: triage
id: 01a14dc5-6f94-7529-ac57-306dea4e021a
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-17 }
tags: [scriptorium, kit, document]
parent: feature/workspace-kit
---

# The flagged Scriptorium edits documents in the kit's document pane

The interim frame from the panes cycle has chat, context, Notes and Tasks, and a
centre that says the document pane comes next. This item puts the kit's
`DocumentPane` there. It is still the interim frame: the shell replaces it in
cycle 5.

**The pane needs a workspace context.** It reads everything through
`useWorkspace()`, which Story Studio's shell provides and our frame does not.
The frame builds a small one from what it already has: the daemon, the state,
the open document, the theme. It adds:

- one held selection, with report and drop;
- reveal and focus for notes;
- a toast store for announcements;
- plain stand-ins for the shell's columns and quiet mode.

Story Studio's own test host (`DocumentPane.test.tsx`) is the template.

**Then the panes are wired to it.** The chat attaches the held selection, and
Notes can add, go to and focus a note. All three are no-ops in the frame today.

**Scriptorium's slots:**

- the trust chip left on, so it shows only where a document has `verified`
  (E69);
- a stale chip added through `frontmatterChips`, from `stale_after`, as the
  shipped header shows;
- split view offered;
- the view-mode key on Spellbook's name.

**What the shipped centre has that this does differently, kept as the kit does
it:**

- An outside change is a Reload/Keep toast, not a banner (E54).
- Find is the kit's find bar.

**What it gains:** heading anchors, images and embeds, and "Linked from".

## Definition of done

- [ ] With `SCRIPTORIUM_KIT=1`, opening a document shows it in the kit's
      document pane. The human can edit, save, revert, switch and make versions,
      compare and merge, in raw, rendered and split views.
- [ ] A selection in either view goes to chat as an attachment, and Notes can
      add a note on it, go to a note and paint the one chosen.
- [ ] The trust chip shows only on a document with `verified`, and a stale
      document shows a stale chip.
- [ ] The frame's tests no longer say the document pane is coming. A real
      browser check edits, saves and notes a document.
- [ ] After the port, the open edges in
      [scriptorium-selection-edges-the-review-found](scriptorium-selection-edges-the-review-found.md),
      [scriptorium-selection-hygiene-duplication-and-cost](scriptorium-selection-hygiene-duplication-and-cost.md)
      and
      [scriptorium-a-coalesced-scroll-is-lost-in-one-ordering](scriptorium-a-coalesced-scroll-is-lost-in-one-ordering.md)
      are checked against the kit's code. Each is closed, or re-aimed at the
      kit.
- [ ] The shipped Scriptorium is unchanged.
