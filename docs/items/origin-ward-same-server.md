---
type: item
title:
  The origin ward checks the hostname comes from the same server as the port
description:
  The origin-guard ward accepts any <identifier>.hostname as
  refuseForeignOrigin's third argument, so passing a different object's hostname
  would pass.
status: stable
lifecycle: triage
id: 01a138c6-b08c-77d1-8103-208875f6d6bf
kind: chore
generated: { by: claude-opus-5-5, at: 2026-10-13 }
tags: [kit, wards]
parent: feature/workspace-kit
from: features/workspace-kit/sessions/2026-10-13-kit-foundation.md
---

# The origin ward checks the hostname comes from the same server as the port

`grimoire/origin-guard-ward.test.ts` now requires every
`refuseForeignOrigin(req, port, host)` call to pass a third argument shaped like
`x.hostname`. The finalize re-verification (2026-10-13) found that it accepts
any identifier, so `other.hostname` passes, even though the port comes from
`srv`. All nine call sites pass the right object today.

## Definition of done

- [ ] The ward requires the hostname's object to be the same one the port comes
      from, and a planted `other.hostname` fails it

## Related Documents

- [Kit foundation — 2026-10-13](../features/workspace-kit/sessions/2026-10-13-kit-foundation.md)
