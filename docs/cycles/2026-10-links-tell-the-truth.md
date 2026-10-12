---
type: cycle
title: Links tell the truth
description:
  "Port Story Studio's fixes for Scriptorium's link extraction, resolution and
  reporting, plus the one-folder workspace and the trust badge (#122–#124, #126,
  #128, #130, #131)."
tags: [scriptorium, links]
status: draft
lifecycle: closed
started: 2026-10-04
appetite:
  Stop when the seven issues ship as ports of their Story Studio fixes and a
  no-stake verifier has driven them on the shipped launcher and in a real
  browser; anything that grows a design question is filed, not stretched.
after: []
generated: { by: claude-opus-5-5, at: 2026-10-04 }
closed: 2026-10-12
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

| #   | Date       | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Options not taken                                                                                                                                                                                                                                                                                                           |
| --- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 2026-10-04 | Cole: thirteen issues in three cycles by shared code; this one first, then reply-shape leftovers, then links-you-can-see-and-make and the-agent-at-the-table. His rulings E67 (one folder is the workspace), E68 (human-only Move to Trash), E69 (the trust badge) and E70 (the features pass the real-use rule) are in the Scriptorium decision log.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | One cycle for all thirteen (a design-free batch mixed with three features); reply-shape first (Cole's use argues for Scriptorium).                                                                                                                                                                                          |
| 2   | 2026-10-04 | Convened. Two implementers in parallel, split by code: one on the link backend (#126, #123, #128: `links.ts`, extraction, `dangling`, the doctor), one on the surface and `open` (#122, #124, #130, #131: `App.tsx`, the tree, `cli.ts`, the header). Each ports from the named Story Studio commit, not from scratch. Then one no-stake verifier on the shipped launcher and in a real browser.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | One per issue (seven agents, mostly in two files); one for all seven (serial, and #126 is the long pole).                                                                                                                                                                                                                   |
| 3   | 2026-10-04 | Integrated both (surface `d857c933`…`81f4eac0`, backend `f06ead3c`, `5d2ebd75`, `dc6fa027`, dist `89b0e656`); two test-file conflicts in `session.test.ts` kept both sides; gate 3250/0. Accepted the implementers' divergences from Story Studio: #122 resolves in the session (document's folder, then the set's root) and leaves `resolveTarget` alone; #131 changes only the display, because `meta` and `state` show the tier to agents; a trailing slash means a folder only; the kit's `Chapter2:intro.md`-is-a-path rule is not ported, because the surface still strikes through anything scheme-shaped and the two must agree, so `tel:`, `ftp:` and `javascript:` are reported as unsupported too; frontmatter `op:` values stay unreported (the issue covers body links). Dropped the `Closes #N` lines: issues are answered and closed after the release, as before.                                                                                                                                                                                                                                                                                                                     | Port the kit's `origin` parameter into `resolveTarget` (collides with #123 in the same function); change the derived tier in the data (agents read it); port the scheme rule to the backend alone (`dangling` would call a struck-through link resolvable).                                                                 |
| 4   | 2026-10-04 | No-stake verifier on the shipped launcher and in Playwright: #122, #124, #128, #130, #131 **held**; #126 and #123 **partly**. No data loss. Second round, because each is a wrong answer to an agent inside this cycle's own claims: indented code inside a list item or blockquote still counts as links; a link wrapped around an image (`[![b](i.png)](./real.md)`) is never an edge; a code span across two lines still counts; `//host/x` is reported as a dangling path; `./v1.2` picks the folder over `v1.2.md` (introduced by #123: `extname` reads `.2`); `open world world` counts arguments, not distinct folders; a chat link into another open set is told to add a folder that is already there, and a missing file is called "not in this set"; SKILL.md overstates the chat link (the open document's folder is tried first) and does not say `graph` lines count from the body while `dangling` counts file lines. Filed, not fixed (predate the cycle, cosmetic): toasts that never time out, a search line listed twice, `backlinks` repeating a source per link, `C:/win/path.md` read as scheme `c`.                                                                            | Close with the eight as known gaps (four are this cycle's own claims failing); fix the cosmetic four here (outside the appetite).                                                                                                                                                                                           |
| 5   | 2026-10-04 | Round two integrated (session `70236c17`…`6797dccd`, extraction `586ed4c0`…`67f08398`, dist rebuilt); gate 3269/0. Accepted: code is now found with micromark+GFM, the parser the surface renders with, so the CLI and the view cannot disagree on what is a link. Its cost: about 2 ms per 11 KB document on request (graph, dangling, doctor; a fast path skips text with no backtick, tilde or indent) and `dist/server.js` from 792 KB to 1.81 MB; the second verifier times a real set. A link resolves into any open context entry, from chat or from a document, as Story Studio's kit does (graph and dangling still read one set). Toasts say "does not exist" with the path tried, or "outside this session's context". E67 counts distinct folders by realpath. The extraction fixes are not ports: the kit has all five defects, so they are worth porting back.                                                                                                                                                                                                                                                                                                                          | Extend the line scanner by hand for list and quote indentation and multi-line spans (a second parser that can drift from the renderer); keep document links inside their own set (the kit does not, and no ruling asks it); pin NODE_ENV for backend builds here (touches every spell's daemon; a build change of its own). |
| 6   | 2026-10-04 | Second verifier: round two's claims 2–6 **held**, 1 and 7 **partly**; round one's regression pass held; 40,000 random documents found no disagreement with the renderer outside HTML. Round three, because each is a wrong answer to an agent on a real set: an unclosed inline `<!--` hides every later link (introduced by #126); `graph` and `dangling` throw `ENAMETOOLONG` on this repo's own `docs/` (a frontmatter `description` with a `/` read as a path) while `doctor` reports nothing; `buildGraph` stops at 400 documents without saying so; and the micromark extraction costs about 3 s per link verb on 550 files (1.9 s of extraction against 43 ms in round one; the fast path rarely fires, most documents have a backtick). Round three measures micromark's production build and a per-file cache before that cost goes to Cole. SKILL.md's "any document in the context" is narrowed: bare names and `type/slug` keys read one set. Filed, not fixed (pre-existing, a design of their own): links inside HTML blocks counted, `[x](<./a.md)`, `&amp;` targets, reference-style and doubly nested links missed, a bare name searching one set, a symlinked folder entered twice. | Accept 3 s now (a cost for Cole, not the team, and not yet measured with the obvious remedies); go back to the line scanner (reopens the list and quote defects); fix the HTML-block shapes here (pre-existing, and HTML handling is its own question).                                                                     |
| 7   | 2026-10-04 | Round three integrated (`971d947a`…`7f9acf65`, dist `9a9c81f7`); gate 3290/0. Comments found by the renderer's parser (200,000 random documents, 0 disagreements); a prose frontmatter value (a line break, over 255 bytes, or prose-shaped with spaces) is not a reference, and no disk error aborts the graph; doctor findings `links.unread` and `links.partial`; the 400 cap removed (it bought only speed; the mirror's 2000 bound remains and is now stated as `truncated: {read, of}` with a `hint`); backend builds pin `NODE_ENV` (every other daemon rebuilt byte-identical); a per-file cache by path, mtime and size. On 550 files: first link verb 1.58 s, then about 70 ms (from 3 s each, and a throw). The cap is a cost and goes to Cole: no cap (shipped), a cap of 1000, or a cap on the surface's payload only. Filed: a label ending a line before a list line, links in table cells past the header's count, pdocs `feature/<slug>` keys not resolving.                                                                                                                                                                                                                         | Keep the cap at 400 silently (the defect); the line-scanner fast path (not shown equivalent to the renderer, and the cache makes it unnecessary); a scriptorium-only NODE_ENV route (the shared pin changed no other daemon's bytes).                                                                                       |
| 8   | 2026-10-04 | Third verifier: comments (25 shapes, browser and `graph` identical), no cap (600 and 2,500 documents; both hinted remedies work), build (bounty, grapevine, digestify, glamour start under scratch homes), speed (first `graph` 1.62 s, then 0.08–0.10 s) and SKILL.md **held**; frontmatter, doctor and cache **partly**. Round four for the two regressions this cycle made: the prose rule drops real path references with a comma, a dash, an anchor or a spaced folder (fix: a value starting `./`, `../` or `/` is always a path); the cache misses an edit whose exact mtime is restored (fix: add ctime and inode to the stamp). Filed (pre-existing): an absolute filesystem path in a link is joined onto the set root and reported missing; an unreadable document's links vanish with nothing said; `links.partial` stays after the `add` remedy until the folder is also hidden. `links.unread` could not be made to fire end to end; its unit tests stand.                                                                                                                                                                                                                              | Close with the two as known gaps (both are this cycle's own regressions); fix absolute-path links here (pre-existing, and how an absolute path should resolve is its own question).                                                                                                                                         |
| 9   | 2026-10-04 | Round four integrated (`3a713096`, `c8a24aac`, dist `e055f8e0`); gate 3293/0. A frontmatter value starting `./`, `../` or `/` is a path again whatever its punctuation; the links cache keys on ctime and inode too. Both fixes are pinned by red-first tests built from the verifier's repros, and the implementer ran a scratch copy of `docs/` through the rebuilt launcher (124 dangling, 39 from frontmatter, all the filed `feature/<slug>` keys; none prose-shaped). No fourth verifier: the change is two guards in code three verifiers have already driven, and each repro is now a test. Filed: the frontmatter summary cache (`metaCache`) keys on mtime only, since 2026-09-11.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | A fourth no-stake verifier (two narrow guards, each pinned by its repro; the appetite is spent).                                                                                                                                                                                                                            |
| 10  | 2026-10-12 | Cole: no cap on `buildGraph` for now (what shipped in round three). The mirror's 2000 bound stays, stated as `truncated: {read, of}` with a `hint`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | A cap of 1000; a cap on the surface's payload only.                                                                                                                                                                                                                                                                         |

## Outcome

Closed 2026-10-12. All seven issues shipped: five held at the first no-stake
verifier, and #126 and #123 held after the fixes that followed. Four rounds of
fixes went through three verifiers, on the shipped launcher and in Playwright.
Gate 3293 pass, 0 fail. No data loss in any round.

**Shipped.**

- **#126, link extraction:** the renderer's own parser (micromark + GFM) finds
  code and comments, so the CLI and the view agree on what a link is. 200,000
  random documents found no disagreement outside HTML blocks. A link wrapped
  around an image is an edge. A prose frontmatter value is not a reference, but
  one starting `./`, `../` or `/` always is.
- **#122:** a chat link resolves against its own origin (`link.open` with
  `from: "chat"`), and a link may resolve into any open context entry, as the
  kit's do. Toasts say "does not exist" with the path tried, or "outside this
  session's context".
- **#123:** a link to a folder is reported as a folder (new `folder` state).
  `./v1.2` finds `v1.2.md` before a folder of that name.
- **#124:** following a link reveals the document in the tree.
- **#128:** `dangling` and the doctor report non-web schemes as `unsupported`.
  `tel:`, `ftp:` and `javascript:` are reported too, because the surface strikes
  them through.
- **#130 (E67):** one distinct folder, counted by realpath, is the workspace.
- **#131 (E69):** the trust badge shows only on a document with a `verified`
  field.
- **Not in Scope:** `graph` has no document cap (Cole, 2026-10-12, decision 10).
  The mirror's 2000 bound says when it is hit with `truncated: {read, of}` and a
  `hint`. New doctor findings `links.unread` and `links.partial`. A links cache
  keyed on path, mtime, ctime, inode and size: on 550 files the first link verb
  takes 1.6 s and later ones about 0.1 s. A shared build fix: every daemon is
  built with `NODE_ENV` pinned to production. All other daemons rebuilt
  byte-identical.

**For the release note:** graph, backlinks and dangling output changes (#126,
#128, `truncated`), `link.open` gains `from: "chat"`, links gain a `folder`
state, `dangling` gains `unsupported`, doctor gains `links.unsupported`,
`links.unread` and `links.partial`, and the default workspace changes (#130).
`dist/server.js` grows from 792 KB to 1.81 MB (micromark).

**Carried over:** the pre-existing defects the verifiers found, appended to
[scriptorium-chat-and-toast-nits](../items/scriptorium-chat-and-toast-nits.md)
(backlog). Among them: HTML-block links, reference-style links, absolute
filesystem paths, pdocs `feature/<slug>` keys, and `metaCache` keyed on mtime
only.

**Learned.** "Port the fix" understated it. The kit had all five extraction
defects round one found, so three rounds of extraction work were new design.
Those fixes are worth porting back to Story Studio. Two of round three's own
fixes (the prose rule and the mtime cache) were regressions that only the next
verifier caught. A rule that skips input (prose is not a path, a stamp means
unchanged) needs an adversarial pass, the same lesson as the last cycle's
lenient comparison. Once a parser change has a performance cost, measure the
obvious remedies before taking the cost to Cole: the per-file cache turned 3 s
into 0.1 s.

## Sessions
