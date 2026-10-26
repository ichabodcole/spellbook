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
- [x] A short upgrade note for adopters: what was removed, what replaces it, and
      that existing sessions restore.
- [x] The removed verbs and flag re-checked against the final build's `schema`,
      so the note lists exactly what changed.

## Done and verified

On `impl/breaking-marker`, one commit, `docs(release)!: the 6.0.0 upgrade note`,
adds the upgrade note,
[docs/releases/6.0.0-breaking-changes.md](../releases/6.0.0-breaking-changes.md),
beside the 3.0.0 to 5.0.0 ones, and carries the `BREAKING CHANGE:` footer that
points to it. The first box stays open until that commit is on develop.

**What changed, from the artifacts.** Every spell's `schema` was dumped from the
5.2.0 build (a `git archive` of the tag, installed and built in its own scratch
home) and from this build, and compared verb by verb. Only Scriptorium lost
anything: the verbs `dangling` and `workspace`, `graph --entry`, and
`backlinks`'s positional path (now `--doc`), which this item had missed. Every
other spell only gained `help [verb...]`. The schema carries no exit codes; the
help text's exit-code line is the same in both. Driving both builds the same way
(CLI and the page's socket, a tail on each) showed the output changes the note
lists: field renames and ISO times in `state` and `tail`, events moved off
`system`, and refusals that are new on kept verbs (`note-edit` on a human note,
`task-remove` on a running task, piped text without `--stdin`). A no-stake
verifier's cold read and its own runs found most of these after the first draft
of the note; each was re-run here before it went in. mind-mapper's code (no
`SKILL.md`, so never an installed spell) moved to `plugins/unreleased/`. imago,
glamour and magpie already used media-forge in 5.2.0, so that is not new.

**Restore, run.** A session made by the 5.2.0 build (a version with a label, a
quoted note, a task, a chat line) and closed was restored by this build with
`open --restore`: exit 0, with the versions, label, note, task and chat all
present, the old manifest kept as `manifest.pre-migrate.json`, and the
conversion announced in the chat. The reverse is a trap, and the note says so:
after 5.2.0 opens a converted session and writes to it, this build refuses it
(exit 6); putting `manifest.pre-migrate.json` back restores it as it was before
the first conversion, losing what came after. The converter gap is for a
separate item.

**release-please.** The workflow runs `googleapis/release-please-action@v4`,
which resolves to v4.4.1, whose lockfile pins release-please 17.3.0. Its
`DefaultVersioningStrategy` bumps the major for any commit whose notes hold a
`BREAKING CHANGE`, whatever its type, and the package is the root path `.` with
no `exclude-paths`, so there is no path filter. Candidate messages fed through
17.3.0's own parser, versioning and changelog writer from 5.2.0 gave 6.0.0 for
`chore`, `chore!`, `fix!` and `docs!` with the footer; a chore alone gives an
empty changelog and so no release PR, so land skill §6 still holds.
`docs(release)!` was chosen because the commit is documentation: it lists under
Documentation, not as a bug fix the way `fix(release)!` did for 5.0.0.
