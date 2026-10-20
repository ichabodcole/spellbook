---
type: item
title: The human can see that a set has broken links
description:
  On the kit path nothing in the human surface shows dangling or outbound links
  since the map dropped its header numbers; give the human a visible sign with
  an act attached.
status: stable
lifecycle: done
id: 01a15029-f5a7-7569-868c-047b2a7a562a
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-18 }
tags: [kit, scriptorium]
parent: feature/workspace-kit
from: cycle/2026-10-document-pane
cycle: 2026-10-shell
---

# The human can see that a set has broken links

The shipped map's header read "1 leaving the set · 1 dangling". The kit's map
(`scriptorium-kit-map-view`, document-pane cycle) drops both numbers. Nothing in
the human surface on the kit path now shows that a set has broken links: only
the agent's `link-check` and `doctor` do. Cole ruled on 2026-10-18 that the
human should see a sign of them, and that the sign should come with an act that
answers it.

GitHub #129 (link health in the status bar) is the obvious home, and the
workspace-kit feature says it lands on the ported panes.

## Definition of done

- [x] On the kit path, the human can see that a set or document has broken or
      outbound links, without asking the agent.
- [x] The sign offers an act, such as listing the links or opening each one at
      its line.
- [x] The count matches what `link-check` reports for the same set.

**Done and verified (2026-10-19, cycle 2026-10-shell).** New work on the ported
shell, no Story Studio port. Cole's ruling 3 of this cycle shaped it: one mark
for the whole session (the shell's `LinkCheck`), its list grouped by set, with
"leaving the set" added, each entry opening at its line.

- `feat(kit): the link check names each entry's set, places frontmatter references, and lists links leaving their set`:
  `link.check` (and so the `link-check` verb) tags every entry with `set` and
  adds `sets` (only the sets the answer names, in the context's order). It
  places each app edge where it is written (`locateEdges` in `linkEdges.ts`: the
  app's line, else the target's first whole occurrence in the frontmatter), so a
  broken frontmatter reference carries `line`, `from` and `to`. It adds
  `leaving`: body links and app edges that land in another set, or on a file in
  no set outside the source's set folder. `leaving` is kept out of `count`,
  since it is not broken; the `edge` filter applies to it.
- `feat(kit): the status bar's link check groups by set, ...`: the mark names "N
  broken frontmatter references" (the edges were already in `count` but never
  named or listed) and "N leaving the set", and its total adds the leaving
  links. The list keeps shared names as one session-wide section, then one group
  per set with its sections. A broken edge and a leaving link open their source
  at the place the daemon gives.
- `chore(dist)`: the rebuilt Scriptorium bundle.

After a no-stake verifier's round (verdict: with fixes), fixups on the same
branch:

- CRLF reveals now land on the named characters (`editorOffset`). Before, the
  broken `related:` in a CRLF file selected `ghost.md]` and a newline. Now it
  selects `./ghost.md`, in a unit test and in a real browser on the verifier's
  `e-crlf.md`.
- An edge is found from its own key's line: `g-sentence.md`'s reference now
  opens at line 4, not inside `summary:` on line 3.
- Leaving is opt-in, with the app's noun; Scriptorium opts in.
- When sets nest, each file is grouped under its innermost set. A link leaves
  only when its target is not under the source set's folder, as the shipped map
  counted it, in both directions: `inner/deep.md -> ../ruin.md` leaves `inner`,
  and `world -> ./inner/deep.md` stays in `world`. A document added on its own
  (a `listed` entry) has no folder of its own, so a link from it leaves unless
  that entry holds the target: a sibling, and a set below its folder, both
  leave.
- Groups say "N of M" when cut.
- `link-check`'s help describes the new fields.
- Tests now kill every mutant the verifier and I planted, the two that survived
  the re-verify included: the CRLF heading mark, and Scriptorium's declaration.
- Not done: a section inside a cut group still shows only its kept count, not
  "of M" (that would need per-set, per-section totals from the daemon). The
  footnote says that group counts are cut.

Deliberate choices:

- Shared file names stay one session-wide section above the sets, because a name
  can be shared across two sets.
- A file that no document view opens (a `.csv`), sitting in the set's own
  folder, does not leave the set. A folder link never leaves.
- A daemon that names no `sets` gets the one ungrouped list, as before.

Verified by `links.leaving.session.test.ts` (daemon) and
`LinkCheck.sets.test.tsx` (the real shell over a real daemon with an edge slot).
The second test asserts that the mark's words and total equal what the
`link-check` op answers for the same session (a dangling link, a broken
`related:`, three links leaving), that the set totals add up to the mark, and
that the broken reference and a leaving link each open at their place.

Six planted mutants were each killed:

- cross-set links never leave;
- the whole-name match is dropped;
- the mark's total drops `leaving`;
- grouping keeps every entry in every set;
- edges lose their place;
- an in-folder file leaves.

In a real browser, the flagged Scriptorium (`SCRIPTORIUM_KIT=1`, scratch home)
on two sets showed "1 broken link, 1 broken frontmatter reference, 4 leaving the
set", grouped as world 5 and lore 1. The shipped app's map headers on the same
files read "3 leaving the set · 2 dangling" (world) and "1 leaving the set"
(lore). That is the same per set: the shipped "dangling" counts the body link
and the frontmatter reference together. In raw view, choosing the broken
reference selected `./ghost.md` in the editor.

## Port-back notes

For Story Studio's agent to weigh (kit-parity is the lead's step):

