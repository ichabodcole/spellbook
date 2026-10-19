---
type: item
title: The kit path answers an ended session with another session's hint
description:
  On the kit path, state or say on a session the human ended answers no running
  session with a hint naming a different session id, where the shipped app says
  the human ended it on purpose.
status: stable
lifecycle: ready
id: 01a1486e-3c60-7055-b105-5f9dcffcbdd5
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-16 }
tags: [kit, scriptorium]
parent: feature/workspace-kit
cycle: 2026-10-shell
---

# The kit path answers an ended session with another session's hint

Found by the migrate-hook verifier (2026-10-17). On the kit path, `state` or
`say` against a session the human ended answers "no running session" with a hint
naming a different session id. The shipped app says the human ended it on
purpose and not to reopen it. The cause is kit `verbs.ts` `endedBy`, used only
for a bound tail. This matters at the cutover.

## Definition of done

- [ ] On the kit path, a verb against an ended session says the human ended it,
      as the shipped app does, with a test.
