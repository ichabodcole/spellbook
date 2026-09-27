---
type: item
title: A closed bounty board answers `tail` differently by how it is named
description:
  tail --session <id> on a closed board stops with tail.closed at exit 0; tail
  --session-key <k> for the same board exits 5 not_found after the grace.
status: draft # OKF §5.4: draft | stable | deprecated. Nothing else.
lifecycle: triage # triage | backlog | ready | active | review | done | dropped
id: 01a0e1dc-1f1a-752c-8893-0a4dbe674ffc
kind: bug
generated: { by: claude-opus-5-5, at: 2026-09-27 }
parent: feature/spell-hardening
---

# A closed bounty board answers `tail` differently by how it is named

Found by the sprint 06 no-stake verifier (2026-09-27, on `5554e12b`); not a
break of any sprint 06 claim, filed rather than chased.

```
$ bounty tail --session k-v1-…     # board opened, then closed
{"type":"tail.closed",…}   exit 0, 0.24 s
$ bounty tail --session-key V1      # same board
… not_found, exit 5, ~8 s; hint: "existed here and has closed; bring it back: open --session-key V1"
```

Both hints are correct, and #98's fix only promised the snapshot check for
`--session`. But a supervisor sees two outcomes for one board. Decide whether a
key whose derived id has a close snapshot should stop as `tail.closed` too.
