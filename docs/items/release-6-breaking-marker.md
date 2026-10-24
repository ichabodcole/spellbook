---
type: item
title: Mark 6.0.0 as a breaking release, with an upgrade note
description:
  Cole chose 6.0.0; release-please cuts a major only from a commit marked
  breaking, so one commit's BREAKING CHANGE footer names what Scriptorium
  dropped since 5.2.0, with a short upgrade note for adopters.
status: stable
lifecycle: ready
id: 01a17017-088e-75a6-bc1d-8231219812c0
kind: chore
generated: { by: claude-opus-5-5, at: 2026-10-24 }
cycle: 2026-10-release-6
priority: high
from: cycle/2026-10-release-6
---

# Mark 6.0.0 as a breaking release, with an upgrade note

Cole, 2026-10-24: "I think we go 6.0.0, since this will be a big release."
release-please builds the version from conventional commits, and no commit since
`spellbook-v5.2.0` is marked breaking, so it would cut 5.3.0. Compared with
5.2.0, Scriptorium's CLI dropped the verbs `dangling` and `workspace` and the
flag `--entry`, and its storage model changed (no workspace). Upgrading works: a
session made by the 5.2.0 build is restored by the develop build.

This comes last in the cycle, so the note describes the final state.

## Definition of done

- [ ] One commit on develop carries a `BREAKING CHANGE:` footer that names what
      changed for adopters, so release-please proposes 6.0.0. Checked against
      release-please's own rules before Cole merges.
- [ ] A short upgrade note for adopters: what was removed, what replaces it, and
      that existing sessions restore.
- [ ] The removed verbs and flag re-checked against the final build's `schema`,
      so the note lists exactly what changed.
