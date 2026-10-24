---
type: item
title:
  The broken-links sign counts project-docs references and listed documents as
  broken
description:
  "In a review session of listed project docs, the sign reads '30 broken
  frontmatter references, 26 leaving the set': typed references like
  feature/<slug> and cycle/<file> are resolved as relative paths, and every link
  from one listed document to another counts as leaving."
status: stable
lifecycle: done
id: 01a1662a-a793-762c-aa2e-5a5ac8f9a347
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-22 }
tags: [kit, scriptorium, links]
parent: feature/workspace-kit-follow-ups
from: cycle/2026-10-polish
cycle: 2026-10-polish
---

# The broken-links sign counts project-docs references and listed documents as broken

Cole noticed this on 2026-10-22, in the polish cycle's review session: a cycle
doc plus 15 items, each added on its own. The status bar read "30 broken
frontmatter references, 26 leaving the set". Almost none of them is broken.

- **The 30 "broken" are project-docs references.**
  `parent: feature/workspace-kit-follow-ups` and `from: cycle/2026-10-shell` are
  typed references that `pdocs` resolves (`feature/<slug>` →
  `docs/features/<slug>/feature.md`, `item/<slug>`, `cycle/<file>`). Scriptorium
  tries them as paths relative to the document
  (`tried: docs/items/feature/workspace-kit-follow-ups.md`), finds nothing, and
  calls them broken.
- **The 26 "leaving" are links between the listed documents** (or to siblings on
  disk). Each document added alone is its own set, so every cross-link leaves a
  set. For hand-picked review sessions that is nearly every link.

## Definition of done

The ruling (Cole, 2026-10-22): Scriptorium learns nothing about project-docs.
`.project-docs.json` is another tool's file, and reading it would mean adding a
reader for every convention that follows.

- [x] A frontmatter value counts as broken only if it looks like a path (it has
      an extension, or starts `./`, `../` or `/`) and misses. Any other value
      that doesn't resolve, such as `feature/workspace-kit-follow-ups`, is an
      **unresolved reference**: it is listed as such in `link-check` and the
      sign's list, and is not counted in the sign.
- [x] Links between the session's own documents don't count as "leaving", even
      when each was added as its own set.
- [x] In a session like the review above, the sign shows only links that are
      really broken.
