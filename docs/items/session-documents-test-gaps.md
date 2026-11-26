---
type: item
title: Catch the faults the session's documents tests miss
description:
  27 of 60 faults planted in S7's documents, follow, compare, saving and notes
  parts pass every workspace test; add the checks that catch them.
status: draft
lifecycle: triage
id: 01a2160e-3a5b-70e3-a19b-a7661d279e11
kind: task
generated: { by: claude-opus-5-5, at: 2026-11-25 }
parent: feature/kit-split
from: items/kit-split-s7/sessions/2026-11-25-kit-split-s7.md
---

# Catch the faults the session's documents tests miss

S7's adversarial review planted 60 single faults in the moved parts. 27 pass
every unit test in `src/kit/workspace`. None came in with S7; nothing would
catch them if they did. (A differential harness caught 14 of the 27, so they are
observable through the public acts.)

- **documents.ts:** `writeActive` skips the `lastActiveText` update;
  `preserveOutside` drops `persist`, or records the wrong `fromVersion`;
  `docOrDie` offers 19 choices, not 20; the `unopenedNamed` cap off by one;
  `findDoc` by name takes an ambiguous match; `openPath` of an open doc skips
  `persist`; `editLeft` drops its same-text check, or `persist`; `newVersion`
  defaults `from` to v1 rather than the active version; `deleteVersion` skips
  `writes.disown`; `activate` marks only the new version activated;
  `jsonProblemOf` checks `.txt` too; `isDirty` falls back to `originalHash`.
- **follow.ts:** `MOVES_KEPT` off by one; `movedFrom` follows exact paths only,
  not inside a moved folder; `followMove` keeps the old `d.name`, or skips
  `relink`.
- **compare.ts:** `pick` tries versions oldest first; merge refuses invalid JSON
  without `json:"refuse"`.
- **saving.ts:** save keeps `outsideHash`; save after a recreate skips `relink`;
  `closeDoc` skips `persist`; save does not persist `missing`.
- **notes.ts:** `addNote` stores `version: 1`; `removeNote` skips `persist`.
- **Wiring:** saving's `relink` hook a no-op; `linkHeadings` no longer refuses
  an unknown slug.

The cheapest checks: restore after each verb (the six persist drops),
`fromVersion` asserted, `activated` on the previous version, relink after a
recreate or a move, `d.name` after a rename, compare's pick order.

## Definition of done

- [ ] Each fault above, planted alone, fails at least one test (or is shown
      unobservable and noted here).
- [ ] No existing test's expectations change.
- [ ] The gate passes.

## Related Documents

- [The session's documents parts (S7) — 2026-11-25](./kit-split-s7/sessions/2026-11-25-kit-split-s7.md)
