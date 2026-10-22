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
parent: feature/workspace-kit-follow-ups
from: cycle/2026-10-shell
---

# Waiting marks still say may be stuck after End session

Seen by the Atlas comparison on 2026-10-20 in both the shipped Scriptorium and
the kit path: after End session, the waiting marks on messages and notes still
read "may be stuck". The `kit-composer-closed-waiting-mark` verifier
(2026-10-20) found the worse case on the kit path: with an agent `tail` running
at the end, the rail dot and the float's line keep pulsing "working on this…"
after the session ended. Once the session has ended nothing can answer, so the
mark should say the session ended instead.

## Definition of done

- [ ] After End session, no waiting mark claims work or a stuck agent: not the
      message badge, the note badge, the float's line, or the closed composer's
      rail dot. Each says the session has ended, or goes.
- [ ] Tested on the kit path.
