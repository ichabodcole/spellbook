---
type: item
title: Long text overflows the End session dialog
description:
  When the human ends a session, the dialog's long content (the restore command
  with its CLI path) runs past the dialog's edge instead of wrapping inside it.
status: stable
lifecycle: ready
id: 01a1658c-602a-7138-97cc-ea2c7c22cf0f
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-22 }
tags: [kit, shell]
parent: feature/workspace-kit
from: cycle/2026-10-cutover
cycle: 2026-10-cutover
---

# Long text overflows the End session dialog

Cole, in his cutover trial (2026-10-22): ending a session opens the dialog that
names the session and gives the command to bring it back. With a long CLI path
in that command, the content runs past the dialog's edge instead of wrapping
inside it. Probably not a regression.

The command itself already has `break-all whitespace-pre-wrap`
(`src/kit/shell/SessionEnd.tsx`, `data-slot="restore-command"`), so the overflow
likely comes from a parent that won't shrink (a flex or grid child without
`min-w-0`) or from another line in the dialog. Find it in a real browser before
fixing.

## Definition of done

- [ ] With a very long restore command, session id and path, every part of the
      End session dialog stays inside the dialog, in both the confirm and the
      ended states, at desktop and narrow widths.
- [ ] A test pins it, checked in a real browser; offered on kit-parity.
