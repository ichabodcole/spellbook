---
type: item
title:
  "Bounty snapshot: a board's first edits are lost to SIGKILL, and a restore is
  not announced"
description:
  The debounced first snapshot leaves ~1 s in which SIGKILL loses a new board
  entirely; a keyed open that restored says so only as restoreFailed:null.
status: draft
lifecycle: backlog
id: 01a0e988-853f-7247-99c7-10303b5ee793
kind: bug
generated: { by: claude-opus-5-5, at: 2026-09-28 }
parent: feature/spell-hardening
---

# Bounty snapshot: a board's first edits are lost to SIGKILL, and a restore is not announced

Found by the re-measure in
[cycle/2026-09-data-you-cant-get-back](../cycles/2026-09-data-you-cant-get-back.md),
2026-09-28, on `493f01f5` (shipped launcher, scratch `HOME`); filed, not
scheduled (decision-log row 5).

- **SIGKILL in the first debounce window.** Snapshots are debounced (~1 s,
  `src/bounty/backend/server.ts` ~855). A board killed with SIGKILL before its
  first flush comes back empty: measured with 4 adds, killed within 1 s, and the
  snapshot was absent. SIGTERM is fine, because the teardown saves. Likely fix:
  flush at once on the first mutation after boot.
- **A restore is not announced.** A keyed `open` that hydrates from its snapshot
  (`fb209f1a`) prints `restoreFailed: null` and nothing that says it restored or
  how many tasks came back. See also
  [a-performed-restore-is-as-silent-as-a-skipped-one](a-performed-restore-is-as-silent-as-a-skipped-one.md).
