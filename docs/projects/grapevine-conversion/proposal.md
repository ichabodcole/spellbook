# Grapevine Conversion — the rewrite-then-relocate pathfinder

**Status:** Draft **Created:** 2026-09-05 **Author:** Cole Reed + Claude Code
(prospero)

---

## Overview

Grapevine's watch surface is a 1,000-line Alpine single-pager served as a static
file by its daemon. This project rewrites it as a component-oriented React
surface, relocates it to `src/grapevine/surface/`, and puts it on the build
pipeline — the sixth spell to make that trip.

**It has a second deliverable of equal weight, and that one is the reason
grapevine goes first.** The existing porting playbook covers _relocating_ a
surface that is already React. All three remaining spells need one **written**
first, and the playbook says so in its own Applicability section: _"A spell with
no `surface/` is not yet a port subject — the rewrite comes first."_ So the
pattern we have covers step two, and every spell left is stuck at step one. This
project extends the playbook from **relocate** to **rewrite then relocate**, so
that bounty and digestify can be converted in parallel against a brief that
actually exists.

## Problem Statement

Contract 3's 2026-09-04 amendment settled the direction: every spell gets a
build, and the open question is order rather than whether. Three spells remain,
and none of them can start.

**The blocker is not the build pipeline — it is that these three have no surface
to relocate.** Each is a single hand-written HTML file:

| spell       | surface                 | lines | what guards it                           |
| ----------- | ----------------------- | ----- | ---------------------------------------- |
| `digestify` | `scripts/template.html` | 1,505 | one cell: _does it parse_                |
| `bounty`    | `scripts/template.html` | 1,003 | one cell: the b16 Alpine-mirror lockstep |
| `grapevine` | `scripts/watch.html`    | 1,000 | **nothing**                              |

⛔ **Those three files are 3,508 of the 4,611 lines `gate-honesty.test.ts`
declares blind — 76% of everything no test in this repo can see.** A rewrite of
any of them runs without a safety net, and that fact is the single most
important input to how this work is scheduled.

The second problem is the one Cole named directly: a single HTML file is hard to
upgrade. New features mean editing one growing document rather than composing
components, and the cost compounds every time the spell grows.

## Proposed Solution

**Grapevine first, serially, with the anthill team. Then bounty and digestify in
parallel against what grapevine produced.**

Grapevine is the right pathfinder on four measured grounds:

1. **One component root.** `grep -c x-data` returns **1** — a single
   `x-data="grapevine…"` at line 515. There is no nest of interacting Alpine
   components to untangle, which is exactly what bounty's board would be.
2. **A clean markup / logic split already exists.** The `<style>` block ends at
   513 and the inline `<script>` starts at 707, so the file is already three
   parts rather than an interleaving: styles, markup, ~293 lines of component
   logic.
3. **No Alpine-mirror lockstep.** Bounty pairs tested `server.ts` helpers with a
   hand-written Alpine mirror and only one cell guards the drift; grapevine has
   no such coupling to preserve.
4. **Its backend is the best-tested of the three** — `cli.test.ts` is 2,075
   lines over a 2,314-line CLI, so a surface rewrite cannot silently break the
   daemon underneath it. That is the closest thing to an oracle available here,
   and it sits on the side of the seam the rewrite does not touch.

> ⚠ **A fifth ground was drafted and WITHDRAWN, recorded because the correction
> matters more than the claim.** This read _"its CLI is already acc-conformant
> from the standard-grapevine session."_ **It is not.** Grapevine emits an acc
> **declaration** (standard-grapevine, landed at `aff4d10`) — which is not the
> same as having been **run** against the conformance kit. It has no
> `acc.config.json`; astrolabe, glamour, magpie and mind-mapper each have one
> and grapevine does not. _Emitting a schema and passing a check are two facts,
> and the house pattern keeps them in separate files for exactly this reason._
>
> **It changes nothing about the decision**, which is the only reason it stays a
> footnote: acc conformance is a prerequisite only when the backend ships built,
> and grapevine's backend is out of scope here.

**The surface is hand-rolled CSS, not Tailwind** — 11 custom properties on
`:root`, zero occurrences of "tailwind" in the file. So the rewrite adopts the
kit's semantic-token layer (house theming convention) rather than migrating one
utility system to another, and Contract 21's `source(none)` + `@source "./"`
scoping applies on arrival.

_Its own header comment is a piece of falsified canon worth keeping as
evidence:_ _"Alpine via CDN — grapevine stays no-build (CDN libs only)."_

## Scope

**In Scope:**

- Rewrite `watch.html` as a component-oriented React surface at
  `src/grapevine/surface/`, preserving observable behaviour of the watch route.
- Relocate + build per the porting playbook's existing Phases 1–3; commit the
  rebuilt `dist/`.
