# project-docs needs a story for sprints, releases, and maintenance-mode work

**Filed:** 2026-08-10 · **Routes to:** `project-docs` (the shared plugin), not
this repo · **Raised by:** Cole, during the spellbook v2.2.0 landing

## The trigger

Landing v2.2.0 produced an 11,280-character release note through two fresh-agent
passes and a cold read. The merge commit on `main` kept **81 bytes** of it —
GitHub writes the PR title as the merge body unless `--body-file` is passed. The
`land` skill has been fixed for the mechanical half (one file, two
destinations).

The **durable** half was deliberately not fixed here: landing the release note
as a file in the tree, e.g.
`docs/projects/<project>/sprints/NN/release-note.md`.

## Why it was deferred rather than done

**Cole's ruling, 2026-08-10:** the idea is right, but there is no real process
built around it, and inventing one in this repo makes it ad hoc. It should
**filter down from project-docs so every project gets it**, rather than one repo
growing a private convention that no other team shares.

## The wider gap he named

This is not only about release notes. The signals accumulating:

- **Sprints have become a real unit of work** in this project, and project-docs
  has no structure or guidance for them — no sprint scaffold, no outcome
  document, no place a sprint's result is supposed to land. Sprints 03 and 04
  both shipped with **no `outcome.md`**, and in both cases the durable account
  ended up only in a merge commit body, which is not reachable from `docs/`.
- **Releases are now a recurring act**, not a one-off. There is no documented
  shape for "what shipped in this release, in a consumer's terms" that lives in
  the tree. `CHANGELOG.md` is generated from conventional-commit subjects and
  materially under-describes what a release contained.
- **The project has moved into maintenance**: regular releases, inbound issues,
  fixes against shipped versions. project-docs is oriented around investigation
  → proposal → plan → implementation, and has less to say about the steady state
  that follows.

> **⚠ SHARPENED LATER THE SAME DAY — read
> [`2026-08-10-the-unclosed-unit.md`](./2026-08-10-the-unclosed-unit.md)
> first.** Point 2 below ("sprints have no terminal artifact") is **wrong as
> written**: this repo authored a sprint convention AND a
> `SPRINT-OUTCOME.template.md`, and two sprints skipped it anyway with the
> absence recorded both times. The gap is not a missing artifact type; it is
> that nothing can require one, and recording the omission feels like
> discharging it. That file carries the five-instance evidence across two repos.

## What a fix would need to cover

1. Where a release note lives, who writes it, and when.
2. Whether a sprint is a first-class project-docs concept, and if so its
   scaffold and its terminal artifact.
3. How a maintenance-mode project documents ongoing work that is neither a new
   proposal nor a plan step.

## Evidence in this repo, for whoever picks this up

- `a777652` — the merge commit whose body is its own subject repeated.
- `c2c00a5` / `88a298f` — the two named merges that DO carry a full account, and
  are the only durable record of sprints 04 and 03 respectively.
- `docs/projects/spell-hardening/README.md` — carries two "this sprint has no
  outcome.md, and that is a gap rather than a choice" notes.
- `.claude/skills/land/SKILL.md` §5 — the mechanical fix, and the note
  explaining why the file-based half is not specified there.
