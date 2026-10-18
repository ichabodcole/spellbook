---
type: item
title: docMeta rides every state push on the kit path
description:
  The kit broadcasts appState on each typing pause, and Scriptorium's docMeta
  doubles each frame (76 KB to 159 KB on 2,000 documents); send it only when it
  changes, or on request.
status: stable
lifecycle: active
id: 01a1486e-3a72-755d-ae24-fcfc18a8e5ee
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-16 }
tags: [kit, scriptorium]
parent: feature/workspace-kit
cycle: 2026-10-document-pane
---

# docMeta rides every state push on the kit path

Found by the wiki-verbs verifier (2026-10-17). The kit sends `appState` with
every state push, including each pause in typing. Scriptorium's `docMeta` (up to
500 documents) took a 2,000-document world's frame from 76 KB to 159 KB, about 1
ms warm.

## Definition of done

- [ ] `docMeta` is sent only when it changed, or fetched on request, and a test
      shows a typing pause sends no `docMeta`.
- [ ] The agent still sees fresh `docMeta` after a frontmatter edit.
