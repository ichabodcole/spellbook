---
type: item
title: Icon tabs in the right column
description:
  The right column's tabs become icons with tooltips, carrying their counts,
  spinner and waiting dot, so a fourth tab fits.
status: stable
lifecycle: backlog
id: 01a1eb00-535e-7289-8ced-013de404e3c7
kind: task
generated: { by: claude-opus-5-5, at: 2026-11-17 }
blocked_by:
  [01a17a8e-259e-77a4-b704-af6c786e9732, 01a1eb00-512b-72a6-b0d3-c95f34612dfc]
parent: feature/workspace-kit-follow-ups
from: 01a1eabb-ee28-7737-826d-38ba3dd5b5bf
---

# Icon tabs in the right column

From the Story Studio port scan (2026-11-17). Scriptorium's right column has
three uppercase text tabs: Chat, Notes (n), Tasks (n) (`WorkspaceShell.tsx`).
With the Activity tab ([kit-activity-tab](kit-activity-tab.md)) there are four,
and text tabs get crowded.

Story Studio made them icons in `416160b2`, with `80cfe342` bringing back the
remembered tab: lucide icons with tooltips, and the counts, the spinner and the
waiting dot sit on the icon (`packages/kit/src/shell/ChatColumn.tsx`,
`rightTabs.ts`, `useRightTab.ts`). Their per-item-type tabs after a divider come
from plugin panels (`tabApplies`, `ShellPanel.appliesTo`); Scriptorium passes
none, so it gets the fixed set alone. Take the icons, not the scoping.

Land it on one branch with the Activity tab, and with or after
[kit-owed-notes-in-the-inbox](kit-owed-notes-in-the-inbox.md): our Notes dot
covers owed notes in every document, and only the inbox replaces that cue.
Blocked by both that item and
[kit-split-oversized-modules](kit-split-oversized-modules.md).

## Definition of done

- [ ] The right column's tabs are icons with tooltips and accessible names,
      keeping the tablist pattern and keyboard use.
- [ ] Counts, the spinner and the waiting dot show on the icons.
- [ ] The last tab chosen comes back after a reload.
- [ ] Offered on kit-parity.

## Related Documents

- [Which of Story Studio's new document UX should Scriptorium take?](./story-studio-document-ux-port/item.md)
