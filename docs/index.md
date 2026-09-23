---
type: index
title: Documentation catalog
description:
  One line per library page, so nothing durable is reachable only by knowing it
  exists.
tags: [catalog, documentation]
status: stable
generated: { by: project-docs-scaffold-template, at: 2026-09-04 }
---

# Documentation catalog

Every page in the library — the folders whose documents are meant to live and
grow — gets exactly one line here: a link and its own `description`, verbatim.
Nothing else. This is the reachability root, so a page missing from it is an
orphan and the lint says so.

Add entries under their heading, below the ones already there; the sections read
in the order the pages were written. A heading reading `_No pages yet._` is
holding the place for the first entry — replace that line, don't add beneath it.

The workbench (`backlog/`, `briefs/`, `investigations/`, `projects/`,
`reports/`, `fragments/`, `cycles/`) is deliberately **not** catalogued. Those
documents are found by their date and their folder README, they close, and
nobody returns to them. See [SCHEMA.md](./SCHEMA.md) for the two tiers.

## The tree itself

- [Project manifesto](./PROJECT_MANIFESTO.md) — The conceptual manifesto
  defining what a spell is, the co-presence principle behind it, and the
  boundaries of what spells deliberately are not
- [Project summary](./PROJECT-SUMMARY.md) — Snapshot of Spellbook's shipped
  spells, current direction and recent work, with an explicit boundary marking
  what is stale since the last partial refresh

## Architecture

How subsystems are built and why. — see
[architecture/README.md](./architecture/README.md).

- [Dependency and package boundaries](./architecture/dependency-and-package-boundaries.md)
  — Explains why Spellbook uses one root package.json with no per-spell
  manifests, and the signals that would mean that decision has stopped being
  correct
- [The house conformance register](./architecture/house-conformance-register.md)
  — Living inventory of where the spells' backends still disagree, tracked as
  open register rows across sections A through F
- [Spell backends](./architecture/spell-backend-architecture.md) — How a spell
  is built, shipped and spawned, and which parts of that every spell is required
  to share
- [scriptorium](./architecture/spells/scriptorium.md) — How scriptorium's
  document editor daemon, browser surface and CLI share one session, with the
  invariants and test cells that guard them

## Specifications

What a domain must do, precisely enough to build from. — see
[specifications/README.md](./specifications/README.md).

_No pages yet._

## Interaction design

How a surface behaves for the person using it. — see
[interaction-design/README.md](./interaction-design/README.md).

_No pages yet._

## Playbooks

Repeatable procedures for work that recurs. — see
[playbooks/README.md](./playbooks/README.md).

- [Porting a spell to the built layout](./playbooks/porting-a-spell-playbook.md)
  — Step-by-step record of porting all eight spells' surfaces and backends onto
  the shared build, kept as a playbook now that the port population is closed
  rather than a schedule
- [Scaffolding a new spell on the build](./playbooks/scaffolding-a-spell-playbook.md)
  — Step-by-step playbook for scaffolding a brand-new spell directly onto the
  shared build layout, replacing guidance that pre-dated the backend convergence

## Lessons learned

What went wrong or right, distilled so it transfers. — see
[lessons-learned/README.md](./lessons-learned/README.md).

_No pages yet._

## Memories

- [Grapevine V1.7 — human as a first-class participant](./memories/2026-06-11-grapevine-v1.7.md)
  — Grapevine V1.7 shipped human-as-participant features (identity, join/lurk,
  threading, archive) on an Alpine-ported watch surface, validated by a live
  human+agent soak that caught two bugs
