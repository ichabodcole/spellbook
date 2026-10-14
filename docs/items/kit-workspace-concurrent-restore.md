---
type: item
title: Two concurrent restores of one session start two daemons
description:
  The kit's already-running check is check-then-act in the CLI and the daemon
  takes no lock, so two simultaneous open --restore calls both start and one
  daemon's writes are lost. Inherited from Story Studio 027d7a3.
status: draft
lifecycle: triage
id: 01a13c64-ca08-759c-8075-f36b83fd6430
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-14 }
tags: [kit, workspace]
parent: feature/workspace-kit
---

# Two concurrent restores of one session start two daemons

Found by the finalize review of the
[workspace-daemon cycle](../cycles/2026-10-workspace-daemon.md) (2026-10-14).

The kit's "already running" check (`src/kit/workspace/verbs.ts`, around
line 567) checks and then acts, in the CLI, and the daemon takes no lock. Two
`open --restore <id>` calls at the same moment both exit 0 on different ports.
The manifest then keeps only one daemon's writes, and the other's messages are
lost. Story Studio's `027d7a3` has the same check.

## Definition of done

- [ ] The daemon takes an exclusive per-session lock (for example `wx` on
      `<session>/daemon.lock` holding the pid), and a second daemon refuses.
- [ ] A stale lock left by a killed daemon is recovered.
- [ ] A test starts two restores at once and gets one daemon.
- [ ] Offered to Story Studio on `kit-parity`.
