---
type: item
title: The kit refuses a session manifest that is not its own
description:
  A manifest without an app, or of another format, is refused with a hint rather
  than misread, so a kit daemon can never misread a Scriptorium session.
status: stable
lifecycle: review
id: 01a1393e-ab7a-76ef-b520-5fd5ea18f624
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-14 }
tags: [kit, sessions]
cycle: 2026-10-workspace-daemon
parent: feature/workspace-kit
blocked_by: [01a1393e-aab6-7627-8b3c-f7785e244373]
from: items/workspace-stack-port-shape/write-up.md
---

# The kit refuses a session manifest that is not its own

Part of [Workspace Kit](../features/workspace-kit/feature.md)'s workspace-stack
port ([the port-shape write-up](./workspace-stack-port-shape/write-up.md)).
Scriptorium's session manifests and the kit's both say `format: 1`. The kit's
restore would throw on a Scriptorium manifest without tasks, or misread one that
has them. A manifest without `app`, or of another format, must be refused with a
hint, never misread.

**Done and verified (2026-10-14).** Restore refuses any manifest shaped like
Scriptorium's (millisecond `createdAt`, or chat by `who`), with or without an
`app` slot, and any other app's `appName`. Each refusal is a 409 with a hint,
and the file is left byte-identical. Tests use manifests written by
Scriptorium's own writer. The kit now stamps `appName`; older kit manifests are
recognised by their ISO `createdAt` and stamped on their next save.

Verification also found a pre-existing bug, now fixed: a daemon whose start
failed after binding kept listening. The failed boot now closes the port,
removes the pointer and exits.

**Left open (low):**

- A deliberately hand-forged Scriptorium manifest (ISO `createdAt`, `who`
  stripped) can still get past the guard. It then fails with a 500 rather than a
  409, and after some writes to a file that was already forged.
- The unwind does not stop the attention and housekeeping timers, which boot
  starts later; nothing can throw after them today.

## Definition of done

- [x] A Scriptorium manifest (`format: 1`, no `app`, with and without `tasks`)
      is refused with a 409 and a hint, by a test.
- [x] The kit's own manifests still restore.

## Related Documents

- [How to port the workspace stack](./workspace-stack-port-shape/write-up.md)