- [x] A real broken link (a typo'd path, a deleted file) still shows, and its
      list still opens it at its line.

**Not taken, and why:**

- **Reading `.project-docs.json`:** it couples Scriptorium to one tool.
- **Searching by name:** a wrong guess is worse than no answer.
- **A Scriptorium-owned rules file:** only if the agent-taught rules in
  [scriptorium-link-rules](scriptorium-link-rules.md) get repetitive.

## Done and verified

The fix is `373dfd22`. It is all kit code: `src/kit/workspace` (`linkEdges.ts`,
`session.ts`, `protocol.ts`, `verbs.ts`) and the shell's `LinkCheck.tsx`.
Scriptorium's own code is unchanged; it already reads its frontmatter references
as edges.

- **Unresolved references.** `pathShaped(target)` says whether an edge's target
  is written as a path: it has an extension, or starts `/`, `./` or `../`. A
  path-shaped edge that misses is still in `edges` and counted. Any other edge
  that misses goes in a new `unresolved` section (same fields as `edges`). It is
  not in `count`, and the sign does not count it. The sign's list shows it under
  "Unresolved references", without the "nothing at" line, because that reference
  was never meant as a path. Body links are unchanged: a body link that answers
  nothing is still `dangling`.
- **Leaving.** A link or edge to any of the session's own documents never
  leaves, in whichever set either one is. `leaving` now lists only links to
  files the session does not hold. `targetSet` names only a set whose folder
  holds the target. **Deliberate:** this applies to sets added as folders too.
  Before, a link from one set's folder to another set's document counted as
  leaving. The ruling says "the session's own documents", so it is no longer
  counted.
- **Reproduced first,** on scratch homes. The cycle doc and its 17 items were
  added one by one, with the whole `docs/` tree on disk and one typo'd link
  planted. The sign went from **64** ("1 broken link, 34 broken frontmatter
  references, 29 leaving the set") to **15** ("1 broken link, 3 broken
  frontmatter references, 11 leaving the set"). A real browser was driven with
  real mouse clicks: clicking the typo'd link in the list opened its document
  with the link revealed.

The third box is not ticked. Two things in that session are still on the sign:

- The 3 broken frontmatter references are path-shaped and written from the
  `docs/` root (`features/workspace-kit/sessions/….md`). Under the ruling they
  are broken.
- The 11 "leaving the set" are links to files on disk that the session does not
  hold. They are not counted as broken, but they are on the sign.

Whether the sign should show "leaving" at all is a question for Cole.

## Follow-up (2026-10-23, Cole's rulings 4–5)

The change is `c2ce61c1`, all in kit code.

**Ruling 4: "leaving the set" is listed, not counted.** The sign's number and
its words now count only what is broken. Links to files the session does not
hold stay in the list under "Leaving the set", with a fainter header, and leave
the number. The daemon's set `total`s leave them out too, so the group headers
still add up to the sign, and a group with nothing counted shows no number.
`count` already left them out. The agent's `link-check` still reports `leaving`
in full, apart from the count, and the help and SKILL say to offer to add the
files it lands on.

- **Before and after, in a real browser,** on a copy of the review session (the
  cycle doc and its 18 items, each added alone, one typo planted). Before, the
  sign read "1 broken link, 3 broken frontmatter references, 11 leaving the set"
  (15). After, it reads "1 broken link, 3 broken frontmatter references" (4).
  Those 4 are broken under Ruling 3, so the third box is ticked.
- **Only leaving links, nothing broken: a quiet mark.** The sign shows a plain
  link icon and a small word in the same faint ink: "11 leaving", or "2
  unresolved" when only unresolved references are listed, or "11 leaving, 2
  unresolved" when both are (Cole, 2026-10-23). At narrow widths it shows the
  icon and the number, as the sign already does. Its label says "nothing broken;
  listed: links leaving the set", and a click opens the list. Leaving links stay
  reachable, and the sign does not look like a problem. A session with only
  unresolved references gets the same mark; before this, they had no way in. A
  clean session still shows nothing. Not taken: hiding the sign, which would
  leave the leaving links nowhere in the UI.
- **Counted first (Cole, 2026-10-23).** When the list opens, every set with
  something counted comes first, with only its counted sections. Then, under
  each set's name again and with no number, come the "Unresolved references" and
  "Leaving the set" sections. Hoisting was chosen over sorting groups, because a
  sorted group still carries its own quiet sections. In the review session the
  cycle doc's group alone lists a leaving link and several unresolved
  references, which would push the next counted entry down. On the
  review-session copy in a real browser, all 4 counted entries are on the first
  screen. A list from a daemon that names no sets puts its counted sections
  first in the same way.
- **Tests:** `LinkCheck.sets.test.tsx` covers the quiet mark: its plain icon,
  its faint weight, its word (and narrow number), its label for leaving and for
  unresolved references, and the quiet section headers. It also covers counted
  first, grouped and ungrouped. Each of these was planted and went red.

**Ruling 5: a link between two folder sets opens the other document.** Checked
in a real browser, with sets A and B and `A/alpha.md` linking `../B/beta.md`. A
real mouse click in the rendered view opened `B/beta.md`, and Cmd-click on
`../A/alpha.md` in the raw editor opened `A/alpha.md`. No fix was needed. A new
test in `DocumentPane.links.test.tsx` clicks a link from one folder set into
another and back.

## Port-back notes

- **`linkEdges.ts`:** new export `pathShaped(target)`. Its extension must start
  with a letter and run to ten characters at most, so `feature/kit-v1.2` is not
  a path (`ffd43d09`).
- **`session.ts` `linkCheck`:**
  - An app edge that misses goes to `edges` if `pathShaped`, else to the new
    `unresolved`.
  - `leaves()` returns null for any `in-context` target.
  - `leavingView`'s `targetSet` is only a mirrored set whose folder holds the
    target.
  - Set totals count what the sign counts: `unresolved` is left out, and a set
    with only unresolved references is still named (`ffd43d09`).
- **`protocol.ts`:**
  - `LinkCheck.unresolved?: { count, kinds, links: CheckedEdgeView[] }`, present
    when `edges` is.
  - `LeavingLinkView` docs are updated.
- **`shell/LinkCheck.tsx`:**
  - New `linkCheckListed(d)`, which is the sign's total plus `unresolved`. It
    decides whether the list and a group show at all. The group headers count as
    the sign does (`linkCheckTotal`), so they add up to it (`ffd43d09`).
  - New "Unresolved references" section. `EdgeEntry` takes `unresolved`.
  - The "Leaving" note now reads "land on a file this session does not hold".
- **Leaving tests rewritten:** `links.leaving.session.test.ts` and
  `LinkCheck.sets.test.tsx`.
- **Follow-up (rulings 4–5):**
  - `shell/LinkCheck.tsx`:
    - `linkCheckTotal` no longer adds `leaving`, and `linkCheckListed` now does.
    - `linkCheckLabel` no longer names leaving links.
    - New `linkCheckQuietLabel` and `linkCheckQuietWord`.
    - The mark shows whenever something is listed. With nothing counted, it is
      quiet: `data-quiet`, `Link2Icon`, and a small faint word in place of the
      label (narrow: the listed number).
    - `KindSections` takes `part` (`counted` or `quiet`). `LinkCheckList`
      renders every set's counted part first, then every set's quiet part.
    - `Section` takes `quiet`, used for "Leaving" and "Unresolved".
    - A group header with nothing counted shows no number.
  - `session.ts` `linkCheck`: set `totals` leave out `leavingLinks`. A set with
    only leaving links is still named, at 0.
  - `protocol.ts` and the `link-check` help: docs only.
