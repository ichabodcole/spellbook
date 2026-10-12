---
type: write-up
title: What to take back from Story Studio
description:
  "Which of Story Studio's kit, Atlas and practice changes Spellbook should port
  back: each candidate with its evidence and a call to make."
tags: [scriptorium, kit, story-studio]
status: stable
generated: { by: claude-opus-5-5, at: 2026-10-12 }
---

# What to take back from Story Studio

## How to use this

Each candidate ends with a **Call** line. Write yours there: `take`, `later`, or
`skip`, plus anything it needs. Select a passage and ask in chat if you want me
to check something first.

Paths and shas are in Story Studio (`~/Projects/dreamwood/story-studio`) unless
they say Spellbook. Sizes are S, M, L. Three read-only agents made the scan on
2026-10-12: one on the kit, one on Atlas against Scriptorium, one on practices
and tooling. Nothing here was run; every claim is from code, commits and docs.
Issues #122–#143 are already filed and are not repeated.

## Decided

- **Everything that needs no looking into is taken** (Cole, 2026-10-12): they
  are general improvements. Canvas is skipped for now; three calls wait on a
  look first (E67 timing, skill-example tests, parallel tests).
- **The UI affordances Cole named** are filed already: the Compare minimap is in
  #133, the link-health strip is #129, and the split raw/rendered view (16f8036)
  comes with B in the kit's document module.
- **B, re-base** (Cole, 2026-10-12): Spellbook's kit takes Story Studio's
  generic workspace, shell, context, chat and document modules, ported as they
  are but not blindly. Most Scriptorium and kit candidates below come with it
  and are marked so; those still need your yes. The practices section is
  independent of B and still open.

## The strategy question

Story Studio's kit is mostly **Scriptorium made generic**: `workspace` (the
daemon, 4,332-line server), `shell` (the three-pane layout), `context`, `chat`
and `document` (the panes), each with slots an app fills. Atlas and Sound Stage
both run on it.

- **A. Cherry-pick.** Port specific pieces into Scriptorium's own code, as the
  links cycle did. Small, steady, and each port is checked on its own.
- **B. Re-base.** Rebuild Scriptorium on a generic workspace/shell kit in
  `src/kit`. Large; a second spell could then reuse Scriptorium's layout, and
  later Story Studio fixes would port nearly as they are.

Recommendation: **A**. There is one consumer, and the house rule is to extract
on duplication. The exception is the UI primitives (below), whose duplication
already exists: button and dialog are copied into five spells.

**Call:** **B** (Cole, 2026-10-12). Port Story Studio's kit modules as they are,
but not blindly: each module is read for Story-specific assumptions, renamed
back (`app` → `spell`, env names), and merged with where Spellbook is ahead (the
links-cycle fixes, `by: human`, the `--` warning). Mind-mapper and Scriptorium
are the first consumers.

## Needs a ruling first

### E67 and the workspace/set overlap

