---
type: item
title: Port Story Studio's via and refs into the kit daemon
description:
  'Port the workspace half of Story Studio''s bbc54fd (a message''s via and
  refs) and of 4e6d4d4, and move the one-ask guard from about.ask to via: "ask".'
status: stable
lifecycle: ready
id: 01a1478f-325f-7538-8b08-92d7bd9f7ca2
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-16 }
tags: [kit, scriptorium]
cycle: 2026-10-wiki-layer
parent: feature/workspace-kit
---

# Port Story Studio's via and refs into the kit daemon

Story Studio landed `bbc54fd` after our port base. A message now says which
gesture sent it (`via`: `chat`, `describe`, `fix` or `ask`) and what it draws on
(`refs`). It also landed `4e6d4d4`, which saves an edit overtaken by the agent's
version switch where it was typed. Both touch `packages/kit/src/workspace` as
well as the panes. This item ports the workspace half of each, so cycle 3 ports
panes onto a daemon that already speaks the current wire.

Cole's rulings in Story Studio apply: `KIT_VIA` is `chat`, `describe`, `fix` and
`ask`; buttons don't carry held refs; tree refs mark the chip; there are no
folder refs; and only modifier-selected rows count as refs.

`0ff5698` (a pending edit sent before a version switch) touches only the context
and document panes, so it goes with cycles 3 and 4.

## Definition of done

- [ ] The workspace files of `bbc54fd` and `4e6d4d4` are in `src/kit/workspace`,
      with their tests. Each difference from Story Studio is named in this item,
      with the reason.
- [ ] The one-ask guard (`askOutstanding`) arms only on a human's `via: "ask"`.
      `about.ask` is gone from the wire, the guard and the tests. A test fails
      if the guard counts an agent's message or a non-ask `via`.
- [ ] The flagged Scriptorium passes its suites and acc on the new wire. The
      SKILL delta in `scriptorium-on-kit-daemon` is updated for `via` and
      `refs`.
- [ ] The default path is unchanged (no diff in help, verbs, a scripted tail or
      boot errors).
