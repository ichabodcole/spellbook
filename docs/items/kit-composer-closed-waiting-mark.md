---
type: item
title: With the composer closed, nothing shows a message is waiting
description:
  When the human closes the floating composer, the chat rail shows no waiting
  mark, so E53's sign that a message is waiting on the agent is lost.
status: draft
lifecycle: triage
id: 01a157b8-baa0-701e-a5b1-51a0667b4fbe
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-19 }
tags: [kit, scriptorium]
parent: feature/workspace-kit
from: cycle/2026-10-shell
---

# With the composer closed, nothing shows a message is waiting

Found by the Atlas comparison (C6) on 2026-10-20. With the chat column collapsed
and the floating composer closed, the rail carries no mark that a message is
waiting on the agent. E53's waiting mark is one of the shipped behaviours the
port must not lose.

## Definition of done

- [ ] With the composer closed, the chat rail shows a waiting mark while a
      message waits on the agent, and its "may be stuck" state after 30 s.
- [ ] Tested, and offered on kit-parity.
