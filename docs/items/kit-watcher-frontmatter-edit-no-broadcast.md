---
type: item
title:
  An outside frontmatter edit to an unopened document reaches the surface late
description:
  On the flagged backend, editing an unopened document's frontmatter on disk
  sends no state frame, so tree marks and docMeta lag until the next unrelated
  broadcast; the agent's state is fresh.
status: draft
lifecycle: triage
id: 01a14e0e-a6b6-7237-9ab1-28c625941f8d
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-18 }
tags: [kit, scriptorium]
parent: feature/workspace-kit
from: 01a1486e-3a72-755d-ae24-fcfc18a8e5ee
---

# An outside frontmatter edit to an unopened document reaches the surface late

The `kit-docmeta-push-cost` verifier found this on 2026-10-18. It reproduces on
the base (`cycle/document-pane` at `3fc49187`) as well, so the cycle's change
did not cause it.

With `SCRIPTORIUM_KIT=1`, editing on disk the frontmatter of a document that is
in a set but not open sends no `state` frame: 0 frames in 6 s, old and new. The
surface's `docMeta` stays as it was, and so do the tree's status marks
(`kit-context-row-marker`), until the next unrelated broadcast, such as a chat
line. The agent's `GET /state` reads fresh `docMeta` every time.

## Definition of done

- [ ] An outside edit to an unopened document's frontmatter reaches the
      surface's `docMeta` within the watcher's debounce, and a test pins it.
- [ ] The change is generic, for example the watcher re-evaluating the app's
      view on a tree change, and it is offered on kit-parity.
