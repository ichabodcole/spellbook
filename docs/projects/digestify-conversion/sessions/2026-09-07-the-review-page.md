# 2026-09-07 — the review page becomes a surface

**Agent:** Claude Opus 5 (1M context), as the implementing agent · **Branch:**
`feat/digestify-conversion` · **Mode:** brief-driven, single implementer;
orchestrator reviews, a separate no-stake agent verifies, Cole finalizes.

**This is the eighth and last spell to port.** When it lands, every spell in the
roster builds and the porting playbook's Applicability closes.

---

## What shipped, by sha

| chapter | sha    | what it is                                                                                                                                                                                                                                                       |
| ------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | `<c1>` | **The behaviour inventory** — 138 rows, and the coverage counter that reads them. Written before a line of the surface existed, because with no reactive shell it is the only enumeration this page gives.                                                       |
| 2       | `<c2>` | **The port** — `src/digestify/surface/`, the built `dist/`, the daemon that serves it, `template.html` deleted, and the three wards re-declared by hand. One chapter, because gate-honesty's pin moves once for both directions and neither half is green alone. |
| 3       | `<c3>` | **The records** — the decision log, the rewrite journal, the session record, the playbook's amendments, and the canon prose the port moved (`PROJECT-SUMMARY`, house-style's queue, the decay ledger), plus three backlog items.                                 |

## The numbers

|                                           | before                                       | after                                                                                                                |
| ----------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `bun run gate`, unpiped, exit from a file | **0** (on the second run — see below)        | **0**, 1,860 pass / 0 fail, 245 s                                                                                    |
| `bun scripts/dist-check.ts`               | 0 — **7** buildable spells, 23 tracked files | 0 — **8** buildable spells, 26 tracked files                                                                         |
| `tsc -p .`, error LINES                   | 717 lines, 29 TS2307                         | 717 lines, 29 TS2307 — the same two digestify errors at the same two sites, shifted 52 lines, both pre-existing      |
| resolve-sweep floor                       | 19                                           | **21**, predicted before Phase R; both new lines are `./MyComponent` in the arriving `dist/` bundle. Zero mine.      |
| gate blind set                            | 24 files / 2,949 lines                       | **26 files / 1,975 lines** — the only re-declaration in that ward's history where the set SHRANK while gaining files |
| seam census (both roots)                  | 0                                            | 0 — there was never a seam, and Contract 3 row 1 was re-grepped after every edit                                     |
| inventory                                 | —                                            | 138 rows: **128 driven in a browser, 5 by a cell, 5 not**                                                            |

**⚠ The Phase 0 baseline was green on the second run.** The first gate came back
exit 1 on `glamour/tests/cli-contract.test.ts` — expected exit 2, received 5 —
and passed in isolation and on a re-run of the whole suite. Filed as
`docs/backlog/2026-09-07-glamour-cli-contract-cell-is-flaky-under-the-full-gate.md`:
a cell that cannot distinguish "the contract broke" from "the machine was busy"
is a cell that can absorb a real regression later.

## What was driven, and how

A dependency-free CDP harness — ~150 lines of Bun launching the user's Chrome
headless with its own profile under the session scratchpad, attaching over
`/json/list`, speaking `Runtime.evaluate` and `Input.dispatchKeyEvent`. No
playwright, nothing installed. Eight probe scripts, all in the session
scratchpad and none committed.

Three instruments earned their place:

- **A `window.fetch` + `navigator.sendBeacon` hook installed before page load.**
  Digestify has no socket, so bounty's `window.WebSocket` shim has no subject;
  this is its counterpart, and it turns every "sends nothing" row from an
  inference into an assertion. Most silent-branch rows are claims about an
  absence, and you cannot check an absence by looking at it.
- **Patching `JSON.parse` in an init script.** The page's entire input is one
  JSON island parsed once, so intercepting the parse IS editing the payload.
  Four rows (an unknown theme, an empty session id, a zero timeout, a nested
  question marker) are unreachable any other way.
- **Typing per key, through the prototype's `value` setter.** Playbook R8's two
  scars, taken as given rather than rediscovered.

**All three themes were driven end to end**, in every mode the row required:
palette (`--color-bg` `#fff5f7` / `#15141e` / `#fafafa`), assets (and the folder
mismatch — `digestify` loads from `/assets/classic/`, `classic` loads nothing),
brand text vs wordmark image, submit and submitting copy, stamp lines (2 / 1 /
0), the question glyph (`"?"` / `"◉"` / `"?"`), `color-scheme`, the page texture
(2 gradients / 18 / none), and the sent screen's two branches.

**DOMPurify was proven live, not assumed.** A document carrying `<script>`,
`<img onerror>`, `javascript:` href, `<iframe>` and `<svg><animate onbegin>`,
plus a question prompt carrying its own script and image: **zero** globals set
across five distinct payloads, zero script elements, zero iframes, zero `on*`
attributes anywhere under `#doc`, and the `javascript:` href read `null`. Its
guard is split three ways on purpose — the composition
(`state/markdown.test.ts`), the sink census (`sinks.test.ts`), and this drive —
because Bun has no DOM and the real sanitiser cannot be exercised in a test at
all.

