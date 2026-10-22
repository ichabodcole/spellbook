---
type: item
title: A repeated refusal shows nothing while the context column is collapsed
description:
  With the context column collapsed and the app owning refusals, an identical
  refusal repeated after its toast expired shows nothing, because the daemon
  client keeps a refusal as its text alone.
status: draft
lifecycle: triage
id: 01a15842-5868-758e-8f18-f8f05d1ca130
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-20 }
tags: [kit]
parent: feature/workspace-kit-follow-ups
from: cycle/2026-10-shell
---

# A repeated refusal shows nothing while the context column is collapsed

Found by the `kit-shell-sidebar-slots` work (2026-10-20). The shell toasts an
owned refusal while the context column is collapsed, but `daemonClient` keeps a
refusal as its text (`lastError`), so an identical repeat after the toast
expires changes no state and shows nothing. The notice still holds it, so
reopening the column shows it.

## Definition of done

- [ ] Each refusal carries a sequence or request id the shell can see, and a
      repeat while collapsed toasts again.
- [ ] Tested, and offered on kit-parity.
