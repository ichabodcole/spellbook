---
type: item
title:
  "Scriptorium on the kit: no default workspace; new files go where you point"
description:
  "Scriptorium on the kit drops the hidden default workspace: a new file or
  folder goes into the selected document's set or folder, asks for a location
  (last one preselected) when nothing is selected, and the agent names where it
  creates; the opening folder becomes an ordinary added folder."
status: stable
lifecycle: triage
id: 01a14606-4a31-7535-9dbd-5f19712c490c
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-16 }
tags: [kit, scriptorium, workspace]
parent: feature/workspace-kit
---

# Scriptorium on the kit: no default workspace; new files go where you point

Scriptorium has a default workspace today. A file or folder created at the root
of the tree is saved there, beside folders added from anywhere else. Two things
go wrong:

- **The name.** "Workspace" says the tree's contents live there, and most of
  them don't. It is only a default save location.
- **Nobody chose it.** It is set by wherever the agent opened the session, not
  by you. The sidebar's workspace picker does show it, but quietly, so it's easy
  to lose track of where new files will land.

Cole ruled this on 2026-10-16, from his braindump
`fragments/scriptorium-default-workspace.md` in the Spellbook Operator workspace
and the discussion that followed.

**The rule:**

- **With a selection,** a new file or folder goes beside or inside the selected
  document or folder.
- **With nothing selected,** Scriptorium asks for a location, with the last one
  used already selected.
- **The agent** names where it creates a file, or puts it beside the document
  being discussed. Where the session was opened decides nothing.
- **The folder the session opened in** becomes an ordinary added folder in the
  tree, not a hidden destination.

**What follows from it:**

- Turning a document into a set (`make-set`), and creating a folder at a
  location you pick, are how you make room for new files.
- The kit path does not need undo for setting the workspace.
- When shipped sessions are converted at the cutover, the old default workspace
  becomes an ordinary added folder.

## Definition of done

- [ ] The kit's app declaration can say an app has no home workspace, and
      Scriptorium on the kit declares none. Story Studio's model is unchanged.
- [ ] On the kit path, no verb or daemon command writes a new file or folder to
      a destination the caller did not name or select. A create with no location
      is refused, and the refusal says how to name one.
- [ ] The session's opening folder appears in the tree as an ordinary added
      folder.
- [ ] The agent's create verbs take a location, and the SKILL delta says the
      agent names it or uses the document under discussion.
- [ ] The surface's "ask for a location, last one preselected" behaviour is
      recorded as a requirement for the panes cycle. It is not built here.
- [ ] The session converter's item records that the old default workspace
      becomes an added folder.
