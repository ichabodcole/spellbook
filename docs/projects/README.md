# Projects

This directory contains **project folders** — co-located collections of
documents for a defined body of work. Each project folder groups its proposal,
plan, sessions, and artifacts together so the full story of a piece of work
lives in one place.

## Purpose

Projects solve the traceability problem. Instead of scattering a feature's
proposal in `proposals/`, its plan in `plans/`, and its sessions in `sessions/`,
everything lives together. Opening a project folder gives you the complete
history of why and how something was built.

### Why Use Project Folders?

- **Full story in one place** - Proposal, plan, sessions, and artifacts are
  co-located and readable in sequence
- **Stable internal links** - Documents within a project reference each other
  with relative paths that never break
- **Clean archival** - When a project is done, the entire folder moves to
  `projects/_archive/`. No scattered files to chase
- **Extensible** - Add whatever documents the work needs (task lists, technical
  notes, decision logs) without new conventions
- **Natural home for artifacts** - Working research and codebase exploration
  live alongside the work they support

## When to Create a Project

Create a project folder when:

- **An investigation concludes with "build this"** - The investigation
  identified work worth doing, and you're ready to define what that work looks
  like
- **A feature or significant change needs a proposal** - The work requires
  design decisions, option exploration, or scope definition
- **The work will span multiple sessions** - It's complex enough to need a plan
  and will generate session logs

