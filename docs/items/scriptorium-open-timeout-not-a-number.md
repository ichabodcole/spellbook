---
type: item
title: Scriptorium's open accepts a --timeout that is not a number
description:
  open --timeout abc exits 0 and starts a daemon whose idle timeout is NaN, so
  it never closes (seen with both the shipped and the kit CLI by the panes
  cycle's verifiers); refuse a non-numeric timeout with a usage error.
status: stable
lifecycle: triage
id: 01a14cb0-995b-70d4-9698-bfc2b0682bd2
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-17 }
from: features/workspace-kit/sessions/2026-10-17-panes.md
---

# Scriptorium's open accepts a --timeout that is not a number

Seen by the panes cycle's verifiers (2026-10-17): `open --timeout abc` exits 0
and starts a daemon. Its idle timeout parses to `NaN`, which compares false
against every threshold, so the daemon never closes on its own. Several such
daemons were left running by test probes until they were stopped by hand.
Digestify documents the same parse (`--timeout abc` means never) as filed but
not fixed.

## Definition of done

- [ ] `open --timeout <not a number>` is refused with a `usage` error (exit 2)
      on both the shipped and the kit CLI, and no daemon starts.
- [ ] A test covers a non-numeric and an empty value.
