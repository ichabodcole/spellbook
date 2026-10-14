---
type: item
title: A flagged Scriptorium daemon and CLI on the kit
description:
  With SCRIPTORIUM_KIT=1, Scriptorium's CLI and daemon run on the kit's
  workspace daemon with their own sessions root, beside the shipped Scriptorium.
status: draft
lifecycle: triage
id: 01a1393e-adb9-73df-aa57-15a8422d444f
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-14 }
tags: [scriptorium, kit]
cycle: 2026-10-workspace-daemon
parent: feature/workspace-kit
from: items/workspace-stack-port-shape/write-up.md
---

# A flagged Scriptorium daemon and CLI on the kit

Part of [Workspace Kit](../features/workspace-kit/feature.md)'s workspace-stack
port ([the port-shape write-up](./workspace-stack-port-shape/write-up.md)).
**Ruled (Cole, 2026-10-14):** a second Scriptorium is built on the kit and runs
side by side with the shipped one, until the cutover cycle. Nothing is released
until the whole stack is done.

With `SCRIPTORIUM_KIT=1`, Scriptorium's CLI and daemon run on
`createWorkspaceDaemon` and `createWorkspaceCli`:

- with an app declaration (`scriptorium`, slot version 1);
- with sessions under `$SCRIPTORIUM_HOME/kit/sessions`;
- with no surface and no wiki layer yet.

Scriptorium keeps its undo for setting the workspace for now (Cole). The kit has
none, so on this path it becomes a seam for a later cycle.

## Definition of done

- [ ] The launchers are unchanged; the hand-off lives in
      `src/scriptorium/backend`.
- [ ] With the flag, `open`, `add`, `say`, `note`, `tail`, `version-new`,
      `close` and `doctor` work, by an integration test under a scratch `HOME`.
- [ ] The tail's `message` carries `about`.
- [ ] acc's census is conformant for the flagged CLI and for the default one.
- [ ] Without the flag, Scriptorium is byte-for-byte the shipped one: its tests
      pass unchanged.
- [ ] The SKILL delta for the kit path is recorded in this item, not in the
      shipped SKILL.

## Related Documents

- [How to port the workspace stack](./workspace-stack-port-shape/write-up.md)
