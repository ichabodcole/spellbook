---
type: item
title: A set cut short at the scan cap doesn't say so
description:
  "A set over the 2,000-file scan cap is cut short silently: a document past the
  cap is never link-checked, so its broken link goes unreported, and adding a
  sub-folder as its own set doesn't help the parent."
status: draft
lifecycle: triage
id: 01a176c6-15b7-746c-b1b0-d952e6999cbd
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-25 }
parent: feature/workspace-kit-follow-ups
from: items/scriptorium-chat-and-toast-nits.md
---

# A set cut short at the scan cap doesn't say so

A set over the 2,000-file scan cap is cut short silently: a document past the
cap is never link-checked, so its broken link goes unreported, and adding a
sub-folder as its own set doesn't help the parent.

Bullet 34 of the nits item, re-checked on 2026-10-25. Evidence is in the
re-check report the item records.

## Definition of done

- [ ] A truncated set makes `link-check` and `doctor` name the set and how many
      files went unread.
- [ ] Adding a sub-folder as its own set lets the parent read the rest, or the
      answer says what to do; a flat folder over the cap has a stated remedy.
- [ ] Tested with 2,100 files.

## Related Documents

- [Scriptorium: small chat and toast leftovers](./scriptorium-chat-and-toast-nits.md)