E67, shipped in the links cycle, makes one opened folder the workspace. Atlas
found that folder is then also a set, which confuses drops and the sidebar. On
2026-10-06 Cole ruled there that a workspace may not be a set's folder or inside
one, and `open <folder>` makes the containing folder the workspace (fallback:
the session's `imported/`). Evidence: 8696830,
`docs/items/kit-workspace-set-overlap/item.md`, `overlapOf` in the kit's session
code. Scriptorium follows E67, so it likely has the overlap; not yet reproduced.
Story Studio's later "workspace holds the files" model
(`docs/features/workspace-folders/`) is a different paradigm and is skipped.

Next step: reproduce in Scriptorium, then rule whether a new E-number supersedes
E67.

**Call:** reproduced 2026-10-12: every `open <folder>` overlaps (details in the
item). Ruling pending: supersede E67 with Atlas's rule, build it with B or fix
it now.

## Quick wins

Small, generic, no dependency on the kit modules Spellbook lacks.

### Changed on disk needs an action

Scriptorium shows only a status word (`DocumentPane.tsx:248`). The kit shows a
toast with **Reload** and **Keep**, worded for whether there are unsaved edits
(`packages/kit/src/chat/OutsideChangeToasts.tsx`, `outsideChange.ts`). A warning
with no act breaks the house rule. S.

**Call:** **take** (Cole, 2026-10-12), with B.

### ViewBoundary

A 51-line error boundary (`document/ViewBoundary.tsx`, e22666e), so a view that
throws costs that view, not the page. Scriptorium has none. S.

**Call:** **take** (Cole, 2026-10-12), with B.

### The rendered view's first scroll is O(n²)

`lineAnchors` → `sourceLine` → `lineAt` counts from the start for every block:
1.5 s on 5,500 lines. Open in Atlas too
(`docs/items/kit-rendered-line-anchors-cost.md`). Scriptorium has the same code
(`state/place.ts:93`, `projection.ts:427`). Fix once, port to both. S.

**Call:** **take** (Cole, 2026-10-12): fix it in the ported kit and send the fix
back.

### Word count includes frontmatter

`docs/items/frontmatter-followups.md`; Scriptorium's `contentStats` counts the
raw text. S.

**Call:** **take** (Cole, 2026-10-12): count body content only, never
frontmatter, whichever `contentStats` the re-base keeps.

### Daemon stop skips the drain wait when nothing is open

Spellbook's `src/kit/wire/housekeeping.ts:209` always waits 150 ms. Story Studio
skips it with no tail, socket or request open (6501b25, from Image Farm); their
serial suite went from 292 s to 180 s. Every spell. S.

**Call:** **take** (Cole, 2026-10-12), with B.

### Three small wire pieces

- `startDaemon`: spawns a fully detached daemon, stderr to a log, waits for a
  ready line, quotes the log on failure. Fixes a hang where the daemon holds the
  CLI's stderr pipe. Check each spell's own spawn first.
- `stdinWaiting` (`wire/stdinPeek.ts`): `version-new` refuses text piped without
  `--stdin` instead of dropping it (373fb34).
- Every human `message` on the tail carries a reply hint: say, task, or both
  (c2a6e12, `replyHint.test.ts`). Scriptorium's has none.

S each.

**Call:** **take** (Cole, 2026-10-12), with B.

### Duplicate, with Finder-style names

c0e2e5f. S.

**Call:** **take** (Cole, 2026-10-12), with B.

## Scriptorium features not yet filed

### Quiet tail

Each event type declares whether it wakes the agent (`workspace/events.ts`,
`TailRule`, c2a6e12). Opens and map views are quiet and ride the next message as
`about`; `saved` wakes only when it overtakes the agent's own work, with a
`because`; `tail --all` still gets everything. Scriptorium sends every `saved`,
`activated` and `system`. This is the ambient-vs-intent rule in code; both the
kit and Atlas scans ranked it first. M.

**Call:** **take** (Cole, 2026-10-12), with B.

### Rename or move updates the links it breaks

Broken links and embeds are listed, and `--update-links` or a `relink` verb
rewrites them in the same act, under one undo. Held documents keep unsaved
edits. e990de3, `context/RelinkBar.tsx`, `workspace/relink*.test.ts`.
Scriptorium's rename and move rewrite nothing. L.

**Call:** **take** (Cole, 2026-10-12), with B.

### Links to headings

`#anchor` resolves by text, slug or parent path; following reveals the heading;
link-check reports missing and repeated headings; the picker offers headings;
Mod-click follows in the raw editor; `show --heading`. 12cb2a9,
`lib/headings.ts`, `lib/headingAnchor.ts`. Scriptorium strips the anchor. Builds
on #125 and #133. M–L.

**Call:** **take** (Cole, 2026-10-12), with B.

### Drag a tree row into a document

An image row embeds, a document row links (title as text, relative path), at the
drop point, as one undoable edit. e2b1965, `context/rowDrag.ts`. S–M.

**Call:** **take** (Cole, 2026-10-12), with B.

### Images in the tree

Images as their own tree kind with a fit/zoom/pan viewer (820bec7), loose images
(a0489f5), `<img>.md` description sidecars with a `describe-image` verb
(511ea61), WebP conversion and location/camera metadata stripped on import
(f316ec9). Builds on #139/#140. The viewer and the stripping are generic; the
Media Forge provenance is not. L.

**Call:** **take** (Cole, 2026-10-12): the kit parts come with B; which parts
Scriptorium turns on is decided when the item is shaped.

### Document profiles

Frontmatter checked against a JSON Schema per `type` (`_meta/profiles/`), a
header chip with "Ask the agent to fix", `profile-check`, a doctor finding.
3b248f6, 3efde9b, 5ac27b5. The `_meta/` naming is world-flavoured; the idea
pairs with #141 relations. L.

**Call:** **take, and Scriptorium turns it on** (Cole, 2026-10-12), tailored for
Scriptorium, without `_world.json`. Open: where the schemas live (Atlas uses
`_meta/profiles/`).

### Tasks the human creates, and cancel

`task.created` from the task panel, `task-cancel` → `task.cancelled`, failed and
progress states (`workspace/tasks.ts`). Built for Sound Stage renders; the
human-request half is generic. M.

**Call:** **take** (Cole, 2026-10-12), with B.

### JSON Canvas boards (later, its own feature)

A board in the centre column with agent verbs (`canvas-apply`, `add`, `connect`,
`group`), a review of what the agent changed, cards in the link layer, nested
boards. About fifteen commits from 80eb64e. Open format. Needs bundles and the
document pane's format-view slot. L.

**Call:** **skip for now** (Cole, 2026-10-12): useful, but Atlas-specific.

## Kit

### UI primitives on Base UI, and a component-test harness

The kit carries the full shadcn set plus combobox, popover, toast,
`StatusStrip`, `ImageViewer`. Spellbook copies primitives per spell (button and
dialog in five, context-menu in three). With it comes happy-dom testing
(`lib/testDom.ts`, `./testing-daemon` with `writeUntilSeen` for macOS FSEvents
lag). Spellbook's surface tests only render static markup. Spellbook's `Dot` and
`ConfirmDialog` look ahead of theirs. M.

**Call:** **take** (Cole, 2026-10-12), with B.

### Per-verb CLI help

`help <verb>` and `<verb> --help`, with `flagHelp`, `examples`, `requiredFlags`
on a registry row; required flags unbracketed in usage. Needs an acc re-run,
since the help shape and schema emitter change. S–M.

**Call:** **take** (Cole, 2026-10-12), with B, and an acc re-run for every
spell.

### Smaller kit pieces

- `wire/errors`: `EXIT_IDLE_TIMEOUT=124`, `EXIT_CANCELLED=130`; `ErrExtra`
  renames `server` → `details` (an API change across spells). S.
- Theme: `base.css` is 402 lines to Spellbook's 125 (light palette, prose and
  markdown styles, find and highlight, scrollbars, a prepaint script). Takeable
  without the L1 aliases Spellbook keeps out for imago. M.
