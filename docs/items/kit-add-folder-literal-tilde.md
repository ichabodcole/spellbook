---
type: item
title: The kit CLI's add-folder makes a folder literally named ~
description:
  add-folder ~ (when the shell leaves ~ unexpanded, e.g. quoted) creates a
  folder named ~ in the caller's directory, while the surface's new folder at a
  path refuses the same input; expand a leading ~ the way the surface does, or
  refuse it.
status: draft
lifecycle: triage
id: 01a14cb0-b4b0-7668-b41a-d2b31887f5ed
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-17 }
parent: feature/workspace-kit
from: features/workspace-kit/sessions/2026-10-17-panes.md
---

# The kit CLI's add-folder makes a folder literally named ~

Found by the panes cycle's verifier of `scriptorium-kit-ask-location`
(2026-10-17). When `~` reaches the kit CLI unexpanded (quoted, or from a
script), `add-folder ~` creates a folder named `~` in the caller's directory.
The surface's "new folder at a path" refuses the same input (`~` already exists
as the home folder). The two should agree.

## Definition of done

- [ ] `add-folder ~` and `add-folder ~/x` either expand a leading `~` as the
      surface does or are refused, and never create a folder named `~`.
- [ ] A test covers both.
