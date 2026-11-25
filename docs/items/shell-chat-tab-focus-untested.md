---
type: item
title: Test that focusing the composer brings the chat tab forward
description:
  No test fails if useRightTab stops wiring showChatTab, so focusing the
  composer from the Notes or Tasks tab could stop switching to Chat unnoticed.
status: draft
lifecycle: triage
id: 01a214ae-b605-703d-aa3c-1bcd227cbf2f
kind: task
generated: { by: claude-opus-5-5, at: 2026-11-25 }
parent: feature/kit-split
from: items/kit-split-w5/sessions/2026-11-25-kit-split-w5.md
---

# Test that focusing the composer brings the chat tab forward

`useRightTab` sets `showChatTab.current = () => setPanelId("chat")`, which
`usePaneKeys.focusComposer` calls when the composer is asked for with the column
docked and another tab showing. W5's review deleted that line and every shell
test still passed; the only `focusComposer` test is the float case.

## Definition of done

- [ ] A test focuses the composer while the docked column shows Notes (and
      Tasks), and shows the Chat tab comes forward and the composer has focus.
- [ ] The test fails with the `showChatTab` assignment removed.

## Related Documents

- [WorkspaceShell's right column (W5) — 2026-11-25](./kit-split-w5/sessions/2026-11-25-kit-split-w5.md)