## The three defects my own drive found — all in code I had just written

Every one was invisible to reading, and every one shares a shape the playbook
did not describe: **correct at t=0 and wrong at t=1.**

1. **The document's syntax highlighting was wiped one second after it
   appeared.** React 19 re-applies `dangerouslySetInnerHTML` on EVERY update of
   the element carrying it — it does not compare the previous `__html`. The
   countdown's first tick re-rendered `App` and one `childList` mutation
   replaced the subtree. **The second consequence is worse than the first:** the
   comment chips' portal hosts live inside that subtree, so every chip would
   have been detached by the same mutation. Fixed by `memo`, pinned by a cell.
2. **Restored comment chips never appeared.** The restore ran in a
   `useLayoutEffect`, and React attaches a ref AFTER running that fiber's layout
   effect, walking children first — so `docRef.current` was `null` and the whole
   restore returned early. A fresh session looks identical.
3. **The "draft restored" banner never went away.** The four-second auto-hide
   had simply not been written.

A single screenshot reports all three green. The amendment that would have found
them is one line: **sample every visual row twice, seconds apart.**

## What I could not drive, and why — five rows

Each is written as a falsifiable claim, not a confession.

| row     | claim                                                                                                                                                | how to break it                                                                                                                              |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **S19** | the timer pill's expired-on-network-failure arm was driven only in its extend direction and its expired STATE                                        | **take this one first.** Kill the daemon under a loaded page and click the pill. No instrument needed, only two processes in the right order |
| **A7**  | the post-submit selection guard is unreachable — the sent screen removes `#doc` entirely                                                             | find a route to a selection after submit                                                                                                     |
| **X9**  | the sent screen's "headline plus ambient mascot" branch needs a theme with an ambient mascot and no sent mascot; no shipped theme is shaped that way | patch the theme table — which is patching the surface, not the payload, so `state/themes.test.ts` is the honest guard                        |
| **T15** | `--stamp-text` is dead in the OLD page (`grep -c 'var(--stamp-text)'` → 0 against three declaration sites) and was not carried                       | find a rule that reads it                                                                                                                    |
| **T16** | the ≤640 px `.brand-mark { font-size }` rule targets an `<img>`, and the one text lockup carries a different class                                   | make it apply                                                                                                                                |

## What was escalated

**Nothing.** All three escalation conditions were checked and none fired:

- **Contract 3.** `plugins/spellbook/skills/digestify/scripts/*.ts` imports
  `node:*`, `bun:test` and `./review.ts` — nothing else, before or after.
  Re-grepped after every edit. The backend stays Bun-native source.
- **A ward wrong about the spell.** Three wards red, all three stale pins, all
  three re-declared by hand. `spell-css-scope` stayed **green**, because
  bounty's port had already found and fixed the latent `group`/`peer` defect it
  would have hit — the brief's warning was correct advice that did not need to
  fire.
- **A bug in `template.html`.** Two found, neither fixed, both filed:
  `2026-09-07-a-stale-digestify-tab-can-cancel-the-session-that-replaced-it.md`
  and `2026-09-07-digestify-says-copied-when-the-clipboard-refused.md`.

**One deliberate deviation** is recorded rather than filed, because it is a
behaviour CHANGE and not a bug report: the theme lookup uses `Object.hasOwn`
instead of a truthiness test on a plain-object index, so `theme:"toString"` no
longer finds `Object.prototype.toString` and renders a wordmark reading
`undefined`. Unreachable through `review.ts`. Inventory row T4, decision log
D16.

## What the playbook got wrong, or was silent about, for an imperative page

Full detail in the rewrite journal; the short version:

- **R2 and R3 are written for a page with a reactive shell and were structurally
  SILENT here** — not wrong, silent, which is harder to notice. Both now carry a
  second shape.
- **R1's two greps find about a third of an imperative page.** The branches
  whose FALSE arm is a behaviour are the majority, and they need their own grep.
- **R5's transport sentence was wrong for a THIRD time, in a third shape.**
  Bounty proposed the fix — count your own — and it is now the text.
- **R5 says Contract 5 lands on whoever spawns the daemon. Nothing spawns this
  one.** And `process.chdir()` is not the repair: Bun reads `bunfig.toml` at
  process start, so chdir-then-import serves an unstyled page with a green boot.
- **R6's "four wards" is a count from two runs.** Three here.
- **R4's line-count expectation needs two exceptions**: a markdown prose block
  utilities structurally cannot reach, and a multi-theme spell's override
  blocks, which are data.
- **R8 needs "sample twice."**

## What the playbook should say now that the population is closed

Written last, and it is the question this session exists to answer.

