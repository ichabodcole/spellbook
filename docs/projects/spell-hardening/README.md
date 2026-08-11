# Spell Hardening

**Status:** Active · **Started:** 2026-08-05 · **Current sprint:**
**[05, "the gate"](./roadmap.md) — convened 2026-08-10 on
`fix/spell-hardening-05`.** [03](./sprints/03-what-close-takes-with-it/plan.md)
shipped in v2.1.0; [04](./sprints/04-the-shape-of-nothing/plan.md) shipped in
**v2.2.0** (`c2c00a5`).

> **Part 1 of the two-part end condition is now DRAINED.** Issues #79 #85 #86
> #87 #88 #97 shipped in v2.2.0 and were **closed 2026-08-10** — they had been
> fixed and left open, which is why this project's defect count read worse than
> it was. **Sprint 05 is purely part 2: the rules exist AND are enforced.**
>
> Scope ruled by Cole: **clause (ii)** (the bidirectional rule↔check link) moves
> to **sprint 06**, and the `tsc --noEmit` gate is
> [its own project](../../backlog/2026-08-10-typecheck-gate-is-a-project-not-a-flag.md)
> — measured at **436 errors**, 61% of them from `noUncheckedIndexedAccess`.

> **✅ Sprint 04's [`outcome.md`](./sprints/04-the-shape-of-nothing/outcome.md)
> was written 2026-08-10**, at sprint 05's convene — **four days late, and it
> says so at the top.** It is the artifact, not another note about its absence.
>
> **⚠ Sprint 03 still has none.** What 03 delivered lives in its merge body
> (`git show 88a298f`) and its
> [decisions](./sprints/03-what-close-takes-with-it/decisions.md) — the merge
> body is **not reachable from `docs/`**, which is the gap, not the record.
>
> _Two warnings stood here for four days. Writing a third would have been the
> failure itself — see
> [the unclosed unit](../../backlog/2026-08-10-the-unclosed-unit.md)._

Fourteen reported defects across the shipped spells, all of one family: a
command that cannot do the thing returns something shaped like success. This
project closes them.

> **⚠ The scope widened at sprint 03, and the sentence above no longer covers
> all of it.** `#73`/`#74` — `close` writing live state over a populated
> snapshot — are **not** misreports. The command does the thing; **it destroys
> your data doing it.** Cole ruled 2026-08-07 that they belong here rather than
> in a separate project, so the honest description is now **two** families:
>
> 1. **Honest reporting** — a command that cannot do the thing says it did.
> 2. **Durability** — a command that can do the thing takes something with it.
>
> **Sprint 03 also carries lanes with no issue number** (P1d–P1f, found by this
> project rather than reported to it), so **the open-issue count is no longer a
> measure of what is left.** It was already an imperfect one — sprint 02's P0f
> closed nothing either.

**The arc:** [proposal.md](./proposal.md) · **What is coming:**
[roadmap.md](./roadmap.md) — the end condition, the sprint 05 forecast, and what
is parked. **A forecast, not a plan.**

## Sprints

| #   | Sprint                                                                    | Status   | Opened     | Closed     | Outcome                                                 | Decisions                                                       |
| --- | ------------------------------------------------------------------------- | -------- | ---------- | ---------- | ------------------------------------------------------- | --------------------------------------------------------------- |
| 01  | [drained-exit](./sprints/01-drained-exit/plan.md)                         | Complete | 2026-08-05 | 2026-08-06 | [outcome](./sprints/01-drained-exit/outcome.md)         | —                                                               |
| 02  | [success-shaped-lies](./sprints/02-success-shaped-lies/plan.md)           | Complete | 2026-08-06 | 2026-08-07 | [outcome](./sprints/02-success-shaped-lies/outcome.md)  | [decisions](./sprints/02-success-shaped-lies/decisions.md)      |
| 03  | [what-close-takes-with-it](./sprints/03-what-close-takes-with-it/plan.md) | Complete | 2026-08-07 | 2026-08-08 | **none — see note below**                               | [decisions](./sprints/03-what-close-takes-with-it/decisions.md) |
| 04  | [the-shape-of-nothing](./sprints/04-the-shape-of-nothing/plan.md)         | Complete | 2026-08-08 | 2026-08-10 | [outcome](./sprints/04-the-shape-of-nothing/outcome.md) | [retro](../../../.anthill/retro.md)                             |
| 05  | [the-gate](./sprints/05-the-gate/plan.md)                                 | Complete | 2026-08-10 | 2026-08-10 | [outcome](./sprints/05-the-gate/outcome.md)             | [carries](./sprints/05-the-gate/carries.md)                     |

