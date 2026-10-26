---
type: item
title: Search lists a line twice when it matches twice
description:
  Search shows one row per match, so a line matching twice appears twice, and
  both rows have the same accessible name.
status: draft
lifecycle: triage
id: 01a176c6-166f-7177-9b97-cc92309353f9
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-25 }
parent: feature/workspace-kit-follow-ups
from: items/scriptorium-chat-and-toast-nits.md
---

# Search lists a line twice when it matches twice

Search shows one row per match, so a line matching twice appears twice, and both
rows have the same accessible name.

Bullet 20 of the nits item, re-checked on 2026-10-25. One row per line or one
per match is a product call. Evidence is in the re-check report the item
records.

## Definition of done

- [ ] A line matching twice is either one row with both matches marked, or two
      rows whose accessible names differ ("match 1 of 2").
- [ ] The count says lines or matches consistently.

## Related Documents

- [Scriptorium: small chat and toast leftovers](./scriptorium-chat-and-toast-nits.md)
