---
type: backlog
title: "Sixteen dead references, surfaced the day the docs lint arrived"
description:
  Sixteen references in docs/ resolved to nothing, found by the lint rather than
  by any reader — fixed inside the upgrade so lint.adopting could be turned off,
  which is what gave the docs gate teeth
status: stable
lifecycle: done
generated: { by: unknown, at: 2026-09-15 }
---

# Sixteen dead references, surfaced the day the docs lint arrived

**Severity:** low — nothing is broken at runtime. **Found:** 2026-09-15, by
`pdocs check`'s `MISSING FILE` rule on its first run, during the `docs_version`
4.4.0 → 8.1.0 upgrade.

⛔ **THE POINT IS NOT THE TWELVE LINKS. It is that nothing in this repository
had ever checked one.** These accumulated over months of moving projects into
`_archive/` and renaming folders, and every one of them survived every review of
the page it sits on, because a reader who does not click does not notice. The
lint found all twelve in under a second.

## The twelve, classified

**Moved into `_archive/` — re-point (5).** The project folder still exists, one
level deeper:

- `memories/2026-06-30-astrolabe-build-and-react-rehome.md` → two links to
  `../projects/cross-project-observatory/{sessions/…,proposal.md}`
- `projects/spell-hardening/…` → two links to
  `../spellbook-extraction/proposal.md`
- `backlog/2026-08-05-grapevine-bounded-tail.md` →
  `./2026-08-05-cli-stdout-truncation-on-pipe.md`, a sibling backlog item that
  is gone rather than archived (⚠ an earlier pass of this survey mis-classified
  it as archived, because the classifier matched the `.` in `./…` against a
  directory test)

**A path that appears never to have existed (3).** Three documents link to
`projects/spell-hardening/plan.md`. That project has `sprints/<n>/plan.md` and
no top-level `plan.md` in any commit reachable from `main`:

- `backlog/2026-08-06-bounty-session-key-hijack-and-identity.md`
- `investigations/2026-08-06-spell-cli-contract-investigation.md`
- a `DEV_KICKOFF.md`, which spells it absolute as
  `docs/projects/spell-hardening/plan.md`

Worth reading before repairing: if the intended target is a specific sprint's
plan, the right fix names the sprint. If the link was aspirational, it should
go.

**Genuinely gone (4).**

- `investigations/2026-07-06-astryx-component-library-evaluation.md` →
  `../fragments/spells-as-interface-layer-decomposing-software.md`
- a category `README.md` →
  `../../investigations/2025-10-14-ai-composable-refactoring-investigation.md`
- a `README.md` → `../03-flag-parsing/plan.md`
- `projects/glamour-conversion/sessions/2026-09-03-the-port.md` →
  `../../../.anthill/retro.md`, which is outside the docs root and gitignored

## Why it is filed rather than fixed

It arrived inside the project-docs upgrade, and repairing twelve links across
`backlog/`, `investigations/`, `memories/` and `projects/` is separate work from
installing the frontmatter layer — folding it in would have made a 273-file
commit unreviewable. Nine of the twelve also sat in folders that subagents were
editing at the time.

⚠ **Each fix needs a judgement, not a rewrite rule.** Re-point to `_archive/`,
name the sprint that was meant, or delete the sentence — and for the
`.anthill/retro.md` case, the target is deliberately outside the tree, so the
honest fix may be to stop linking it at all.

## ⛔ And four MISSING ANCHOR problems, which the first pass of this item missed

It claimed twelve. It is sixteen. The first survey grepped only for
`MISSING FILE`, so four `MISSING ANCHOR` problems — links to a `#section` that
is not a heading — went uncounted. They are one cluster, in a single sprint
folder, and read like headings that were renamed after the links were written:

- `projects/spell-hardening/sprints/03-what-close-takes-with-it/decisions.md` →
  `#a5`, `#a7`, `#b`
- `projects/spell-hardening/sprints/03-what-close-takes-with-it/plan.md` →
  `./decisions.md#b`

⚠ **The lesson is the same one this item is about, turned on itself:** a survey
that greps for one problem kind reports one problem kind. The authoritative
population is what the tool prints, not what a reader thought to look for.

## What this actually blocks, measured

`lint.adopting: true` is the only reason the gate exits 0 today. Tested by
flipping it locally and reverting:

```
lint.adopting: false  →  pdocs check exits 9, 16 problem(s)
                         12 MISSING FILE · 4 MISSING ANCHOR
```

So these sixteen are precisely what stands between this repository and a docs
gate that can fail. Until they are fixed, `adopting` stays on and the wired
check runs without teeth — which is deliberate and is the migration guide's own
advice, but should not be mistaken for the gate being live.

## ✅ CLOSED — all sixteen fixed, and `lint.adopting` is off

Cole ruled they be fixed inside the upgrade rather than deferred, which is what
allowed `lint.adopting: false`. Before: `pdocs check` exit 9, 16 problems.
After: **exit 0, "OK — no problems."** The wired gate can now fail, which was
the whole point of doing them here.

| what                                  | how many | fix                                                                                                          |
| ------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| anchors pointing at non-headings      | 4        | re-pointed at the lint's own slugs, read out of `headingSlugsOf` rather than guessed from GitHub's algorithm |
| targets moved into `_archive/`        | 6        | path re-pointed                                                                                              |
| the split-up monolithic plan          | 3        | → `spell-hardening/roadmap.md`, the overview that survived the split into `sprints/<n>/plan.md`              |
| genuinely deleted                     | 2        | unlinked, wording kept                                                                                       |
| illustrative examples in block quotes | 2        | unlinked — they were teaching a convention, not referencing a file                                           |

⚠ **The count was wrong twice, both times too low, both times for the same
reason.** First "twelve", because the survey grepped `MISSING FILE` and never
saw 4 `MISSING ANCHOR`. Then "five moved to `_archive/`", because
`2026-08-05-cli-stdout-truncation-on-pipe.md` was assumed deleted when it sat in
`backlog/_archive/` — six, not five. Both corrections came from asking the tool
instead of a regex, which is the same lesson this item was filed to make.

⛔ **AND FIXING THEM BROKE THE GATE ONCE, VIA THE FORMATTER.** Normalising the
edited markdown with a blanket `bunx prettier --write docs` reformatted 19 files
that are NOT markdown — four `.report.json`, four `.ts`, eleven `.html` mockups
— all of which Biome owns here. Eight Biome errors, gate red, on files the
change never meant to touch. Reverted the collateral, kept the thirteen real
edits. **`docs/` is not a markdown-only directory, and a blanket formatter over
it fights whatever else owns what is in there.** Reported upstream as the tenth
item from this run.

## Related

- `docs/releases/3.0.0-breaking-changes.md` — the release this upgrade followed.
- The lint that found them is `scripts/pdocs/`, installed by the v2.6→v2.7
  migration; `MISSING FILE` is checked in both tiers.
