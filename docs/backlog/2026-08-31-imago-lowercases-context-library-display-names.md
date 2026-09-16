---
type: backlog
title: imago lowercases context-library display names on ingest
status: stable
description:
  imago uses the normalized lowercase form both as a dedup key and as the stored
  display name, losing original casing that could be preserved at comparison
  time
lifecycle: open
generated: { by: unknown, at: 2026-08-31 }
---

# imago lowercases context-library display names on ingest

**Pre-existing since `08ad396`. NOT a Sprint 01 regression** — the relocation
only made it visible by putting someone in front of the board.

## The measurement

`scripts/server.ts:248`'s `normStyle` is used as **both** the dedupe key **and**
the stored display name. So a context entry named _"House Palette"_ is stored —
and rendered back — as _"house palette"_. The original casing is gone; nothing
retains it.

## Why the fix is nearly free

`:407` **re-normalises on comparison.** So storing the original string and
normalising only at the comparison site would dedupe **identically** — the
lowercase key is already computed where it is needed. The only reason the stored
value is lowercased is that one function is doing two jobs.

## Acceptance

- [ ] The stored display name preserves the user's casing.
- [ ] Dedupe behaviour is unchanged — verify that two entries differing only in
      case still collapse to one.