- Remove the CDN dependencies (Alpine, Google Fonts) that the build replaces.
- `daemon.ts`'s `/watch` route serves the built `dist/` instead of a static
  file.
- **Extend the porting playbook to cover the rewrite phase** — the
  parallel-track deliverable.
- Update `DECLARED_BLIND` in `gate-honesty.test.ts`, with the arithmetic
  reconciled exactly as that file's convention requires.

**Out of Scope:**

- **Grapevine's backend.** `daemon.ts` and `cli.ts` share nothing with another
  spell today, so Contract 3's criterion does not fire and they keep shipping as
  Bun-native source. A backend build here would be work with no trigger behind
  it.
- **Bounty and digestify.** They are the parallel phase, and they start when the
  playbook can brief them.
- **Kit extraction.** Separate project; see the sequencing note below.
- **New surface features.** A rewrite that also adds behaviour cannot be
  verified against the old one.

**Future Considerations:** grapevine's backend joins the build the moment it
imports shared code — which is likely to be the CLI-kit project rather than
anything in this one.

## Technical Approach

Follows the established five-spell pattern: `src/<spell>/surface/` as build
input, `bun run build grapevine` emitting a flat hashed dependency-free `dist/`
into the deployed folder, `dist/` committed and verified by reproduction
(Contract 18), surface source never shipping (Contracts 4 and 20).

**What is genuinely new is the rewrite phase, and it needs a verification
strategy the playbook does not currently supply.** The old surface has no tests.
Rewriting untested UI against no oracle is the actual risk in this project, and
the plan phase owes an answer before anyone writes a component — options include
capturing the current rendered output as a baseline, asserting the route's
contract rather than its markup, or accepting a manual smoke test and saying so
out loud.

## Impact & Risks

**Benefits:** grapevine becomes upgradable by composition rather than by editing
a 1,000-line file; 1,000 lines leave the gate's blind set; the playbook gains
the phase that unblocks the other two spells.

**Risks:**

- **No oracle for the rewrite** (above) — the primary risk, and the reason this
  is serial.
- **Behaviour drift the gate cannot see.** The surface is 100% blind today; a
  regression ships silently unless the plan changes that.
- **Playbook over-fitting.** A rewrite phase written from one spell may not fit
  bounty's nested-component case. Mitigation: state the playbook's bounds
  explicitly, and treat bounty's first divergence as a finding rather than a
  failure.

**Complexity:** High — not for the port, which is well-trodden, but for the
rewrite against no tests.

## Open Questions

1. **What is the rewrite's oracle?** Blocking; owed by the plan phase.
2. **How faithful must the rewrite be?** Pixel-faithful, behaviour-faithful, or
   licensed to improve the design while it is open? This is a product call and
   it changes the verification answer.
3. **Does the `/watch` route's contract change?** If the daemon serves a built
   bundle, anything depending on the current static-file shape needs checking.

## Success Criteria

- `bun run gate` green; `bun scripts/dist-check.ts` exit 0 with grapevine in the
  roster (6 buildable spells).
- The deployed folder ships no build-input source (`dist-roster-ward`).
- `DECLARED_BLIND` reconciles exactly, ~1,000 lines lighter.
- **The playbook's rewrite phase is written and has been read by someone who did
  not do the rewrite** — the parallel phase depends on it being legible to a
  fresh agent, not to its author.

---

**Sequencing note — the parallel phase, and one flip.** Cole's framing was:
convert the three, then look across the roster and extract common behaviour. The
extraction across the **five spells that already build does not depend on these
ports**, and running it first means bounty and grapevine adopt the kit _as part
of_ their conversion rather than being retrofitted after it — one pass each
instead of two. Recorded here rather than acted on; the ordering is Cole's call.

---

**Related Documents:**

- [Porting a spell](../../playbooks/porting-a-spell-playbook.md) — the playbook
  this project extends
- [Spell Surface Pipeline](../spell-surface-pipeline/proposal.md) — the
  framework standard being validated
- [Glamour Conversion](../glamour-conversion/plan.md) — the most recent port,
  and the closest exemplar
- `.anthill/dev/seams.md` Contract 3 (amendment 2026-09-04) — the ruling that
  makes this scheduled work
- [Six `die`s — the CLI boilerplate census](../../backlog/2026-09-03-six-dies-the-cli-boilerplate-census.md)
  — the extraction project referenced above

---

## Notes

Measurements in this proposal were taken 2026-09-05 at `8ce5de5`. The collision
analysis behind the serial-then-parallel decision — `DECLARED_BLIND` as a single
shared map, `bun run build` with no arguments clearing every `dist/`, concurrent
repo-wide gates, and shared canon files — is what ruled out briefing three
agents at once against the current playbook.