**Multiple sessions is not the same as multiple sprints.** A project starts with
one `plan.md` and stays that way as long as one plan can hold the work. When the
work outgrows a single plan, promote it — see
[Multi-Sprint Projects](#multi-sprint-projects).

**Project vs. backlog:** If the work can be described and completed without a
proposal — it's a known fix, a small refactor, a clear task — it's a backlog
item, not a project. If the work needs exploration of options, has design
decisions, or will span multiple sessions, it's a project.

## When NOT to Create a Project

- **Small, well-defined tasks** - Use `backlog/` for bugs, minor refactors,
  papercuts
- **Still investigating** - Use `investigations/` first. The project gets
  created when you know what to build
- **Documenting existing systems** - Use `architecture/` or
  `interaction-design/` for as-built documentation
- **Repeatable patterns** - Use `playbooks/` for recurring tasks

## Project Folder Structure

A project folder is flexible. Not everything needs every file:

```
projects/
  my-feature/
    proposal.md              — What we're building and why
    design-resolution.md     — System-level decisions resolved (optional)
    plan.md                  — How we're building it (when implementation begins)
    test-plan.md             — Tiered verification scenarios (optional)
    sessions/                — Development session journals
      2026-01-15-initial-implementation.md
      2026-01-20-edge-case-fixes.md
    artifacts/               — Working research generated during the project
      codebase-exploration.md
      dependency-analysis.md
    handoff.md               — Deployment steps (only when needed)
```

A small project might just have a `proposal.md`. A complex project might have
all of the above plus additional documents. The folder accommodates whatever the
work requires.

**This flat shape is the default and stays correct until the work outgrows one
plan.** When it does, the project promotes to the sprint structure — see
[Multi-Sprint Projects](#multi-sprint-projects). Don't reach for sprints up
front; reach for them when you discover you need a second plan.

### What Goes Where

- **proposal.md** — The _why_ and _what_. Problem statement, proposed solution,
  scope, technical approach. Created when the project starts. See
  `TEMPLATES/PROPOSAL.template.md`.
- **design-resolution.md** — System-level clarity. Resolves behavioral
  ambiguity, data model questions, boundaries, and architectural positioning
  before planning begins. Optional — use when the proposal has unresolved
  system-level questions that would make the plan speculative. See
  `TEMPLATES/DESIGN-RESOLUTION.template.md`.
- **plan.md** — The _how_. Phased implementation roadmap with validation
  criteria. Created when implementation begins. Scoped to **one sprint's worth
  of work** — in a multi-sprint project it lives at `sprints/NN-name/plan.md`
  instead of the project root. See `TEMPLATES/PLAN.template.md`.
- **README.md** — The project **ledger**. Only exists once a project has
  sprints. Sprint names, status, dates, and pointers — no mechanism. See
  `TEMPLATES/PROJECT-LEDGER.template.md` and
  [Multi-Sprint Projects](#multi-sprint-projects).
- **sprints/NN-name/** — One sprint: its `plan.md` (frozen when the sprint ends)
  and its `outcome.md`. See [Multi-Sprint Projects](#multi-sprint-projects).
- **outcome.md** — Closes a sprint: planned vs. shipped, the commits, what got
  falsified, and the carry-forward list that feeds the next sprint's plan. See
  `TEMPLATES/SPRINT-OUTCOME.template.md`.
- **test-plan.md** — Tiered verification scenarios. Defines what to test, how to
  test it, and at what priority. Created after the plan when structured
  verification is valuable. Optional. See `TEMPLATES/TEST-PLAN.template.md`.
- **sessions/** — Dev journals capturing what happened during implementation.
  Created during work. See `TEMPLATES/YYYY-MM-DD-SESSION.template.md`.
- **artifacts/** — Freeform working research: codebase exploration, dependency
  analysis, source code mapping, architecture sketches. No template — these are
  whatever the work generates.
- **handoff.md** — **Deployment only.** Integration steps required to ship the
  work; scoped to a release, not to a sprint. **Not a "what the next session
  should do" document** — that's `outcome.md`, see
  [There is no "handoff to the next sprint"](#there-is-no-handoff-to-the-next-sprint-and-that-is-deliberate).
  Created during branch finalization when the work requires more than merging
  code — database migrations, service redeployments, environment config changes,
  manual coordination. Most projects won't need this. See
  `TEMPLATES/HANDOFF.template.md`.

### Proposals

Proposals capture the _why_ and _what_ before implementation begins. They
explore options, constraints, and expected outcomes.

**When to write a proposal:**

- You're reasonably certain action is needed and want to define what it looks
  like
- The work needs design decisions or scope definition
- Multiple approaches exist and you need to evaluate tradeoffs

**When NOT to write a proposal:**

- Still uncertain if action is needed — investigate first
- Trivial changes — use backlog
- Already know exactly what to do — skip to a plan

**Length guidance:**

- Lightweight (50-200 lines): Simple features with clear scope
- Standard (200-500 lines): Moderate complexity, some alternatives to explore
- Comprehensive (500-1,000 lines): Complex systems, multiple components
- Very large (> 1,000 lines): Consider splitting into multiple proposals

### Design Resolutions

Design resolutions crystallize system-level decisions before development
planning begins. They resolve behavioral ambiguity, data model questions,
boundaries, and architectural positioning that the proposal leaves open.

**When to write a design resolution:**

- The proposal contains unresolved behavioral or structural questions
- The system introduces new entities or state models
- The work affects architecture or cross-cutting concerns
- The development plan would otherwise require speculative assumptions
- Parallel agent execution requires clear system contracts

**When NOT to write a design resolution:**

- The feature is small and bounded
- The proposal is already behaviorally precise
- The work is refactoring-only with no new system behavior

This aligns with the principle: **Lightweight where possible, formal when
valuable.** A design resolution is a bridge between "what are we building?" and
"how do we build it?" — use it when that bridge has gaps.

### Plans

Plans translate proposals into actionable paths forward. They describe the _how_
at a practical level without micro-managing implementation.

**When to write a plan:**

- A proposal is approved and implementation is starting
- The work needs a roadmap with phases and validation criteria
- Multiple developers or sessions will work on this

**When NOT to write a plan:**

- No proposal exists — write one first
- Still investigating — not ready for a plan yet
- Trivial work — just do it

**Tips for good plans:**

- Keep phases coarse-grained — focus on pivotal points, not task lists
- Use complexity boxes, not time boxes
- Ground in the current codebase — reference specific files and patterns
- Define validation criteria for each phase

**Length guidance:** a plan is sized like a proposal, and for the same reason —
past ~500 lines nobody reads it whole, and past ~1,000 lines it is no longer one
plan, it's several wearing one filename. **A plan that has outgrown its size is
a signal the project needs a second sprint, not a longer plan.**
`spell-hardening/plan.md` reached 1,951 lines / 122KB across nine rounds of
in-place amendment because the convention offered no second plan to write.
`mind-mapper/` hit the same wall and improvised in the other direction —
`plan-round3.md` through `plan-round12.md` as loose siblings, with no ledger
saying which one was live. Both are the missing sprint shape showing through.

### Test Plans

Test plans define structured verification scenarios for agent-implemented work.
They translate proposal goals and plan phases into concrete, prioritized test
scenarios using a three-tier system.

**When to write a test plan:**

- Features with UI that need visual verification
- Work where "did the agent actually build what was asked?" is a real question
- Parallel development where manual testing becomes a bottleneck
- Complex features with multiple user flows to verify

**When NOT to write a test plan:**

- Pure refactoring with no behavioral changes
- Documentation-only work
- Trivial changes where the commit diff is the verification
- Projects with comprehensive existing automated test coverage

**The three-tier system:**

- **Tier 1 (Smoke):** Non-negotiable. App builds, pages render, no console
  errors.
- **Tier 2 (Critical Path):** The real value. Core user flows mapped from
  proposal goals. Key unit tests for non-trivial logic.
- **Tier 3 (Edge Cases):** Explicitly deferred with rationale. Complex mocking,
  error states, adversarial inputs.

The tiered system prevents the common failure mode of test plans — trying to
test everything and testing nothing well. Explicit deferral is a feature, not a
gap.

### Sessions

Sessions are dev journals — informal records of what happened during
implementation work.

**When to write a session:**

- Something notable happened during implementation
- Work went off-plan — bugs, unexpected complexity, discoveries
- You need to capture context for resuming later or handing off

**When NOT to write a session:**

- Everything went smoothly with nothing interesting to capture
- Trivial work with nothing notable

Sessions serve both as personal reflection and as handoff documentation. Write
what's relevant, skip what's not.

### Artifacts

Artifacts are working research documents generated during the course of project
work. They're freeform and varied — no standard template.

Examples: codebase exploration notes, dependency analysis, source code path
mapping, architecture sketches, API research.

**How artifacts differ from investigations:** Investigations are discovery work
done _before_ a project exists ("should we build this?"). Artifacts are research
done _during_ project work ("how do we build this?").

## Multi-Sprint Projects

Some projects are bigger than one plan. The failure this structure prevents is
specific and has happened here twice: with only one `plan.md` on offer, the only
way to plan more work is to **rewrite the plan you already executed against** —
so the record of what you actually planned, and what you knew when you planned
it, is overwritten by the next round's intentions.

A **sprint** is one plan's worth of work: planned, executed, closed out, frozen.

```
projects/
  my-project/
    README.md              — the LEDGER: sprint table, status, pointers
    proposal.md            — the arc: why, what, full scope, phase ordering
    sprints/
      01-drained-exit/
        plan.md            — the detailed dev plan for THIS sprint (frozen at close)
        outcome.md         — what shipped vs. planned; what carried forward
      02-recognized-flags/
        plan.md
    sessions/              — dev journals (unchanged; still project-level)
    artifacts/             — working research (unchanged)
```

### A project starts single-sprint

`proposal.md` + `plan.md` at the project root is still the default and still
correct. **You promote to the sprint structure when you discover the work is
multi-sprint** — you do not decide up front, and you never pre-plan sprints you
haven't scoped. Sprint 02 gets planned when sprint 01 closes and you know what
it actually left behind.

Promoting is mechanical: create `sprints/01-<name>/`, `git mv plan.md` into it,
write `README.md` from the ledger template, and start sprint 02's plan fresh.

### A closed sprint's plan is frozen

**When a sprint ends, its `plan.md` is never edited again.** Not a typo fix, not
a "small clarification," not a status update. If the work changed after the
sprint closed, that change belongs in `outcome.md` or in the next sprint's plan.

**The freeze binds from the commit that lands it, not from the moment you type
the banner.** Otherwise you could never fix a mistake made _while_ freezing — a
mistyped link, a wrong sha in the pinning header — and the rule would start its
life by forcing a violation. Everything in the freeze commit is still editable;
after it lands, nothing is.

Carry-forward happens by **restatement**: sprint 02's plan restates whatever it
inherits from 01, in its own words, with its own current line references. It
never reaches back and amends 01.

The cost this pays for is real: restatement duplicates text. That's the price of
a plan you can trust as a record of what was believed at the time. An amended
plan silently loses that — you cannot tell, reading it, which sentences were
written before the work and which were written after it went sideways.

**The one sanctioned exception: an ERRATUM block.** Sooner or later someone
finds a sentence in a closed sprint's plan that is not merely outdated but
actively misleading, and "never edited" leaves them two bad options — edit it
silently and break the rule, or leave a known-wrong document standing. Neither
is acceptable, so there is a third:

> **⚠ ERRATUM 2026-08-14:** the mechanism claimed in Phase 2 step 3 is wrong —
> `parseArgs` never sees the `=` form. Corrected in
> [sprint 03's plan](../03-flag-parsing/plan.md).

Append-only, at the top, dated, and it **points at where the truth now lives**.
Never a body edit. The body stays exactly as it was written, because the body is
the evidence of what was believed — an erratum adds a fact without destroying
one.

### A frozen plan's `file:line` references must be pinned to a sha

A frozen doc pointing at line numbers in a moving file is **worse than no
reference at all**, because the reader has no way to know they're being misled —
they'll land on a plausible-looking wrong line and believe it.

So a frozen plan states its sha once, at the top of any table or section that
cites `file:line`:

> All references below are pinned to `5dfbb0d`. Read them with
> `git show 5dfbb0d:path/to/file.ts`.

Evidence: in `spell-hardening/plan.md`, **6 of 9** audit references went stale
_within a single session_. Commit `82ec61c` fixed it by pinning the whole table
to `5dfbb0d` rather than renumbering — renumbering is a losing race, and it also
would have meant editing a document that was supposed to be settled.

Live plans (the current sprint) don't need pinning; they're expected to move
with the code. **Pin at freeze time**, as part of closing the sprint.

### README.md is a ledger, not a plan

The project `README.md` holds sprint names, status, dates, and pointers. It
holds **no mechanism, no file references, no technical claims, no design
rationale** — those live in the proposal, the plans, and the outcomes.

This constraint is the entire reason the ledger works. A document that only
contains "sprint 02, active, started 2026-08-06, plan →" cannot rot, because
nothing in it depends on the state of the code. The moment someone helpfully
adds "sprint 02 changes the exit path in `cli.ts` to drain stdout," the ledger
joins the set of documents that need maintaining and stops being a reliable
index — which is exactly how the one-plan-per-project convention rotted in the
first place.

If you're tempted to explain something in the ledger, that's the signal it
belongs in the proposal or the sprint's plan. Link to it instead.

**Why `README.md` and not `LEDGER.md`, since the name does invite prose.** It's
a real tension: every other `README.md` under `docs/` is an explanatory
convention doc, so the same filename now means two genres one directory apart.
The name wins anyway because a ledger is exactly what you want when you open the
folder, and `README.md` is what a folder renders. **The mitigation is a size
rule, not a rename: if the ledger is over ~60 lines, something crept in.** That
is a check anyone can run without knowing the convention, which is more than a
filename would have bought.

### outcome.md closes a sprint

An outcome is written once, when the sprint ends, and it is the only honest
record of the gap between intent and reality:

- **Planned vs. shipped** — including, explicitly, **what did not get done**. An
  outcome that reports only successes is worthless; the carry-forward list is
  the whole reason the next sprint can be planned at all.
- **The commits** — so the diff is reachable without archaeology.
- **What was falsified** — plans are claims. Record which ones the work
  disproved, so the next plan doesn't inherit a dead assumption.
- **Carry-forward** — the explicit list that feeds the next sprint's plan. This
  is the handoff; without it, restatement becomes guesswork.

See `TEMPLATES/SPRINT-OUTCOME.template.md`.

### The proposal is the one document that stays LIVING

Freezing plans only works if the durable scope has somewhere else to live.
**`proposal.md` is that place, and it may be amended for the life of the
project** — it owns the arc: why the work exists, the full inventory of what's
in scope, and the phase ordering. When a sprint discovers that the scope was
wrong, the correction lands in the proposal, not in a frozen plan.

Two living documents, then, and only two: the **proposal** (the arc) and the
**ledger** (where we are). Everything else is a bounded record that gets closed.

**State this explicitly or the gap reappears.** The one-plan convention rotted
partly because nothing said whether the proposal could be amended, so every
scope change went into the plan by default — which is how a plan becomes 1,951
lines. An undefined editability is not neutral; it routes all change to whatever
document someone last had open.

### Verification state belongs in the outcome

`test-plan.md` sits at the project root and is not sprint-scoped, so nothing
otherwise tells sprint 03 which Tier-2 scenarios sprint 01 actually ran.
**`outcome.md` closes that gap by rule: state what was verified, how, and what
was left unverified.** "The suite is green" is not a verification record — name
the scenarios, and say which ones were pinned by a test versus proven once by a
manual drive. Those are different guarantees and only one of them survives into
next week.

### An abandoned or interrupted sprint still gets an outcome

**A sprint that ends mid-flight — abandoned, interrupted, out of runway — is
closed the same way, with an `outcome.md` marked incomplete.** This is the case
where the rule earns its keep: a sprint that stopped halfway is exactly when the
next person most needs to know what was true when it stopped, and it is the case
where nobody feels like writing anything down.

An outcome for an abandoned sprint is **more** valuable than one for a clean
sprint, because a clean sprint's carry-forward is mostly derivable from the
commits and an abandoned one's is not.

### `_history/` holds superseded documents, and its files are dated

A document that has been replaced but is worth keeping — an early design note
the work moved past, a handoff whose round has since happened — goes to
`_history/` at the project root. It is neither research (`artifacts/`) nor a
sprint record, and deleting it loses provenance. Mark it historical at the top
of the file too; a reader who lands on it via search never sees the folder.

**Date-prefix everything in `_history/`, like sessions**
(`2026-08-05-handoff-ratify-round.md`), and for the same reason: there will be
more than one, and the second one always wants the generic name the first one
took.

### There is no "handoff to the next sprint," and that is deliberate

A **deployment** handoff is a real document — migrations, service redeploys,
environment config, manual coordination — written at branch finalization and
scoped to a **release**. That one stays. See `TEMPLATES/HANDOFF.template.md`.

**A continuity handoff — "here is what the next session should do" — is not a
convention here.** The runway a next-sprint author needs is already owned:

| what they need                    | who owns it                |
| --------------------------------- | -------------------------- |
| what the project is for           | `proposal.md`              |
| where we are                      | `README.md` (the ledger)   |
| what the last sprint actually did | `outcome.md`               |
| what it left behind               | `outcome.md` carry-forward |
| what to do now                    | this sprint's `plan.md`    |

A handoff adds no field to that table. What it adds is a **second,
forward-facing source for "what next"** — which will eventually disagree with
the carry-forward list, and nothing will flag the disagreement.

**The reason this is a rule and not a preference:** a handoff is a
forward-looking instruction with no defined close, so it rots by **purpose**
rather than by fact — and purpose-rot survives fact-checking. `spell-hardening`
paid for this. Its handoff called for a ratify round; the round happened; the
document's claims were audited twice, individually, over a full day — and its
entire reason to exist had expired before the first audit. Its own banner says
it best:

> _a document whose job is to say "the other document is stale" needs its own
> staleness rule — and needs it for its PURPOSE, not just its claims._

`outcome.md` structurally cannot fail that way. **It is a record of the past.**
A record can be incomplete; it cannot expire.

_(Note also which name got borrowed: that file was not a deployment handoff at
all. The continuity gap was real and reached for the nearest available filename,
which already meant something else. If you find yourself wanting a handoff
between sprints, what you actually want is a better `outcome.md`.)_

### Sessions and artifacts stay project-level

`sessions/` and `artifacts/` remain at the project root. Sessions are already
date-ordered, so they're readable across sprints without nesting, and research
usually outlives the sprint that produced it. Only `plan.md` and `outcome.md`
are sprint-scoped, because they're the only two documents that describe a
bounded commitment.

## Naming Conventions

**Project folder names:** Descriptive kebab-case without date prefixes.

- `oauth-upgrade`
- `search-enhancement`
- `milkdown-editor`
- `documentation-restructuring`

Date is implicit from git history and document metadata.

**Document names within projects:** Simple descriptive names without date
prefixes.

- `proposal.md`
- `plan.md`

**Sprint folders: zero-padded number + kebab-case name.**

- `sprints/01-drained-exit/`
- `sprints/02-recognized-flags/`
- `sprints/10-surface-rehome/`

The number is zero-padded so `ls` and every file tree sorts them in execution
order — `10-` sorting above `2-` is a small thing that makes a ledger and a
directory listing disagree, and the directory is what people actually look at.
The name is what the sprint was _about_, not "phase two" — a listing should tell
you what happened without opening anything.

**Sessions keep date prefixes** since there can be multiple per project:

- `sessions/2026-02-09-initial-implementation.md`
- `sessions/2026-02-15-edge-case-fixes.md`

## Cross-References

- Reference investigations: `../../investigations/investigation-name.md`
- Reference reports: `../../reports/report-name.md`
- Reference architecture: `../../architecture/doc-name.md`
- Reference specifications: `../../specifications/spec-name.md`
- Internal project references: use relative paths within the folder (e.g.,
  `./proposal.md`, `./sessions/2026-02-09-session.md`)

## Archival

When a project is complete, move the entire folder to `projects/_archive/`.
Internal references remain valid because they're relative within the folder.
**Sprints change nothing here** — `sprints/` moves with the folder, and
sprint-to-sprint links (`../01-drained-exit/outcome.md`) are relative, so they
survive the move intact. Archive the whole project, never an individual sprint;
a sprint out of its project's context is unreadable. External references to
archived projects use `./_archive/project-name/` paths (from the projects
directory).

## Templates

Project-scoped templates are available in the `TEMPLATES/` subfolder:

- `TEMPLATES/PROPOSAL.template.md` — Starting point for project proposals
- `TEMPLATES/DESIGN-RESOLUTION.template.md` — Starting point for design
  resolutions
- `TEMPLATES/PLAN.template.md` — Starting point for implementation plans (one
  sprint's worth)
- `TEMPLATES/SPRINT-OUTCOME.template.md` — Starting point for a sprint's
  `outcome.md`
- `TEMPLATES/PROJECT-LEDGER.template.md` — Starting point for a multi-sprint
  project's `README.md`
- `TEMPLATES/TEST-PLAN.template.md` — Starting point for test plans
- `TEMPLATES/YYYY-MM-DD-SESSION.template.md` — Starting point for session
  journals
- `TEMPLATES/HANDOFF.template.md` — Starting point for deployment handoffs

Copy the relevant template into your project folder when needed.
