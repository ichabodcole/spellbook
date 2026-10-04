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

| #   | Date       | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Options not taken                                                                                                                                                                                                                                                                                                           |
| --- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 2026-10-04 | Cole: thirteen issues in three cycles by shared code; this one first, then reply-shape leftovers, then links-you-can-see-and-make and the-agent-at-the-table. His rulings E67 (one folder is the workspace), E68 (human-only Move to Trash), E69 (the trust badge) and E70 (the features pass the real-use rule) are in the Scriptorium decision log.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | One cycle for all thirteen (a design-free batch mixed with three features); reply-shape first (Cole's use argues for Scriptorium).                                                                                                                                                                                          |
| 2   | 2026-10-04 | Convened. Two implementers in parallel, split by code: one on the link backend (#126, #123, #128: `links.ts`, extraction, `dangling`, the doctor), one on the surface and `open` (#122, #124, #130, #131: `App.tsx`, the tree, `cli.ts`, the header). Each ports from the named Story Studio commit, not from scratch. Then one no-stake verifier on the shipped launcher and in a real browser.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | One per issue (seven agents, mostly in two files); one for all seven (serial, and #126 is the long pole).                                                                                                                                                                                                                   |
| 3   | 2026-10-04 | Integrated both (surface `d857c933`…`81f4eac0`, backend `f06ead3c`, `5d2ebd75`, `dc6fa027`, dist `89b0e656`); two test-file conflicts in `session.test.ts` kept both sides; gate 3250/0. Accepted the implementers' divergences from Story Studio: #122 resolves in the session (document's folder, then the set's root) and leaves `resolveTarget` alone; #131 changes only the display, because `meta` and `state` show the tier to agents; a trailing slash means a folder only; the kit's `Chapter2:intro.md`-is-a-path rule is not ported, because the surface still strikes through anything scheme-shaped and the two must agree, so `tel:`, `ftp:` and `javascript:` are reported as unsupported too; frontmatter `op:` values stay unreported (the issue covers body links). Dropped the `Closes #N` lines: issues are answered and closed after the release, as before.                                                                                                                                                                                                                                          | Port the kit's `origin` parameter into `resolveTarget` (collides with #123 in the same function); change the derived tier in the data (agents read it); port the scheme rule to the backend alone (`dangling` would call a struck-through link resolvable).                                                                 |
| 4   | 2026-10-04 | No-stake verifier on the shipped launcher and in Playwright: #122, #124, #128, #130, #131 **held**; #126 and #123 **partly**. No data loss. Second round, because each is a wrong answer to an agent inside this cycle's own claims: indented code inside a list item or blockquote still counts as links; a link wrapped around an image (`[![b](i.png)](./real.md)`) is never an edge; a code span across two lines still counts; `//host/x` is reported as a dangling path; `./v1.2` picks the folder over `v1.2.md` (introduced by #123: `extname` reads `.2`); `open world world` counts arguments, not distinct folders; a chat link into another open set is told to add a folder that is already there, and a missing file is called "not in this set"; SKILL.md overstates the chat link (the open document's folder is tried first) and does not say `graph` lines count from the body while `dangling` counts file lines. Filed, not fixed (predate the cycle, cosmetic): toasts that never time out, a search line listed twice, `backlinks` repeating a source per link, `C:/win/path.md` read as scheme `c`. | Close with the eight as known gaps (four are this cycle's own claims failing); fix the cosmetic four here (outside the appetite).                                                                                                                                                                                           |
| 5   | 2026-10-04 | Round two integrated (session `70236c17`…`6797dccd`, extraction `586ed4c0`…`67f08398`, dist rebuilt); gate 3269/0. Accepted: code is now found with micromark+GFM, the parser the surface renders with, so the CLI and the view cannot disagree on what is a link. Its cost: about 2 ms per 11 KB document on request (graph, dangling, doctor; a fast path skips text with no backtick, tilde or indent) and `dist/server.js` from 792 KB to 1.81 MB; the second verifier times a real set. A link resolves into any open context entry, from chat or from a document, as Story Studio's kit does (graph and dangling still read one set). Toasts say "does not exist" with the path tried, or "outside this session's context". E67 counts distinct folders by realpath. The extraction fixes are not ports: the kit has all five defects, so they are worth porting back.                                                                                                                                                                                                                                               | Extend the line scanner by hand for list and quote indentation and multi-line spans (a second parser that can drift from the renderer); keep document links inside their own set (the kit does not, and no ruling asks it); pin NODE_ENV for backend builds here (touches every spell's daemon; a build change of its own). |

## Outcome

_Written at close._

## Sessions