- `protocol.ts`: these fields are added, all optional:
  - `set?` on `CheckedLinkView`, `CheckedEdgeView`, `CheckedReferenceView`,
    `SharedNameFile` and the unused-image entries;
  - `from?` and `to?` on `CheckedEdgeView`;
  - a new `LeavingLinkView`;
  - `LinkCheck.leaving?` and `LinkCheck.sets?`.
- `linkEdges.ts`: new `EdgeSpot` and `locateEdges(text, edges)` (pure). They
  find where an edge is written when the app gives no line, so a report can open
  it in place.
- `session.ts` `readOf`: caches `edgeAt` beside `edges` under the same stamp.
- `session.ts` `linkCheck`:
  - computes `leaving` from the resolutions it already makes; no second resolve
    for body links;
  - tags `set`, and lists `sets`;
  - `count` is unchanged.
- `shell/LinkCheck.tsx`:
  - `linkCheckTotal` adds `leaving`;
  - `linkCheckLabel` names app edges ("broken <kind> reference") and "N leaving
    the set";
  - new `linkCheckGroups`, `EdgeEntry` and `LeavingEntry`;
  - the list groups by set when the daemon names sets.

- After the verifier's round (fixups on the same branch):
  - `server.ts`: `WorkspaceDaemonOptions.linkCheck` (`LinkCheckOptions`:
    `leaving`, `noun`). "Leaving the set" is OFF unless the app asks, and `noun`
    is the app's word for a set (the shell says "folder" without it).
    Scriptorium declares `{ leaving: true, noun: "set" }`. Without the option
    there is no `leaving` section and no `noun`, and the shell names no "set".
    But NOT everything is as before for every app. Each entry carries `set`, the
    answer carries `sets` with totals, the list groups by set, and `shown` paths
    are relative to the innermost set. For Story Studio's single workspace this
    is harmless: one group, and the same paths.
  - `session.ts` `linkCheck`: a file is grouped under the innermost mirrored set
    whose folder holds it (resolving still uses the entry a click uses). A link
    leaves only when its target is not under the source set's folder;
    `sets[].total` is each set's whole before any list is cut.
  - `linkEdges.ts` `locateEdges`: the search starts at the line of the edge's
    own key (`e.key`).
  - `document/DocumentView.tsx`: new `editorOffset(text, offset)`. A reveal, a
    heading's mark and a flash map daemon offsets into CodeMirror's document,
    counting each `\r\n` once. Body links in a CRLF file landed a character late
    per line before this too, in Story Studio as here.
  - `shell/LinkCheck.tsx`: a cut group says "N of M"; the label and sections use
    the answer's `noun`.
  - `verbs.ts`: `link-check`'s help describes `leaving`, `set`, `sets` and
    `noun`.
