---
type: item
title: A Windows drive path in a link reads as a URL scheme
description:
  A link to `C:/win/path.md` is read as scheme `c` and listed under dangling's
  `unsupported`, not as a path. Whether Windows paths are in scope is Cole's
  call.
status: draft
lifecycle: triage
id: 01a176c6-132b-74e5-ae04-a08a04f0fe19
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-25 }
parent: feature/workspace-kit-follow-ups
from: items/scriptorium-chat-and-toast-nits.md
---

# A Windows drive path in a link reads as a URL scheme

A link to `C:/win/path.md` is read as scheme `c` and listed under dangling's
`unsupported`, not as a path. Whether Windows paths are in scope is Cole's call.

Bullet 22 of the nits item, re-checked on 2026-10-25. Evidence is in the
re-check report the item records.

## Definition of done

- [ ] `C:/x.md` and `C:\x.md` are no longer reported as unsupported scheme `c`:
      each is looked up as an absolute path, or reported as a path outside the
      context. Or Cole rules Windows paths out of scope and this item is
      dropped.

## Related Documents

- [Scriptorium: small chat and toast leftovers](./scriptorium-chat-and-toast-nits.md)
