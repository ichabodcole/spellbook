---
type: item
title: The human can see that a set has broken links
description:
  On the kit path nothing in the human surface shows dangling or outbound links
  since the map dropped its header numbers; give the human a visible sign with
  an act attached.
status: stable
lifecycle: triage
id: 01a15029-f5a7-7569-868c-047b2a7a562a
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-18 }
tags: [kit, scriptorium]
parent: feature/workspace-kit
from: cycle/2026-10-document-pane
---

# The human can see that a set has broken links

The shipped map's header read "1 leaving the set · 1 dangling". The kit's map
(`scriptorium-kit-map-view`, document-pane cycle) drops both numbers. Nothing in
the human surface on the kit path now shows that a set has broken links: only
the agent's `link-check` and `doctor` do. Cole ruled on 2026-10-18 that the
human should see a sign of them, and that the sign should come with an act that
answers it.

GitHub #129 (link health in the status bar) is the obvious home, and the
workspace-kit feature says it lands on the ported panes.

## Definition of done

- [ ] On the kit path, the human can see that a set or document has broken or
      outbound links, without asking the agent.
- [ ] The sign offers an act, such as listing the links or opening each one at
      its line.
- [ ] The count matches what `link-check` reports for the same set.