1. **Say that it is closed, in the header and in Applicability — and say what
   that changes.** It has stopped being a schedule. The next subject is a spell
   that does not exist yet, and that spell has no old page, no fidelity ruling
   and no inventory to be faithful to. Phase R's whole premise is absent for it.
   Both are now written down.
2. **Split it, in the reader's head if not in the file.** What survives for a
   NEW spell is Phase 0 (instruments before the work), Phase S (the registry is
   where primitives come from), R0's destination shape, and R4's token layer.
   What does not is R1/R2/R3/R8, which are a rewrite's method. A reader who
   cannot tell those apart will spend a day writing an inventory of a page that
   does not exist.
3. **Keep the instrument scars and let them grow.** They are the most valuable
   paragraphs in the document — three agents have now been misled by an
   instrument before they were misled by a surface. The newest entry is not an
   instrument at all (React 19's `dangerouslySetInnerHTML`) and it belongs there
   anyway, because the EFFECT is identical: green drive, broken surface.
4. **Take bounty's amendment out of the journal and into the text,
   permanently.** "Counted by subtraction from the exemplar" has now failed
   three agents in two different sections. It is the single most reliable way
   this document goes wrong, and it goes wrong quietly, because a subtracted
   count is still a number.
5. **Stop predicting counts.** "Four wards", "two transports", "68 rows" — every
   number this document has stated as a prediction has been wrong for a later
   subject, and every one of them was right for the run that wrote it. State the
   METHOD and record the numbers as history, which is what the Version History
   section already does well.
6. **One thing it should NOT do: shrink.** The temptation with a closed
   population is to compress the phases into a checklist. Three of this port's
   five hardest moments were resolved by a sentence somebody wrote down after
   paying for it — the `url()`-is-a-build-input finding cost bounty two build
   failures and cost this port nothing at all. That is the document working, and
   it only works at length.

## Phase 3 — the local-sim, by hand

`git ls-files plugins/spellbook/skills/digestify` copied to `/private/tmp/`,
which has **no `node_modules` anywhere up-tree** (checked by walking to `/`).
Thirteen files: `SKILL.md`, six assets, three `dist/` files, three `scripts/`.

**The CLI's contract surface, with nothing installed.** Every error path exits
**2** and names what is wrong on stderr, with stdout empty:

| stimulus                  | exit | stderr                                                                 |
| ------------------------- | ---- | ---------------------------------------------------------------------- |
| `--nope`                  | 2    | `error: Unknown option '--nope'`                                       |
| `--theme nope`            | 2    | `error: invalid --theme 'nope' (allowed: digestify, cthulhu, classic)` |
| no stdin, no `--file`     | 2    | `error: no markdown provided on stdin, --file, or --reference`         |
| `--file /no/such/file.md` | 2    | `error: file not found: /no/such/file.md`                              |
| two questions with one id | 2    | `error: duplicate question id: 'a'`                                    |

**Mode, on the one transport it has.** The ready line reads
`{"url":…,"port":…,"session_id":"digestify-098ef912-p50804","mode":"release"}`.

**The board renders, from `dist/`, with nothing installed.** Driven under
`--theme cthulhu`: the tab title and header title are the review's, the wordmark
image LOADED (`naturalWidth 512`) from the daemon's own `/assets/` route, the
ambient mascot loaded (424), the question card is present, both cthulhu stamp
lines rendered, the fenced block is highlighted, **one** stylesheet, **zero**
inline `<style>` blocks, zero page errors.

**Forced dev at the surface-free destination dies cleanly.** Exit **2**, stdout
empty, stderr naming the directory and the reason, nothing bound, no session
directory left behind. ⚠ One wart worth naming: at the destination the message
resolves the needed cwd to `/src/digestify`, which does not exist there —
`SKILL_ROOT/../../../../src/digestify` is a repo-relative path and the copied
tree is not in a repo. The next two lines of the same message say exactly that
("a published spell ships a built `dist/` and resolves to release mode; dev mode
needs the repo"), so the message is still actionable, but the path is noise at
that destination. Left rather than fixed, because fixing it means amending a
commit that is not HEAD.

**The stylesheet remove-and-diff** (Phase 3's automatable proof, in bounty's
amended form — record the PAIR and the inline-`<style>` count, not a ratio):

```text
sampled 31 · changed 31 · stylesheets removed 1 · inline <style> blocks 0
```

The floor is 0 (no inline `<style>`), so any change proves the shipped sheet
reaches the browser; 31 of 31 is the whole sampled set.

## Handover

- The port is complete and green. **Not pushed, not merged** — orchestrator
  reviews, a no-stake verify agent drives the inventory again, Cole finalizes.
- The verify agent's highest-value first move is **S19** (kill the daemon under
  a loaded page, click the pill), then a **second sample of every visual row**,
  seconds apart — that is where all three of this port's defects lived.
- `skills-lock.json` and `.claude/skills/shadcn/` were never staged, stashed,
  committed or edited. `git status` is not empty and that is correct.
