# Playbooks

A playbook is the guide for one kind of work: what doing it right produces, the
steps, and the checks that prove each step was done. It is read by an agent at
the moment that kind of work starts, so it is written as instructions, not as a
story.

## When to write one

- **Write one** when the same kind of work has come up more than once and the
  second time needed something the first time taught — a step that was missed,
  an order that mattered, a check that caught a mistake.
- **Append to one** instead when a playbook for that kind of work already
  exists. This is the usual case: a branch that taught something adds a step and
  its verification to the playbook it belongs to. See
  [Adding a check to a playbook](#adding-a-check-to-a-playbook).
- **Do not write one** for a single task (that is an item's plan), for what
  happened on a branch (that is a session), or for how a system works (that is
  an architecture page).

Before creating a new playbook, look for an existing one:

```bash
bun scripts/pdocs/cli.ts find --type playbook
```

## The shape

Three sections, in this order — see [TEMPLATE.md](./TEMPLATE.md):

- **Goal** — what doing this kind of work correctly produces, and when this
  playbook applies. One or two sentences.
- **Steps** — numbered imperatives. A step that applies only in some cases names
  the case first: _"If the entity is synced, add it to the sync rules."_
- **Verification** — checks that fail when a step was skipped or done wrong: a
  command and what it should print, or something a reviewer can see. Every step
  that can go wrong has a check here.

Write every line as an instruction
([STYLE.md](../STYLE.md#guidance-is-imperative)). "We hit X when Y" is a record
and belongs in a session; the playbook line is "Before Y, check X".

## The index is the description

Playbooks are indexed by kind of work, and the index is each playbook's
frontmatter `description`. It is the line an agent reads when deciding whether a
playbook applies, and the line in [index.md](../index.md), verbatim. Write it as
the kind of work plus what the playbook gets done:

```yaml
description:
  Adding a database entity end to end — schema, migration, sync rules and API.
```

A description that names a system ("The database") or a feeling ("Database
tips") matches nothing an agent is about to do.

## Adding a check to a playbook

When work shows a playbook was missing something:

1. Add the step to **Steps**, where it happens in the work — not at the end.
2. Add the check that would have caught it to **Verification**.
3. If the new step changes what the playbook covers, update `description` and
   its line in [index.md](../index.md) to match.

Do not add a changelog or the story of the branch that taught it. The commit
records when it changed; the session records why.

## Overriding a lifecycle skill

A few project-docs skills own a lifecycle event and carry a working default for
it. A playbook at one of these paths takes precedence over that default. A skill
that honours an override reads the file when it exists, follows it instead of
its own steps, and says that it did.

| Event                             | Playbook                                           |
| --------------------------------- | -------------------------------------------------- |
| Opening a branch                  | `docs/playbooks/branch-initialization-playbook.md` |
| Finishing and landing a branch    | `docs/playbooks/branch-finalization-playbook.md`   |
| Starting implementation (kickoff) | `docs/playbooks/dev-kickoff-playbook.md`           |
| Cutting a release                 | `docs/playbooks/release-playbook.md`               |
| Handing built work over to deploy | `docs/playbooks/handoff-playbook.md`               |

Write one when your project does the event differently — a different merge
strategy, a release checklist the default does not know. It is an ordinary
playbook: same shape, same frontmatter, same catalog line.

## File naming

`<kind-of-work>-playbook.md`, for example `db-entity-playbook.md` or
`api-integration-playbook.md`. The `-playbook` suffix is part of every name in
this folder. `pdocs new playbook <slug>` adds it, and writes the catalog line.

## Status

`status: stable` means the steps are current and can be followed as written. A
playbook for a system that no longer exists is `status: deprecated`, kept so
links to it still resolve.
