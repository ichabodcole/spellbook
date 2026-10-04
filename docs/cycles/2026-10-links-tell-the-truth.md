---
type: cycle
title: Links tell the truth
description:
  "Port Story Studio's fixes for Scriptorium's link extraction, resolution and
  reporting, plus the one-folder workspace and the trust badge (#122–#124, #126,
  #128, #130, #131)."
tags: [scriptorium, links]
status: draft
lifecycle: active
started: 2026-10-04
appetite:
  Stop when the seven issues ship as ports of their Story Studio fixes and a
  no-stake verifier has driven them on the shipped launcher and in a real
  browser; anything that grows a design question is filed, not stretched.
after: []
generated: { by: claude-opus-5-5, at: 2026-10-04 }
---

# Links tell the truth

## Why now

Cole filed thirteen Scriptorium issues on 2026-10-03 and 2026-10-04, each a
port-back of a fix Story Studio's kit already made (the kit was ported from
Scriptorium). Seven of them are correctness: links that resolve against the
wrong document or report the wrong state, and two defaults his use found wrong.
They come first because the link features in the next cycle build on the
extraction fix (#126). Cole agreed the three-cycle split on 2026-10-04.

## Scope

- **[item/scriptorium-links-tell-the-truth](../items/scriptorium-links-tell-the-truth.md)**
  — seven issues, each ported from the Story Studio commit it names:
  [#126](https://github.com/ichabodcole/spellbook/issues/126) (extraction
  ignores code, escapes and comments; finds the missing link shapes; linear line
  counting), [#122](https://github.com/ichabodcole/spellbook/issues/122) (a chat
  link resolves against its own origin),
  [#123](https://github.com/ichabodcole/spellbook/issues/123) (a link to a
  folder is a folder),
  [#124](https://github.com/ichabodcole/spellbook/issues/124) (following a link
  reveals the document in the tree),
  [#128](https://github.com/ichabodcole/spellbook/issues/128) (`dangling`
  reports non-web schemes),
  [#130](https://github.com/ichabodcole/spellbook/issues/130) (one opened folder
  is the workspace, E67) and
  [#131](https://github.com/ichabodcole/spellbook/issues/131) (no "unverified"
  from a missing field, E69).

Out of scope, deliberately: the link features (#125, #127, #129, cycle two);
agent presence, Compare and the file lifecycle (#132, #133, #134, cycle three);
the queued [reply-shape leftovers](2026-09-reply-shape-leftovers.md), which
follow this cycle.

**Release:** caller-visible: graph, backlinks and dangling output change (#126,
#128), `link.open` gains `from: "chat"` (#122), a `folder` link state (#123),
and the default workspace (#130). The release note lists each.

## Decision log

Decisions as they are made, with the options not taken.

| #   | Date       | Decision                                                                                                                                                                                                                                                                                                                                                                                         | Options not taken                                                                                                                  |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 2026-10-04 | Cole: thirteen issues in three cycles by shared code; this one first, then reply-shape leftovers, then links-you-can-see-and-make and the-agent-at-the-table. His rulings E67 (one folder is the workspace), E68 (human-only Move to Trash), E69 (the trust badge) and E70 (the features pass the real-use rule) are in the Scriptorium decision log.                                            | One cycle for all thirteen (a design-free batch mixed with three features); reply-shape first (Cole's use argues for Scriptorium). |
| 2   | 2026-10-04 | Convened. Two implementers in parallel, split by code: one on the link backend (#126, #123, #128: `links.ts`, extraction, `dangling`, the doctor), one on the surface and `open` (#122, #124, #130, #131: `App.tsx`, the tree, `cli.ts`, the header). Each ports from the named Story Studio commit, not from scratch. Then one no-stake verifier on the shipped launcher and in a real browser. | One per issue (seven agents, mostly in two files); one for all seven (serial, and #126 is the long pole).                          |

## Outcome

_Written at close._

## Sessions
