---
type: item
title: A Scriptorium session shows what it's for
description:
  With no home workspace, a session no longer shows which project it belongs to;
  give a session a title and description (and its project), set by the agent at
  open and editable by the human, and show them in the page so the human can
  tell sessions apart.
status: draft
lifecycle: triage
id: 01a165a8-0926-73e9-b7c5-b5b593e6c0b7
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-22 }
tags: [kit, scriptorium, sessions]
parent: feature/workspace-kit-follow-ups
from: cycle/2026-10-cutover
---

# A Scriptorium session shows what it's for

Cole, in his cutover trial (2026-10-22). The shipped Scriptorium showed a
workspace folder path. Glancing at it told him which project a session belonged
to. The kit Scriptorium has no home workspace, so that cue is gone. With several
sessions open it is hard to tell which is which. The context list doesn't help
either, because it shows relative labels such as `docs/items` rather than full
paths.

He thinks the old cue wasn't ideal, and that something more intentional would
serve better. The problem it solved is the same: what is this session for, which
project is it about, and what does it cover?

**The direction (to design):**

- A session has a **title and a description**, which the agent writes when it
  opens a session (it knows the purpose) and the human can edit.
- The **project** it relates to, if that is not just derived from its sets.
- They are **shown in the page** (the header or the browser tab) so the human
  can orient at a glance, and in any session list.

This is the same metadata layer
[scriptorium-session-cleanup](scriptorium-session-cleanup.md) asks for, a
description plus a lifecycle, so the two should be designed together. This item
is the orientation half: what the human sees in an open session.

## Definition of done

- [ ] A design for session metadata (title, description, project, and how they
      relate to the cleanup item's lifecycle), agreed with Cole.
- [ ] `open` takes a title and a description, a verb changes them, and the human
      can edit them in the page.
- [ ] The page shows them where the human looks to orient, including the browser
      tab title.
- [ ] They survive restore. The SKILL tells the agent to set them when it opens
      a session.
