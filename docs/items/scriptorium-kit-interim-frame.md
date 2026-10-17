---
type: item
title:
  "Flagged Scriptorium gets a surface: an interim frame with the context and
  chat panes"
description:
  Replace the kit path's placeholder page with a thin interim frame holding the
  kit's context sidebar, chat, Notes and Tasks; hide, make-set and the move plan
  go in through menuActions and the confirm slot. The frame is thrown away at
  the shell cycle.
status: stable
lifecycle: triage
id: 01a14bca-1792-702e-9950-a08158191b3f
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-17 }
tags: [kit, story-studio, scriptorium]
parent: feature/workspace-kit
cycle: 2026-10-panes
---

# Flagged Scriptorium gets a surface: an interim frame with the context and chat panes

Today the kit path (`SCRIPTORIUM_KIT=1`) opens a page that says it has no
surface. This cycle gives it one: a thin interim frame of about 150 lines,
holding the kit's `ContextSidebar`, `ChatSidebar`, Notes and Tasks
([port shape, §2b](workspace-stack-port-shape/write-up.md#2b-the-cycles)). The
document pane arrives in cycle 4 and the shell in cycle 5. The frame is thrown
away then, so it is kept small.

Scriptorium's wiki verbs reach the human through the panes' slots:

- hide and unhide, and make-set, through `menuActions`;
- the move plan, through the pre-move confirm slot.

## Definition of done

- [ ] `open` on the kit path, without `--no-open`, shows the frame: the context
      tree, chat with the composer, Notes and Tasks. It carries the scroll-text
      favicon.
- [ ] The human can chat with the agent, add and remove sets, hide and unhide,
      make a set, and move with the plan confirm, all against the kit daemon.
- [ ] The centre says the document pane comes in the next cycle. Opening a
      document doesn't fail silently.
- [ ] A browser check drives the main gestures on a scratch home, and the gate
      and acc are green.
- [ ] The shipped Scriptorium is unchanged.
