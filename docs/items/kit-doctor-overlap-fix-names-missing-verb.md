---
type: item
title: doctor's workspace.overlap fix names a verb Scriptorium lacks
description:
  The kit's workspace.overlap finding offers 'workspace <dir>' as its fix, but
  Scriptorium has no workspace verb, so the finding's act cannot be taken.
status: stable
lifecycle: done
id: 01a15bca-2bc2-741a-b014-7e9cc72a385b
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-20 }
tags: [kit, scriptorium]
parent: feature/workspace-kit-follow-ups
from: cycle/2026-10-cutover
cycle: 2026-10-polish
---

# doctor's workspace.overlap fix names a verb Scriptorium lacks

Found by the cutover's SKILL rewrite (2026-10-20). The kit's `doctor` reports
`workspace.overlap` with a fix naming `workspace <dir>`. Scriptorium declares no
home workspace and has no `workspace` verb, so the act the finding offers fails.
A finding needs an act that works.

## Definition of done

- [x] On an app with no home workspace, `workspace.overlap` either does not fire
      or names an act the app has. _(It does not fire.)_
- [x] Tested, and offered on kit-parity. _(Tested. Not offered: the lead offers
      on kit-parity; there is no kit code change to offer, only a test.)_
      Offered on kit-parity, message 48 (2026-10-23).

## Done and verified

Commit `74165217` on `impl/kit-doctor-and-crlf-notes` (from `cycle/polish`).

**Decision: the finding does not fire, rather than naming another act.** An app
with no home workspace has no workspace folder, so nothing can overlap a set.
The finding describes a state that cannot exist there, so there is no right act
for it to name. Rewording the fix for such an app would give a finding about
nothing.

This was already true in the code, since the no-home declaration (`c079f872`).
Two guards hold it:

- a restore drops a `workspace` an older manifest still holds;
- `workspaceOverlap()` answers null when `hasHome` is false.

So `checkup()` and the startup line (`overlapToSay()`) never produce it. What
was missing was a test at the doctor's level, and a SKILL that matched.

- **Test** (`src/kit/workspace/noHome.test.ts`). A no-home session is restored
  from a manifest whose workspace is inside a set. Neither the checkup nor the
  startup line reports `workspace.overlap`, and no finding's fix names a
  `workspace` verb. The same manifest on a home app does overlap, and its fix
  names `workspace <dir>`, the verb it has.
- **Mutation checks.** Removing both guards turns the new test red. Removing
  either one alone keeps it green: the other still holds, so the two are defence
  in depth.
- **SKILL** (`plugins/spellbook/skills/scriptorium/SKILL.md`, the `doctor`
  paragraph only). It used to tell the agent to ignore the fix. It now says
  Scriptorium has no workspace folder and never reports `workspace.overlap`.

## Port-back notes

- No kit code changed. The test is the only kit change: a `describe` in
  `workspace/noHome.test.ts`. It pins that `checkup()` and `overlapToSay()` say
  nothing about an overlap when the app declares `homeWorkspace: false`. Story
  Studio keeps a home workspace, so its `workspace.overlap` and its fix are
  unchanged.
