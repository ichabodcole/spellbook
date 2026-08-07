# Spell Hardening

**Status:** Active **Started:** 2026-08-05 **Current sprint:** **none — 02 is
closed, 03 is not planned**

Fourteen reported defects across the shipped spells, all of one family: a
command that cannot do the thing returns something shaped like success. This
project closes them.

**The arc:** [proposal.md](./proposal.md)

## Sprints

| #   | Sprint                                                          | Status      | Opened     | Closed     | Outcome                                                | Decisions                                                  |
| --- | --------------------------------------------------------------- | ----------- | ---------- | ---------- | ------------------------------------------------------ | ---------------------------------------------------------- |
| 01  | [drained-exit](./sprints/01-drained-exit/plan.md)               | Complete    | 2026-08-05 | 2026-08-06 | [outcome](./sprints/01-drained-exit/outcome.md)        | —                                                          |
| 02  | [success-shaped-lies](./sprints/02-success-shaped-lies/plan.md) | Complete    | 2026-08-06 | 2026-08-07 | [outcome](./sprints/02-success-shaped-lies/outcome.md) | [decisions](./sprints/02-success-shaped-lies/decisions.md) |
| 03  | —                                                               | Not planned | —          | —          | —                                                      | —                                                          |

**Status values:** Not planned | Active | Complete | Abandoned

Sprint 03 is listed because both prior sprints deferred work **with names** —
see [sprint 02's outcome](./sprints/02-success-shaped-lies/outcome.md),
"CARRY-FORWARD → sprint 03," for what it inherits and what it explicitly does
not.

**Release:
[spellbook v2.0.0](https://github.com/ichabodcole/spellbook/releases/tag/spellbook-v2.0.0)**
— cut 2026-08-06 from `a0d8c17`. **6 of the 14 issues are closed** — `#77` `#78`
`#80` `#81` `#83` `#84`. **Eight remain**: `#64` is genuinely unexplained, `#73`
`#74` `#79` `#72` `#76` are P1/P2/P3 and **all unratified**, `#82` is on hold,
and `#85`–`#88` sit with the CLI-contract investigation.

> **⚠ The `2.0.0` is not this project's.** The lead predicted `v1.17.0` and
> never checked for a `!`; an unrelated `feat(mind-mapper)!:` on the same train
> forced the major. **Two of the six closed issues (`#77`, `#78`) are sprint
> 01's work**, fixed then and never closed. **Sprint 02 closed four.**

## Other Documents

- [proposal.md](./proposal.md) — why, what, full scope inventory, phase ordering
- [artifacts/](./artifacts/) — working research
- [\_history/](./_history/) — superseded project documents