_Reconciled 2026-08-10 @ `ea0b34b` (docs-of-record sweep, sprint 05 finalize) —
"sprint 04 has no outcome.md": **FALSIFIED**, written at `3a0183c`, row updated.
"sprint 03 has no outcome.md": **HELD**, still absent, warning retained. "part 1
of the end condition is drained": **HELD** — #79 #85 #86 #87 #88 #97 closed
2026-08-10. "the sprint table lists every sprint": **FALSIFIED** — sprint 05 had
run with no folder and no row; container created at finalize (`388602e`), and
the nine-hour absence is recorded in its plan. ⚠ **This line is stamped at
`ea0b34b`, which is TWELVE COMMITS BEFORE the fix it reports** — the sha names
when the sweep RAN, not when the repair landed, and nothing in the format
distinguishes those. Caught by a cold reconstruction at the merge. "14 reported
defects" (opening line): **UNCHECKED** — nobody owned it this session._

**Status values:** Not planned | **Scaffold** | Active | Complete | Abandoned

> **🟡 Scaffold** means the scope is written down and argued, but **not ratified
> and not buildable.** Sprint 01's ratify round falsified six claims in a plan
> written by one author; sprint 02's much narrower round found two more. **A
> scaffold has not survived that yet.** _(Status added 2026-08-07 — the previous
> four values had no way to say "proposed", so a scaffold would have had to
> masquerade as `Active` or hide as `Not planned`.)_

