---
type: playbook
title: "Running a Multi-Cycle Feature — Playbook"
description:
  "Running a feature that spans more than one cycle: opening each cycle, closing
  it with an honest Outcome, and keeping closed records trustworthy."
tags: [process, cycles, planning]
status: stable
generated: { by: claude-opus-5-5, at: 2026-09-26 }
---

# Running a Multi-Cycle Feature — Playbook

## Goal

A feature too big for one cycle runs as a series of cycles, each of which
produces a record a later reader can trust: what was planned, what shipped, what
the work disproved, and what carried over. Use this playbook once a feature's
work spans a second cycle. A single cycle needs only
[cycles/README.md](../cycles/README.md).

The mechanics (cycle files, `cycle:` on items, `pdocs view`) are the scaffold's.
This playbook adds the three rules the scaffold does not have. They were carried
over from the 8.x multi-sprint convention (`git show 8485ac99`) when the docs
moved to project-docs 9.0.0.

## Steps

1. **Keep the arc in `feature.md`, and only there.** Why the work exists, the
   full scope and the phase ordering are the feature's; it is the one document
   you keep amending for the life of the work. When a cycle finds the scope was
   wrong, correct `feature.md`, not a cycle.
2. **Open the next cycle only when the current one closes.** Scope it from what
   the last Outcome says was carried over; do not pre-plan cycles you have not
   scoped. Put its plan in the cycle's **Why now** and **Scope**, and a longer
   argument in a document the feature owns, linked from the cycle.
3. **Put the work on items, not in the cycle.** Each piece of work is an item
   with `parent: feature/<slug>` and `cycle: <cycle-slug>`. The ledger is
   `bun scripts/pdocs/cli.ts view feature <slug>`: do not hand-maintain a status
   table.
4. **Close every cycle with an Outcome, including an abandoned one.** Write it
   when the cycle closes, and make it answer all of these:
   - **Planned vs. shipped**, including what did not get done.
   - **The commits or merges** that delivered it, so the diff is reachable.
   - **What was falsified**: which claims in the plan the work disproved, so the
     next cycle does not inherit a dead assumption.
   - **What was verified, and how**: name the checks, and separate a test that
     pins a behaviour from a one-off manual run. "The suite is green" is not a
     verification record.
   - **Carried over**: the items moved to the next cycle (change their `cycle:`)
     or dropped, each named.

   An abandoned cycle gets `lifecycle: abandoned` and the same Outcome. It is
   the one whose carry-over git cannot reconstruct.

5. **Do not edit a closed cycle's plan.** Once the close commit lands, its Why
   now, Scope and linked plan document are a record of what was believed at the
   time. Carry anything forward by restating it in the next cycle, in its own
   words. If a closed plan says something actively misleading, add one dated
   line at the top and leave the body alone:

   > **⚠ ERRATUM YYYY-MM-DD:** [what is wrong]. Corrected in [link to where the
   >
   > > truth now lives].

   Edits made while closing, in the close commit itself, are fine.

6. **Pin `file:line` references in a closed record to a commit.** When closing a
   cycle, state the commit once above any section that cites line numbers:
   "References below are pinned to `<sha>`; read them with
   `git show <sha>:<path>`." A live cycle's references may move with the code.
7. **Do not write a continuity handoff between cycles.** What the next cycle
   needs is already owned: the arc by `feature.md`, where things stand by
   `pdocs view feature`, what happened and what carried over by the last
   Outcome. If you want a handoff, write a better Outcome. The `HANDOFF`
   template is for deployments only.

## Verification

- [ ] `bun scripts/pdocs/cli.ts view feature <slug>` lists every open item of
      the feature, and each one in the current cycle shows it in
      `view cycle <cycle-slug>`.
- [ ] Every closed or abandoned cycle of the feature has an Outcome naming what
      shipped, the commits, what was falsified, what was verified, and what
      carried over. A missing heading is the failure.
- [ ] For each closed cycle,
      `git log --format=%h <close-commit>.. -- <cycle file> <linked plan>` shows
      no body edits after the close commit, only erratum lines.
- [ ] `grep -nE '[a-zA-Z_./-]+\.(ts|md|json):[0-9]+' <closed plan>` returns
      nothing that is not under a pinned-commit line.
- [ ] Nothing named like a handoff (`handoff*.md`, `next-*.md`) exists in the
      feature's folder unless it is a deployment handoff.