- [Bounty — migrated to the house daemon + cli.ts pattern (#6–#10)](./memories/2026-06-15-bounty-house-migration.md)
  — Bounty migrated off the old file-pump substrate onto the house daemon+cli
  pattern, adding ownership, scoped tails, cooperative claim and task
  dependencies with a cycle guard
- [Astrolabe built, then surface re-homed CDN → bundled React](./memories/2026-06-30-astrolabe-build-and-react-rehome.md)
  — Astrolabe's cross-project observatory daemon was built and verified, then
  its surface was re-homed from Tailwind Play CDN to a bundled
  React+Bun+Tailwind-v4 stack after discovering the CDN silently no-ops @apply
- [Mind-mapper Phase 0 spike: research → passed spike in one day](./memories/2026-07-16-mind-mapper-spike.md)
  — Mind-mapper's Phase 0 spike ran the full pre-V1 arc (landscape analysis,
  user research, architecture resolution) and passed in a single day, clearing
  the way to V1 planning
- [Mind-mapper V1: ratified plan → passed acceptance test, same evening as the spike](./memories/2026-07-17-mind-mapper-v1.md)
  — Mind-mapper V1 was built end-to-end via anthill (plan skeleton through P1-P4
  verify gates) with real sqlite+markdown persistence and passed a cold-agent
  acceptance test the same evening as the spike
- [Mind-mapper V1.x (Track A) built and gate-passed](./memories/2026-07-17-mind-mapper-v1x.md)
  — Mind-mapper Track A shipped nine dogfood-driven findings in one anthill
  round (disconnect banner, self-healing tail, doc context menu, stigmergic
  status marks) and surfaced the lesson that subagent re-dispatches must be
  verified by thread not seat
- [Mind-mapper Round 3: exploration zones built and gate-passed](./memories/2026-07-18-mind-mapper-round3.md)
  — Mind-mapper Round 3 built exploration zones and promotion, the
  no-default-project landing flow, doc-lens, card grid view and grapevine's send
  body-chain fix, with both owners independently catching the same
  zone-event-scoping bug at ratify
- [Memory — mind-mapper Round 4 built + gate-passed (2026-07-19)](./memories/2026-07-19-mind-mapper-round4.md)
  — Mind-mapper Round 4 shipped action slots, ratify-anywhere, automated
  activity ladder and doc-kind honesty, passing gate on the first drive with
  zero wire-guess failures for the second round running
- [Memory — mind-mapper dogfood drive #4 + Round 4 merge (2026-07-19/20)](./memories/2026-07-20-mind-mapper-drive4-round4-merge.md)
  — Mind-mapper's dogfood drive #4 served as Round 4's human gate and passed,
  Round 4 merged to develop, and the drive produced 11 findings including
  media/image support, spotlight lens and the asymmetrical-parity
  intent-composer principle that shaped Round 5
- [Memory — mind-mapper Round 5 built + gate-passed (2026-07-21)](./memories/2026-07-21-mind-mapper-round5.md)
  — Mind-mapper Round 5 shipped subgraphs/node-anchored submaps as the headline
  feature plus select-connected, spotlight lens and intent-composer affordances,
  with ratify falsifying the plan's submap-scoping approach before build
- [Memory — mind-mapper dogfood drive #5 + Round 5 merge (2026-07-22)](./memories/2026-07-22-mind-mapper-drive5-round5-merge.md)
  — Mind-mapper's dogfood drive #5 proved subgraphs end-to-end live and served
  as Round 5's human gate, Round 5 merged to develop, and the drive's 10
  findings were triaged into Round 6 (fixes) and Round 7 (images)
- [Memory — mind-mapper dogfood drive #6 + Round 6 merge (2026-07-22)](./memories/2026-07-22-mind-mapper-drive6-round6-merge.md)
  — Mind-mapper's dogfood drive #6 verified delete, propose-batch at scale and
  the read verb live, served as Round 6's human gate, and surfaced the async
  job-queue idea Cole called very important for the future multi-agent runtime
- [Memory — mind-mapper Round 6 built + gate-passed (2026-07-22)](./memories/2026-07-22-mind-mapper-round6.md)
  — Mind-mapper Round 6 shipped ratify-batch, node/proposal deletion with
  cited-guard cascades, and the proposal.rejected event fix, passing gate on the
  first cold drive with zero wire-guess failures for the fourth round running
- [Memory — mind-mapper Round 7 built + gate-passed (2026-07-22)](./memories/2026-07-22-mind-mapper-round7.md)
  — Mind-mapper Round 7 shipped the controlled-folksonomy tags system, faceted
  filtering, directional select and backlinks, with gate catching a real silent
  bug where propose --stdin dropped top-level tags
- [grapevine declares its own surface (acc-standard working session)](./memories/2026-08-24-grapevine-declared-surface.md)
  — Grapevine's CLI gained a schema verb that emits its interface as acc
  declaration format v0 from a new COMMANDS registry, moving it from 3 core
  violations to CONFORMANT L0 and producing the first outside evidence for acc's
  drift-check thesis
- [magpie reached acc L0, and the census found 289 defects L0 could not see](./memories/2026-08-26-magpie-acc-l0-census.md)
  — Magpie reached acc L0 conformance, and a recorded-surface census then found
  289 accepted-not-declared flag/path pairs caused by one shared global flag
  registry, fixed by a single VERB_SPEC table
- [glamour CLI: acc L0, then per-verb sets + census, then one table drives everything](./memories/2026-09-03-glamour-acc-l0.md)
  — Glamour's CLI went from not-conformant to acc L0, then added per-verb flag
  sets and a census that found and fixed 450 disagreements down to zero, ending
  with one COMMANDS table driving dispatch, help and schema
- [Register A1 closed — every closed set the eight spells reject against is now `choices`](./memories/2026-09-10-house-error-choices-a1.md)
  — Closed Register A1 by adding the choices field to all nineteen qualifying
  error rejections across all eight spells, and ruled that choices is required
  only where a closed set is in hand at the raise while hint is required only
  where a next act exists

- [Scriptorium's chip: a forward cursor that never came back, and a flag that outlived its passage](./memories/2026-09-22-scriptorium-selection-and-the-chip.md)
  — Rendered-mode selections drifted because one whitespace run moved alignRuns'
  cursor past real text, and the chip kept a second piece of state the selection
  did not — fixed, with the ruling that clearing the chip clears the selection

- [A time window is a guess about which scroll a report came from](./memories/2026-09-22-a-time-window-is-a-guess.md)
  — Scriptorium's split-view sync suppressed reports for a time window after
  driving a pane, which discarded real scrolls; replacing the guess with an
  exact position test fixed both symptoms and left two pinned sub-frame holes

- [An observer is late for the event that beats it](./memories/2026-09-22-an-observer-is-late-for-the-event-that-beats-it.md)
  — Scriptorium cached layout measurements and cleared them from a
  ResizeObserver, but a scroll event caused by the same resize is dispatched
  first and read the stale cache; keying the cache on the width it measured made
  staleness exact

- [The rule was pinned; the wiring around it was not](./memories/2026-09-22-the-rule-was-pinned-the-wiring-was-not.md)
  — Two Scriptorium branches in a row kept their rule in a pure, well-tested
  function and left the code that feeds and carries it untested; mutation is
  what found it both times