- `lib`: `fuzzy`, `json`, `viewport`, `platform`, a micromark renderer. Take
  each when a second spell needs it.

**Call:** **take** (Cole, 2026-10-12), with B.

## Practices and tooling

### Run SKILL.md examples as tests

Every bash block in a skill runs against a real daemon with a fake provider
(`apps/sound-stage/skills.stage.test.ts`, `atlas.test.ts:670+`); examples run
under sh and zsh; `references/verbs.md` must list exactly the registered verbs.
Nothing in Spellbook runs skill examples. Weigh against the open
`skills-lean-on-cli-help` item. M.

**Call:** **take, after a look** (Cole, 2026-10-12: take what needs no looking
into). Settle first how it sits with `skills-lean-on-cli-help`.

### Parallel tests and the test-speed playbook

`bun test --parallel --timings=tests/timings.json`; by their notes the gate went
from about 292 s serial to about 22 s, then 15 s after removing waits.
`docs/playbooks/test-speed-playbook.md`: measure, parallelise, wait on
conditions not time, fix flakes at the cause with `--rerun-each=50`. Unknown:
whether Spellbook's daemons can share a parallel run. S–M.

**Call:** **take, after a look**: first check whether Spellbook's daemons can
share a parallel run (temp discovery pointers).

### Allow-list Biome roots

Their `biome.json` names only `packages/`, `apps/`, `tests/`, `scripts/`, so
`.claude/worktrees` is never scanned. Spellbook's deny-list is the cause of the
gate-vs-worktree failures. S.

**Call:** **take** (Cole, 2026-10-12).

### Delegated-phase playbook

`docs/playbooks/delegated-phase-playbook.md` writes down the loop Spellbook runs
from memory: brief, worktree reset onto the base, fake provider when no secret,
stop by `--session` never `pkill`, a no-stake reviewer who plants violations and
lists every command, fix rounds to the same implementer, a data-loss fix pinned
by a test that fails on revert. S.

**Call:** **take** (Cole, 2026-10-12).

### A compressed scaffolding playbook

Theirs is about 200 lines (design questions, fixed layout, a runnable
verification checklist) against Spellbook's 850 with 34 ⛔. A model for the
scaffold work, not a scaffold: they have no generator either. M.

**Call:** **take** (Cole, 2026-10-12).

### Shell rules for skills

Define the launcher as a function (`S() { bun …/cli.ts "$@"; }`), since zsh does
not word-split `$S`; write session ids as literals, never `<id>`, which the
shell reads as a redirect; generate `references/verbs.md` from `help`. Belongs
in `grimoire/house-style.md`. S.

**Call:** **take** (Cole, 2026-10-12). The first post in this review hit it:
`$S` failed under zsh.

### AGENTS.md and tone

Their AGENTS.md says it does not track work (read the board) and leaves out
anything discoverable. Their docs use no ⛔ or capitals for emphasis;
Spellbook's playbooks and wards use many. A house-style call, not a rule to
copy.

**Call:** **take one thing** (Cole, 2026-10-12): AGENTS.md does not track work,
and stays minimal and low-churn. Tone is unchanged.

## Skipped

- Story-specific: cues (narration pauses), world and impact check, Sound Stage,
  Media Forge provenance, the workspace-holds-the-files model.
- No real-use signal yet: bundles, `pushLoop`.
- Discovery's fallback to the newest live session: the #137 failure itself.
- turbo, a gitignored `dist/` (Spellbook ships `dist/`), their release-please
  rule, `packages/studio`, the shared tsconfig package.

**Call:** skip, as proposed.

## The other direction

Story Studio's kit still has what Spellbook fixed, worth an issue in their repo:
the links-cycle extraction fixes (micromark, comments, the frontmatter prose
rule, the folder state, the links cache), `tailHandoff`'s `by: human` (4f14c499,
24a1fa74), and the registry's `--` warning (d0f22faf).

**Call:** **take** (Cole, 2026-10-12): filed in Story Studio as
`item/kit-port-back-from-spellbook` (fd06b41).

## Open questions

- Does Scriptorium's `open <folder>` register the folder as a set (the E67
  overlap)?
- Does Scriptorium already refuse stdin piped without `--stdin`?
- Atlas items that probably apply to Spellbook's kit, unchecked:
  `kit-watcher-missed-write-macos`, `ended-session-recovery`, `kit-surface-csp`.
