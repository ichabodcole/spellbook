---
type: item
title: Waiting marks still say may be stuck after End session
description:
  After the human ends a session, its waiting marks still read may be stuck, in
  both the shipped and the kit Scriptorium, though nothing can answer any more.
status: stable
lifecycle: triage
id: 01a157b8-bbe1-751b-a8f4-cf55657df90c
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-19 }
tags: [kit, scriptorium]
parent: feature/workspace-kit
from: cycle/2026-10-shell
---

# Waiting marks still say may be stuck after End session

Seen by the Atlas comparison on 2026-10-20 in both the shipped Scriptorium and
the kit path: after End session, the waiting marks on messages and notes still
read "may be stuck". Once the session has ended nothing can answer, so the mark
should say the session ended instead.

## Definition of done

- [ ] After End session, a waiting mark says the session has ended, not that the
      agent may be stuck.
- [ ] Tested on the kit path.
