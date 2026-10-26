---
type: item
title: An unreadable document is read as having no links
description:
  "A document made unreadable (chmod 000) drops out of link-check silently: its
  outbound links vanish, and doctor and state say nothing."
status: draft
lifecycle: triage
id: 01a176c6-150f-7587-825c-0209189be3bc
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-25 }
parent: feature/workspace-kit-follow-ups
from: items/scriptorium-chat-and-toast-nits.md
---

# An unreadable document is read as having no links

A document made unreadable (chmod 000) drops out of link-check silently: its
outbound links vanish, and doctor and state say nothing.

Bullet 33 of the nits item, re-checked on 2026-10-25. Evidence is in the
re-check report the item records.

## Definition of done

- [ ] A chmod-000 document in a set appears in `link-check` (its own named
      section), in `doctor` with a fix in words, and on the broken-links sign.
- [ ] Its links are never silently dropped. Tested.

## Related Documents

- [Scriptorium: small chat and toast leftovers](./scriptorium-chat-and-toast-nits.md)
