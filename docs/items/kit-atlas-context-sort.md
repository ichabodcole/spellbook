---
type: item
title: Port Atlas's context sort at the next Story Studio sync
description:
  "The ninth Atlas-comparison call (L5), deferred from the polish cycle: Atlas's
  context sort, whose folder order depends on Story Studio's .order files, so it
  is ported at the next sync and judged against Scriptorium's model."
status: draft
lifecycle: triage
id: 01a16b4f-d3c8-77de-9ab9-72fc7aeb7477
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-23 }
parent: feature/workspace-kit-follow-ups
from: items/kit-atlas-comparison-follow-ups.md
---

# Port Atlas's context sort at the next Story Studio sync

Cole took nine calls from the Atlas comparison on 2026-10-20. The polish cycle
built eight (`kit-atlas-comparison-follow-ups`). The ninth, **L5**, is Atlas's
sort of the context list. Its "folder order" depends on Story Studio's `.order`
files, which are part of a project and file-tree model that is diverging from
Scriptorium's, so it waits for the next sync with Story Studio. It should be
judged then against Scriptorium's model: many sets, no single project, and no
copy-in.

## Definition of done

- [ ] At the next Story Studio sync, read how Atlas sorts the context list and
      what `.order` means there now.
- [ ] Decide with Cole what Scriptorium's sort is: a port, an adaptation that
      works without `.order`, or none.
- [ ] Build and test whatever was decided.
