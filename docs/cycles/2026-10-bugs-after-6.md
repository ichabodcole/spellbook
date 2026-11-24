---
type: cycle
title: Bugs after 6.0.0
description:
  Fix the bugs 6.0.0 adopters can hit, and the kit bugs found porting with Story
  Studio, with no new features; research the split of the kit's oversized
  modules meanwhile.
tags: [kit, scriptorium, grapevine, bugs]
status: draft
lifecycle: abandoned
started: 2026-10-26
appetite:
  "Bugs only: no new features (tick-tock, Cole 2026-10-26). Stop when every item
  is done or dropped and CI is green on two pushes in a row, then cut the
  release."
after: []
generated: { by: claude-opus-5-5, at: 2026-10-26 }
closed: 2026-11-17
---

# Bugs after 6.0.0

## Why now

6.0.0 shipped on 2026-10-26, and the release-6 cycle filed 29 items, most of
them bugs. Four of those bugs can lose or corrupt an adopter's work, including
the downgrade trap the upgrade note warns about. Story Studio found three more
in our kit while porting our line-ending fixes (kit-parity, message 60). Cole
ruled tick-tock: a bugs-only cycle now, with features (session identity, session
cleanup, the chat image drop) in the next one.

## Scope

Approved by Cole on 2026-10-26, from the triage of that day. In order:

**1. Bugs that can lose or corrupt an adopter's work:**

1. **[item/scriptorium-downgraded-session-refused](../items/scriptorium-downgraded-session-refused/item.md)**:
   6.0.0 restores a session 5.2.0 has written to, or refuses it with how to
   recover.
2. **[item/kit-save-second-unseen-change](../items/kit-save-second-unseen-change/item.md)**:
   Save after the banner writes only over the change the banner was raised for.
3. **[item/kit-save-refusal-four-messages](../items/kit-save-refusal-four-messages.md)**:
   one wording for that refusal across banner, toast and chat. After 2.
4. **[item/note-reply-clears-every-waiting-note](../items/note-reply-clears-every-waiting-note/item.md)**:
   a reply clears only the note it names.
5. **[item/kit-workspace-file-symlinks-leave-set](../items/kit-workspace-file-symlinks-leave-set.md)**:
   a linked file can't leak or write outside its set. Cole rules the policy
   first.

**2. The raw editor and the note guard** (in order; they share `projection.ts`,
`lineEndings.ts` and `note.add`):

6. **[item/kit-note-guard-fallback-footnote-digit](../items/kit-note-guard-fallback-footnote-digit.md)**
7. **[item/kit-raw-selection-offset-lags-editor](../items/kit-raw-selection-offset-lags-editor.md)**
8. **[item/kit-undo-mixed-endings-loses-mark](../items/kit-undo-mixed-endings-loses-mark.md)**
9. **[item/kit-not-placed-refusal-raw-wording](../items/kit-not-placed-refusal-raw-wording.md)**

**3. Sets, links and the tree:**

10. **[item/kit-folder-and-link-one-set](../items/kit-folder-and-link-one-set.md)**
11. **[item/kit-scan-cap-says-so](../items/kit-scan-cap-says-so.md)**
12. **[item/kit-unreadable-document-reported](../items/kit-unreadable-document-reported.md)**
13. **[item/kit-tree-keyboard-tests](../items/kit-tree-keyboard-tests.md)**
14. **[item/scriptorium-held-toast-goes-stale](../items/scriptorium-held-toast-goes-stale.md)**

**4. The grapevine daemon** (one branch; all in `src/grapevine/backend/cli.ts`):

15. **[item/grapevine-hold-has-no-way-out](../items/grapevine-hold-has-no-way-out.md)**
16. **[item/grapevine-stuck-daemon-refusal-gaps](../items/grapevine-stuck-daemon-refusal-gaps.md)**
17. **[item/grapevine-paused-daemon-reads-as-gone](../items/grapevine-paused-daemon-reads-as-gone.md)**
18. **[item/grapevine-small-hint-miscounts](../items/grapevine-small-hint-miscounts.md)**
19. **[item/grapevine-status-frame-leaks](../items/grapevine-status-frame-leaks.md)**:
    holds the `--last n` miscount trimmed from 18.

