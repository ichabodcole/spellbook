---
type: item
title: A Scriptorium session shows what it's for
description:
  With no home workspace, a session no longer shows which project it belongs to;
  give a session a title, a description and a colour the agent picks, editable
  by the human and shown in the tab title, a favicon tinted with that colour and
  the page, so several open sessions can be told apart.
status: stable
lifecycle: backlog
id: 01a165a8-0926-73e9-b7c5-b5b593e6c0b7
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-22 }
tags: [kit, scriptorium, sessions]
parent: feature/session-identity
from: cycle/2026-10-cutover
priority: high
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

**Added 2026-11-17** (the
[session-identity](../features/session-identity/feature.md) feature). Cole runs
Scriptorium in parallel more than any other spell: several tabs at once, across
projects and within one. The strongest cue for switching tabs is **colour**. A
session gets a colour as well as a title, and **the favicon takes the session's
colour**, so purple is one session and orange another. That belongs to
Scriptorium first. Other spells keep their brand-coloured favicon
([spell-favicons](spell-favicons.md)).

**Decided (Cole, 2026-11-17):** the agent picks the colour for each session, not
from the project, and the daemon defaults to one no other live session is using.
The favicon's glyph never changes, only its tint, so a tab always reads as
Scriptorium. There is no project field: the title says what the session is
about.

**The colour, kept simple (Cole, 2026-11-17).** He keeps about three Scriptorium
tabs open, not twenty, so:

- **Five preset colours.** No free choice by default.
- **Nobody has to pick.** At `open`, the daemon picks a preset that no live
  session is using. The agent passes a colour only to override that.
- **No two live sessions share a colour.** It looks like the daemon can see
  every live session without the agent: each session publishes a pointer with
  its pid (`src/kit/wire/discovery.ts`, `pointerPath`), and `pidAlive` tells a
  live one from a dead one. The research confirms this.
- **When all five are taken** (rare): reuse the colour of the oldest session,
  allow a custom colour, or something else. The design decides.
- **Whether a tinted favicon works at all** is part of the question. If the
  mockups show the tint is too faint at tab size, another cue replaces it.

## Definition of done

- [ ] Mockups of two or three ways to show a session's identity, covering the
      header, the tab title and a session-tinted favicon, with the five presets
      shown at real tab size in light and dark. Cole picks one, or rules the
      tint out. The design covers the title and description, what happens when
      all five colours are taken, and how this relates to the cleanup item's
      lifecycle.
- [ ] `open` takes a title and a description, and an optional colour from the
      presets. With no colour, the daemon picks a preset no live session is
      using. A test opens several sessions and checks that no two live ones
      share a colour. A verb changes the title, description and colour, and the
      human can edit them in the page. With no title, it defaults to the opened
      folder's name.
- [ ] The tab title and the tinted favicon show them, and so does the place in
      the page the design chose. Two open sessions can be told apart from the
      tab strip alone.
- [ ] They survive restore. The SKILL tells the agent to set them when it opens
      a session.
