---
type: item
title: A move's relink misses versions the agent proposed
description:
  relink and link-check read only a document's active version, so a version the
  agent proposed before a move keeps the old link and nothing reports it when
  the human later activates it.
status: stable
lifecycle: ready
id: 01a15bca-2b17-722c-ace0-957826510f24
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-20 }
tags: [kit, scriptorium]
parent: feature/workspace-kit-follow-ups
from: cycle/2026-10-cutover
cycle: 2026-10-polish
---

# A move's relink misses versions the agent proposed

Found by the cold read of the cutover's SKILL rewrite (2026-10-20). After `move`
or `rename`, `relink` rewrites links in each document's active version, and
`link-check` checks only active versions. A version the agent proposed before
the move, and the human has not yet taken, keeps the old path. When the human
activates it, the link is broken and nothing said so. The SKILL now warns the
agent about it.

## Definition of done

- [x] `link-check` reports a link a move or rename broke in a proposed (not
      active) version: the document, the version, the line and the target as
      written, with the act that fixes it (Cole's ruling, 2026-10-22). Relink
      itself still rewrites only active versions.
- [ ] Tested, and offered on kit-parity.

## Done and verified

The fix is `f684e0b0`, and a second round after the verifier's read is
`ffd43d09`. Both are kit code: `src/kit/workspace` and the shell's
`LinkCheck.tsx`.

`link-check` reads each version **the agent proposed**: one written by the agent
that has never been active. Each link that answers nothing there goes in a new
`proposed` section, with:

- `doc` (the slug) and `version`;
- the line and offsets in that version's text;
- the link as written, and `tried`;
- `suggest`: where the target went;
- `act`: propose that version again with the link fixed
  (`version-new --doc <slug> --from vN --stdin`), then delete the old proposal
  (`version-delete vN --doc <slug>`). Once the agent does both, the report is
  gone.

Relink is untouched and still rewrites only the active version (ruling 2).

Choices made:

- **Which versions count as proposals.** A version counts when it has
  `by: "agent"` and no `activated`. `Version.activated` is a new optional field.
  `activate()` sets it on both the version it leaves and the one it makes
  active. So the human's own versions are never read, and neither is an agent
  version the human has had active.
  - The limit: an agent version that was active and then left before this field
    existed carries no mark, and is read as a proposal.
- **`suggest` follows what the moves did.** It does not match links between
  versions.
  - The session keeps every move and rename it makes (`followMove`, up to 500,
    in memory). That includes an undo's way back.
  - A broken link's `tried` places are followed through those moves. So are the
    same places from where the document was, when the document itself moved. The
    first that exists, rewritten from the document as relink writes it and
    checked to land, is the `suggest`.
  - With no move behind the break, or after a daemon restart, there is no
    `suggest`. It never guesses.
- **Counted in `count`.** Once the version is activated, the link is broken.
  - The sign says "N broken links in proposed versions", and its list has a
    section for them.
  - An entry there opens the document and not the link, because its offsets are
    in that version's text. Opening that version itself would need activating
    it, which is the human's act.
  - `doctor` reports them as `links.proposed`, with the fix verbs.
- **A link the active version has broken too**, as written, is reported once, in
  `dangling`.

Tested:

- `relink.proposed.server.test.ts` runs on a real daemon. It covers:
  - propose, then move with `--update-links`, then `link-check`;
  - a same-labelled link before the moved one, which gets no `suggest`;
  - the act run in full, after which nothing is reported;
  - a move of the document itself;
  - a break with no move behind it;
  - the agent's version activated, after which the human's v1 is not reported;
  - an agent version once active and then left;
  - the doctor finding.
- `links.proposed.session.test.ts` covers the human's own version, and
  `activated`.
- A shell test covers the label and the section.
- In a real browser with real mouse clicks, the sign read "1 broken link in a
  proposed version" after a move. The entry read "in v2; its target moved to
  ./wilds/glade.md", and clicking it opened `keeper.md`.

The second box is not ticked. The kit-parity offer is the lead's to send. The
port-back notes below are for it.

## Port-back notes

- **`protocol.ts` `Version.activated?: true`:** new. It is set by `activate()`
  on the version left and the version made active.
- **`session.ts`:**
  - `readOf` takes an optional `version`.
  - `followMove` records each move in `moves` (memory only, up to 500).
  - New `movedTo`, `movedFrom` and `movedTarget`.
  - `linkCheck` builds `proposed` from versions that are `by: "agent"` and not
    `activated`. It is skipped under an `edge` filter that leaves out body
    links, and it counts in `count` and in set totals.
  - `checkup` passes `proposed` to the doctor.
- **`protocol.ts`:**
  - New `ProposedLinkView`, which is `CheckedLinkView` plus `doc`, `version`,
    `tried`, `suggest?` and `act`.
  - `LinkCheck.proposed?`. The daemon always sends it; it is optional in the
    type so that literals written by hand still compile.
- **`doctor.ts`:** new finding kind `links.proposed`, with the fix verbs. It is
  left out of the startup summary, as `links.dangling` is.
- **`shell/LinkCheck.tsx`:** new label part, `onlySet` carries `proposed`, and a
  new "Broken in a proposed version" section.
- **Cost:** another pass's cache prune drops the proposals' entries, so the next
  `link-check` reads them again. Back-to-back checks stay cached.
- **Activating hides a proposal's links.** An agent that activates its own
  proposal hides that version's broken links from `proposed`. Once active, a
  version is history, the same as when the human activates it. Its links are
  then the active version's, and are checked there.
- **Round 3:**
  - (`2103cbb1`) Each act names the whole fix for its version: every `proposed`
    link of vN in ONE new version (keeping vN's `--label`), then
    `version-delete vN`.
  - Versions kept from an outside write (`preserveOutside`) are excluded. They
    carry the new `Version.outside`, and an older one is known by its label.
  - `movedTarget` never offers a folder for a link to a file.
  - New tests: chained moves, a folder move, a folder made in a moved file's
    place, the label, and the outside write.
