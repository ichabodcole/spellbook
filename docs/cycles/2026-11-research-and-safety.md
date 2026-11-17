---
type: cycle
title: Research first, and the bugs that bite
description:
  Answer what Scriptorium should take from Story Studio, where its profiles live
  and how to split the kit, and fix the bugs that can lose work or have a ready
  fix, before the next feature cycle.
tags: [scriptorium, kit, research, bugs]
status: draft
lifecycle: active
started: 2026-11-17
appetite:
  Stop when each research item has Cole's call and its follow-up items are
  filed, the eight bugs are done, and CI is green on two pushes in a row; then
  cut a patch release.
after: []
generated: { by: claude-opus-5-5, at: 2026-11-17 }
---

# Research first, and the bugs that bite

## Why now

It replaces [Bugs after 6.0.0](2026-10-bugs-after-6.md), which sat for three
weeks without starting. Meanwhile Story Studio has closed about 37 cycles of
document UX, such as the inbox and the icon tabs, and some of it may reshape our
own items: the notes items against the inbox, and session identity against Story
Studio's projects home. Cole wants that answered before the next feature work
(2026-11-17), so this cycle is mostly research. Its findings become the next
cycle's items. Alongside the research it fixes only the bugs that can lose work,
or that are small with a fix ready to port.

## Scope

Approved by Cole on 2026-11-17. In order:

**1. Research.** Each item ends in Cole's call, with its follow-up items filed.

1. **[item/story-studio-document-ux-port](../items/story-studio-document-ux-port/item.md)**
   comes first. Its findings may reshape the items below and the next cycle's.
2. **[item/scriptorium-session-vocabularies](../items/scriptorium-session-vocabularies/item.md)**:
   where profiles and relations come from for short-lived sessions, and whether
   to adopt `@studio`. It takes in what item 1 finds.
3. **[item/frontmatter-chip-editing](../items/frontmatter-chip-editing/item.md)**:
   after item 2, from which it takes its values.
4. **[item/kit-split-oversized-modules](../items/kit-split-oversized-modules.md)**,
   starting from Story Studio's refactoring cycle (closed 2026-11-08): how to
   split `session.ts` and the other large modules. Its call shapes every later
   kit change.

**2. Bugs that can lose work:**

5. **[item/kit-unpinned-verbs-write-to-another-session](../items/kit-unpinned-verbs-write-to-another-session/item.md)**
   (#137): with two live sessions, a write without `--session` is refused.
6. **[item/scriptorium-downgraded-session-refused](../items/scriptorium-downgraded-session-refused.md)**:
   6.0.0 restores a session 5.2.0 has written to, or refuses it and says how to
   recover.
7. **[item/kit-save-second-unseen-change](../items/kit-save-second-unseen-change.md)**:
   Save after the banner writes only over the change the banner was raised for.
8. **[item/kit-right-click-away-from-selection](../items/kit-right-click-away-from-selection.md)**
   (#146): a right-click outside the selection acts at the click.
9. **[item/note-reply-clears-every-waiting-note](../items/note-reply-clears-every-waiting-note.md)**:
   a reply clears only the note it names. Story Studio's fix is in kit-parity
   message 62.

**3. Small fixes with a fix ready** (one branch: `verbs.ts` and the CLI
registry):

10. **[item/kit-task-done-takes-no-body-file](../items/kit-task-done-takes-no-body-file.md)**
    (#145)
11. **[item/kit-cli-epipe-stack](../items/kit-cli-epipe-stack.md)**: Image
    Farm's `exitOnBrokenPipe`
12. **[item/kit-cli-group-flag-wrong-problem](../items/kit-cli-group-flag-wrong-problem.md)**:
    Image Farm's registry change

Items 5 and 10 both touch `src/kit/workspace/verbs.ts`: land 5 first.

**Out of scope, deliberately.** They go to the next cycle, shaped by the
research:

- the [session-identity](../features/session-identity/feature.md) feature, and
  the chat image drop, until the Story Studio scan has spoken;
- the raw editor and note guard group, sets, links and the tree;
- the grapevine and glamour daemon bugs, and the save-refusal wording;
- the map items, #147 and the lone-CR line counters.

## Outcome

_Written at close._

## Sessions

- docs/story-studio-document-ux-port (landed 2026-11-17)
- chore/bun-1.4.4 (landed 2026-11-17)
- docs/scriptorium-session-vocabularies (open)
- docs/kit-split-oversized-modules (open)
- fix/kit-unpinned-verbs-write-to-another-session (landed 2026-11-17)
- fix/kit-right-click-away-from-selection (open)
- fix/scriptorium-downgraded-session-refused (open)
