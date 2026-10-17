---
type: item
title: Flagged Scriptorium asks where to create when nothing is selected
description:
  "Build the panes-cycle requirement recorded in
  scriptorium-no-default-workspace: New File, New Folder and a drop with nothing
  selected ask for a location among the session's sets, with the last one used
  preselected, and offer a new folder at a path."
status: stable
lifecycle: triage
id: 01a14bca-18cc-72b3-8890-08d709c255a9
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-17 }
tags: [kit, story-studio, scriptorium]
parent: feature/workspace-kit
cycle: 2026-10-panes
---

# Flagged Scriptorium asks where to create when nothing is selected

[scriptorium-no-default-workspace](scriptorium-no-default-workspace.md) removed
the hidden default workspace. Its "Requirement for the panes cycle" section says
what the surface does instead. In short:

- **With a selection,** New File and New Folder create beside the selected
  document, or inside the selected folder or set, without asking.
- **With nothing selected,** the surface asks where to create, offering the
  session's sets and their folders, with the last location used preselected.
- **The last location** is remembered for the session. If it's gone, nothing is
  preselected.
- **A drop** onto the context list with no set or folder under it asks the same
  way.
- **The dialog can make room:** a new folder at a path (`folder.add`), and a
  pointer to `make-set`.
- **Every create, import and drop sends a `dir`.** The daemon already refuses
  one that names no place.

## Definition of done

- [ ] Each rule in that requirement section holds in the flagged Scriptorium's
      surface, with a test or a browser check per rule.
- [ ] No surface request reaches the daemon without a `dir`. A test fails if one
      does.
