---
type: item
title: A set restored from an older manifest can still show the sessions folder
description:
  Restore keeps a set whose root shows the sessions folder (or add ~ with a link
  into it), so the agent can read other sessions' files through it; every write
  through such a set is refused.
status: draft
lifecycle: triage
id: 01a14911-a3e4-77de-8b03-11407216f2de
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-17 }
tags: [kit, security]
parent: feature/workspace-kit
---

# A set restored from an older manifest can still show the sessions folder

Found by the wiki-layer cycle's security reviews (2026-10-17). A manifest
written before the fix can hold a set whose root shows the sessions folder, and
restore keeps it. `add ~` with a link inside `~` into the sessions does the
same. Every write through such a set is refused by `disk.ts`, but search,
`meta`, `show` and the tree can still read other sessions' files.

## Definition of done

- [ ] On restore, a set whose real root holds or lies in the sessions or the app
      home is dropped or narrowed, with a chat line.
- [ ] The tree scan does not follow a link into the sessions or the app home,
      with a test.
