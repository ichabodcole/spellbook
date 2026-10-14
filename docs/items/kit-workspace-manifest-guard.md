---
type: item
title: The kit refuses a session manifest that is not its own
description:
  A manifest without an app, or of another format, is refused with a hint rather
  than misread, so a kit daemon can never misread a Scriptorium session.
status: draft
lifecycle: triage
id: 01a1393e-ab7a-76ef-b520-5fd5ea18f624
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-14 }
tags: [kit, sessions]
cycle: 2026-10-workspace-daemon
parent: feature/workspace-kit
from: items/workspace-stack-port-shape/write-up.md
---

# The kit refuses a session manifest that is not its own

Part of [Workspace Kit](../features/workspace-kit/feature.md)'s workspace-stack
port ([the port-shape write-up](./workspace-stack-port-shape/write-up.md)).
Scriptorium's session manifests and the kit's both say `format: 1`. The kit's
restore would throw on a Scriptorium manifest without tasks, or misread one that
has them. A manifest without `app`, or of another format, must be refused with a
hint, never misread.

## Definition of done

- [ ] A Scriptorium manifest (`format: 1`, no `app`, with and without `tasks`)
      is refused with a 409 and a hint, by a test.
- [ ] The kit's own manifests still restore.

## Related Documents

- [How to port the workspace stack](./workspace-stack-port-shape/write-up.md)
