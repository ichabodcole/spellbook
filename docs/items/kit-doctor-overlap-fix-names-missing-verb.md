---
type: item
title: doctor's workspace.overlap fix names a verb Scriptorium lacks
description:
  The kit's workspace.overlap finding offers 'workspace <dir>' as its fix, but
  Scriptorium has no workspace verb, so the finding's act cannot be taken.
status: draft
lifecycle: triage
id: 01a15bca-2bc2-741a-b014-7e9cc72a385b
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-20 }
tags: [kit, scriptorium]
parent: feature/workspace-kit-follow-ups
from: cycle/2026-10-cutover
---

# doctor's workspace.overlap fix names a verb Scriptorium lacks

Found by the cutover's SKILL rewrite (2026-10-20). The kit's `doctor` reports
`workspace.overlap` with a fix naming `workspace <dir>`. Scriptorium declares no
home workspace and has no `workspace` verb, so the act the finding offers fails.
A finding needs an act that works.

## Definition of done

- [ ] On an app with no home workspace, `workspace.overlap` either does not fire
      or names an act the app has.
- [ ] Tested, and offered on kit-parity.