Sprint 03 was scaffolded because both prior sprints deferred work **with names**
— see [sprint 02's outcome](./sprints/02-success-shaped-lies/outcome.md),
"CARRY-FORWARD → sprint 03," for what it inherits and what it explicitly does
not. It was ratified at its convene on 2026-08-07 (the round falsified six
scaffold claims, including the predicate every lane was about to be built on),
built across six lanes, and merged on 2026-08-08.

> **⚠ SPRINT 03 HAS NO `outcome.md`, AND THAT IS A GAP RATHER THAN A CHOICE.**
> Sprints 01 and 02 both have one. For sprint 03 the durable account of what
> shipped lives in the **named merge commit `88a298f`** — why it existed, what a
> caller gets, the decisions, and what it deliberately does not reach — plus
> [`decisions.md`](./sprints/03-what-close-takes-with-it/decisions.md) for the
> rulings and [`.anthill/retro.md`](../../../.anthill/retro.md) for the retro.
> **This matters more than usual here:** the sprint's own open question 2 ruled
> that lanes P1d–P1f get **no GitHub issue**, so for those three there is no
> record outside this project folder and that commit body.
>
> _Found by a fresh agent reconstructing the release from the tree — it could
> not establish from the docs whether the sprint had happened, because this file
> still said "scaffolded, awaiting ratify" a day after it shipped._

## Releases

**[v2.0.0](https://github.com/ichabodcole/spellbook/releases/tag/spellbook-v2.0.0)
— sprints 01–02.** Cut 2026-08-06 from `a0d8c17`.

> **⚠ The `2.0.0` is not this project's.** The lead predicted `v1.17.0` and
> never checked for a `!`; an unrelated `feat(mind-mapper)!:` on the same train
> forced the major. **Two of its closed issues (`#77`, `#78`) are sprint 01's
> work**, fixed then and never closed. **Sprint 02 closed four.**

**[v2.1.0](https://github.com/ichabodcole/spellbook/releases/tag/spellbook-v2.1.0)
— sprint 03.** Cut 2026-08-08 from `88a298f`. Closes **`#73`** and **`#74`** —
the snapshot-rotation path, the project's first _durability_ family fix.

> **⚠ The changelog reads backwards, and the error is NOT the one it looks
> like.** The minor was driven by a single `feat(spellbook)` commit changing
> fifteen lines of warning prose across three `SKILL.md` files — which looks
> wrong and **is correct**: [`ward`](../../../.claude/skills/ward/SKILL.md)
> rules that spell content defaults to `feat`/minor, and "changed guidance" is
> named in it explicitly. Spell prose ships; a consumer really does receive it.
>
> **The actual inversion is the other half.** Sprint 03's genuinely additive API
> surface — `snapshotBackedUp` on `GET /state`, `valuesIgnored` on
> `add`/`update`, a new `"signal"` value in the `closed` frame's `reason` — all
> shipped as **`fix(bounty)`**. By `ward`'s own rule those are behavioral
> changes and belong under `feat`. So the "Features" section lists one warning
> line while three new fields a consumer can key on sit under "Bug Fixes."
>
> _First written here the wrong way round — blaming the doc commit — and
> corrected by running `ward` instead of reasoning from the changelog's shape.
> The rule was already written down; nobody consulted it._

### Issue ledger — measured 2026-08-08

> **⚠ THE PREVIOUS VERSION OF THIS SECTION SAID "SIX REMAIN" AND THEN LISTED
> NINE ISSUE NUMBERS**, against a `14` denominator that is a curated set and
> cannot be reconstructed from the tree. **A miscount, in the ledger, inside a
> project about miscounting — written 2026-08-08 and corrected the same day.**
> Replaced with a derivable population: every issue in `#64`–`#88` this project
> has touched, split by whether it predates the project.

> **⚠ CORRECTED AGAIN 2026-08-08 (thoth, sprint 04).** The version above
> replaced a curated `14` with the derivable range `#64`–`#88` — and then
> **listed `#11` inside it**, which is outside that range. The counts were RIGHT
> and the LIST violated its own stated population, so a reader who counts the
> entries gets 11 against a header saying 10 and concludes the arithmetic is
> broken. **It is not; the population statement was.** An exception that is not
> named is what made the first `14` unreconstructible, and naming it is the
> whole fix.

```
issues touched by this project:          22
  in range #64–#88:                      21   → 11 closed, 10 open
  outside it: #11 (pre-existing, cosmetic) 1   →  0 closed,  1 open
                                         ──
  total                                        11 closed, 11 open
```

**Closed (11):** `#67` `#68` `#69` `#73` `#74` `#77` `#78` `#80` `#81` `#83`
`#84`.

**Open (10):** `#64` has a **root-cause hypothesis but no reproduction** —
v2.1.0's `idleTimeout: 255` against Bun's 10s default explains "idle-died even
with a keep-alive tail", and it is **deliberately open** until anthill runs the
pre-registered measurement · `#79` `#82` `#85` `#86` `#88` are the **absence
family** and are [sprint 04](./sprints/04-the-shape-of-nothing/plan.md)'s scope
· `#87` is arguably that family and was left out so the ratify round has to
decide it · `#72` `#75` `#11` are features/cosmetic, not hardening · `#76` is a
real defect, unratified.

**⚠ THIS PROJECT HAS FILED MORE ISSUES THAN IT STARTED WITH — 12 against 9** —
and that is the method working, not failing. **The count is converging in SHAPE
rather than in size: 8 of the 10 still open are one family.**

**⚠ And the count still undercounts what we find.** Our own findings route to
[`docs/backlog/`](../../backlog/), never to issues (issues are inbound from
other teams). Sprint 03's P1d–P1f and both 2026-08-08 grapevine items are
invisible to the table above, exactly as sprint 02's P0f closed nothing.

## Other Documents

- [proposal.md](./proposal.md) — why, what, full scope inventory, phase ordering
- [artifacts/](./artifacts/) — working research
- [\_history/](./_history/) — superseded project documents
