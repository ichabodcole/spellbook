# Fragment: A Project Roadmap / Planning Surface

**Date**: 2026-08-05 **Context**: Captured by Cole in Operator
(`fragments/project-roadmap-surface.md`, Spellbook project) and mirrored here.
Captured minutes after
[`2026-08-05-wiki-reading-spell.md`](./2026-08-05-wiki-reading-spell.md), which
Cole names as the tie-in.

> **Operator is the canonical precursor** (doc
> `12db4a88-95f8-44eb-9ae8-6d5924d36ee0`, v2). Keep in lockstep if it's edited
> there. **Unnamed on purpose:** working handle only; name and kind reserve at
> coalescence per `grimoire/trigger-registry.md`.

## Observation

Cole's projects accumulate **a lot of backlog items**, and he's trying to
develop project roadmaps and higher-level task lists.

**bounty** is work-oriented: here's a development task, here's the assignee,
they go do it. What's wanted here is a surface that sits **higher up** — one
that lets him see the things related to a project and ask:

- What's the current roadmap?
- What are the next several sprints focused on?
- What goes in those sprints?
- What's the overarching goal?

So: project management, **a light version of something like Atlassian**.

**What the surface might do:**

- Read in a **catalog of backlog items, which are just markdown documents**.
- Maybe structured frontmatter, so an item can declare itself: _this is a
  backlog item_.
- Give items a visual treatment — a file tree in the app, a tab ("here are the
  backlog items"), however it's best visualized — so they navigate easily.

**Start light.** Nothing more than a light version to begin.

## Philosophy carried over (Cole's, verbatim in substance)

- **Collaborative** — human–agent, real-time, co-present.
- **Not database-backed** — the app's data isn't tied to a database the app
  owns. Read in the context, then work with that context.
- **Data lives in the project** — structured markdown content. Open the spell,
  read it in. Maybe sync between the two, but no account, no login.
- **Lifecycle** — start up, do the work, close it.

## Configuration (kept light)

Configuration that can be maintained, so reloading a body of work is easy.

The problem: a repo might keep its backlog list in one folder and its roadmap
somewhere else, and those entities **aren't structured the same way between
repos**.

- Don't impose one universal structure — possible, but probably not what you
  want.
- Better: configured. _"Here's the location of this, here's the location of
  that."_
- Store that configuration so it loads again later. As long as paths are
  accurate — **lint the paths**, or otherwise verify them — the data loads
  instead of being remapped every time by a human or agent saying "here's where
  this is."

Room for configuration, but keep it very light. Figure out where structure is
actually needed, where it isn't, and where it can be per-project configurable.

## Why It Might Matter — and the boundary that needs drawing

**This repo is itself the use case.** `docs/backlog/` currently holds ~25 loose
markdown items with no roadmap above them; the triage done on 2026-08-05 (seven
GitHub issues → five backlog docs) was exactly the "what's the shape of this
pile?" problem this surface would answer. Dogfooding is available immediately.

**But three surfaces now sit near each other, and the axes need naming before a
build.** My read of the distinction — worth Cole's ratification, since getting
it wrong means building a second astrolabe:

| Surface             | Scope           | Horizon              | Data                         |
| ------------------- | --------------- | -------------------- | ---------------------------- |
| `bounty`            | one team        | this session         | live daemon state            |
| `astrolabe`         | across projects | right now            | live agent/session presence  |
| **roadmap surface** | **one project** | **sprints / months** | **static markdown, on disk** |

The claim: astrolabe answers _"what is happening right now across everything?"_
while this answers _"where is this one project going?"_ Different axis
(planning-horizon vs. liveness), so probably **not** a duplicate — but that
should be confirmed against
`docs/projects/cross-project-observatory/proposal.md` before either grows into
the other's territory.

## The overlap with the wiki spell (the real open question)

Cole opened this fragment by naming the wiki-reading spell as the tie-in, and
the shared substrate is nearly total: read structured markdown from disk,
file-tree navigation, frontmatter, no database, ephemeral lifecycle, co-present
agent chat, per-project path configuration.

**They differ mainly in what the frontmatter means and what the main view
renders** — a wiki renders a document; a roadmap renders a plan.

So: **one spell with two lenses, or two spells sharing a substrate?** This is
the decision to make deliberately at coalescence, and it's much cheaper now than
after both are half-built. A third data point already exists in mind-mapper,
which also ingests markdown/context files.

## Trigger for Revisit

- **When the mind-mapper round-loop reaches a natural pause** — it owns the
  team's attention right now.
- **When the backlog pile next becomes painful to reason about** — the itch that
  produced this fragment will produce it again, and that's the signal it's real
  rather than a passing idea.
- **Before a build starts on either this or the wiki spell** — resolve the
  one-spell-or-two question first.

## Open questions to carry into an investigation

- What's the frontmatter contract for "this is a backlog item"? Does it apply
  retroactively to the ~25 items already in `docs/backlog/` (which have a loose
  `**Added:**` convention, not frontmatter)?
- Does it read the **existing** `docs/` scaffold (backlog / projects /
  investigations / fragments) as-is, or require a new structure? Reading what's
  already there is the far stronger version.
- Where does roadmap/sprint state get **written** — a markdown file in the repo,
  or the config? (The write-back question from the wiki fragment recurs here.)
- Relationship to bounty: does a roadmap item **become** a bounty card when work
  starts, and should that hand-off be mechanical?

## Related Documentation

- Operator precursor: `fragments/project-roadmap-surface.md` (Spellbook project)
- Companion fragment:
  [`2026-08-05-wiki-reading-spell.md`](./2026-08-05-wiki-reading-spell.md)
- Boundary to check: `docs/projects/cross-project-observatory/proposal.md`
  (astrolabe)
- The immediate use case: `docs/backlog/` and its `README.md`
