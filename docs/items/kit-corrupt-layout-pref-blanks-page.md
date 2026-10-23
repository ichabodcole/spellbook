---
type: item
title: A corrupt saved pane layout blanks the whole page
description:
  "react-resizable-panels' useDefaultLayout parses a stored layout with
  JSON.parse during render and no guard, so one corrupt panes: pref (the shell's
  columns, or the split's width) leaves the kit page empty with a SyntaxError."
status: stable
lifecycle: ready
id: 01a15b70-ecd3-71b1-9013-4d168783af30
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-20 }
tags: [kit, shell]
parent: feature/workspace-kit-follow-ups
from: cycle/2026-10-cutover
cycle: 2026-10-polish
---

# A corrupt saved pane layout blanks the whole page

Found by the `kit-split-divider` verifier (2026-10-20). Writing `"{not json"`
into a `panes:` key in the kit's `prefs.json` and opening a new session leaves
the page empty, with `SyntaxError: Expected property name…` in the console.
`useDefaultLayout` (`react-resizable-panels` 4.12.4) calls `JSON.parse` on the
stored value during render, with no guard. The shell's own column layout key
does the same on `cycle/cutover`, so the bug is older than the split divider;
the divider adds a second key that can trigger it. Story Studio's shell uses the
same hook.

## Definition of done

- [ ] A corrupt or wrongly shaped stored layout is ignored (the default layout
      is used) for every `useDefaultLayout` the kit calls, for example through a
      guarded storage wrapper.
- [ ] A test plants a corrupt value for the shell's columns and the split, and
      the page renders.
- [ ] Offered on kit-parity.