**5. Glamour, with its partner:**

20. **[item/glamour-daemon-holds-cli-stderr](../items/glamour-daemon-holds-cli-stderr.md)**
    with
    **[item/glamour-open-reports-a-dead-daemon](../items/glamour-open-reports-a-dead-daemon.md)**

**6. Test health:**

21. **[item/kit-profiles-watch-test-timeout](../items/kit-profiles-watch-test-timeout.md)**

**7. Research for the next cycle** (touches no code):

22. **[item/kit-split-oversized-modules](../items/kit-split-oversized-modules/item.md)**:
    a proposed split of `session.ts` (9,040 lines) and `server.ts` (5,357),
    agreed with Story Studio. The build opens the next cycle, before session
    identity and cleanup, which live in `session.ts`.

Groups 4 and 5 touch no kit file, so they can run beside the rest. Groups 1 and
3 both edit `src/kit/workspace/session.ts`; keep those branches short.

Out of scope, deliberately: new features, including the next cycle's session
identity, session cleanup and chat image drop. The module split's build, which
would collide with groups 1 and 3. Three bounty data-safety bugs
(`bounty-failed-restore-and-empty-replace-succeed`,
`bounty-snapshot-small-gaps`, `bounty-respawn-does-not-name-unsaved-dumps`),
which Cole left for later, and the two bounty bugs triage had put in group 5
(`bounty-latest-pointer-and-list-title`, `bounty-list-shows-stale-title`). The
reply-shape leftovers, wire work rather than bugs, whose planned cycle was
abandoned the same day.

## Decision log

| #   | Date       | Decision                                                                                                                                                           | Options not taken                                    |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| 1   | 2026-10-26 | Cole: tick-tock. This cycle is bugs only; features come next.                                                                                                      | Mix the Scriptorium follow-ups in as a second track. |
| 2   | 2026-10-26 | Cole: research the module split now, build it at the start of the next cycle.                                                                                      | Refactor during this cycle; leave it.                |
| 3   | 2026-10-26 | Cole: leave the three bounty data-safety bugs out.                                                                                                                 | Include them.                                        |
| 4   | 2026-10-26 | Cole: his triage approval reviews the ready items' definitions of done (`status: stable`).                                                                         | Review each item when it starts.                     |
| 5   | 2026-10-26 | Cole: a file symlink leaving its set is treated like a folder link (a link row; no search, meta or graph through it; Save refused). Can loosen to read-only later. | Hide it; show it read-only.                          |
| 6   | 2026-10-26 | Cole: take the two bounty bugs out too; no bounty work this cycle.                                                                                                 | Keep them in group 5.                                |

## Outcome

Abandoned on 2026-11-17 without starting. Nothing in it shipped: none of its 23
items was begun in the three weeks after it opened. Cole rescoped it into
[Research first, and the bugs that bite](2026-11-research-and-safety.md). That
cycle runs the research that could reshape other items first, mainly what to
take from Story Studio, and keeps only the bugs that can lose work or have a fix
ready to port.

Four items moved to the new cycle:

- `scriptorium-downgraded-session-refused`
- `kit-save-second-unseen-change`
- `note-reply-clears-every-waiting-note`
- `kit-split-oversized-modules`

The other 19 went back to the ready pool with no cycle:

- the raw editor and note guard;
- sets, links and the tree;
- the grapevine and glamour daemons;
- the save-refusal wording;
- the symlink policy item.

The lesson: a bug cycle planned before the research that could reshape it waits
on that research. Run the research first.

## Sessions

<!--
One line per branch, appended by `init-branch` as it opens them:

  - feature/some-branch (open)

`finalize-branch` rewrites `(open)` as `(landed YYYY-MM-DD)` when the branch
lands. Leave this section empty until the first branch; do not carry a
placeholder line into a real cycle.
-->
