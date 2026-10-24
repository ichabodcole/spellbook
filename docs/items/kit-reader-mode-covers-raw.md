---
type: item
title: Reader mode covers the raw editor too
description:
  Let the kit's reader mode apply in raw and split, not only rendered, so its
  quieter chrome (and the line-number gutter's fade) applies where the human
  edits.
status: stable
lifecycle: backlog
id: 01a15029-f6b9-778f-83af-74c5e0b855f2
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-18 }
tags: [kit, scriptorium]
parent: feature/workspace-kit-follow-ups
from: cycle/2026-10-document-pane
---

# Reader mode covers the raw editor too

In the kit, reader mode is always the rendered view with both side columns
closed (`src/kit/document/reader.ts`). Cole ruled on 2026-10-18 that reader mode
should also cover the raw editor (and split view). The line-number gutter
already fades there (40% opacity, never hidden, full under the pointer), so that
ruling becomes visible once this lands.

This is a kit change, so it is offered back to Story Studio, whose reader mode
is the same.

## Definition of done

- [ ] Reader mode can be entered from raw and from split, and it keeps that view
      while quieting the chrome and closing the side columns.
- [ ] In raw reader mode the line-number gutter fades and stays visible. That
      closes the reader box in `scriptorium-toggle-line-numbers-in-raw-mode`.
- [ ] Leaving reader mode restores the columns and the view as before.
- [ ] The change is offered on kit-parity.
