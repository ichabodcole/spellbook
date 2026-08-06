# Spell Hardening

**Status:** Active **Started:** 2026-08-05 **Current sprint:**
[02-success-shaped-lies](./sprints/02-success-shaped-lies/)

Fourteen reported defects across the shipped spells, all of one family: a
command that cannot do the thing returns something shaped like success. This
project closes them.

**The arc:** [proposal.md](./proposal.md)

## Sprints

| #   | Sprint                                                          | Status      | Opened     | Closed     | Outcome                                         | Decisions                                                  |
| --- | --------------------------------------------------------------- | ----------- | ---------- | ---------- | ----------------------------------------------- | ---------------------------------------------------------- |
| 01  | [drained-exit](./sprints/01-drained-exit/plan.md)               | Complete    | 2026-08-05 | 2026-08-06 | [outcome](./sprints/01-drained-exit/outcome.md) | —                                                          |
| 02  | [success-shaped-lies](./sprints/02-success-shaped-lies/plan.md) | **Active**  | 2026-08-06 | —          | —                                               | [decisions](./sprints/02-success-shaped-lies/decisions.md) |
| 03  | —                                                               | Not planned | —          | —          | —                                               | —                                                          |

**Status values:** Not planned | Active | Complete | Abandoned

Sprint 03 is listed because sprint 01 deferred work with names — see sprint 02's
plan for what it inherits and what it explicitly does not.

**Release:** **none cut yet — and the cut is Cole's.** Sprint 01 closed no
issues. **Sprint 02's CODE IS COMPLETE** (final gate
`1336 pass · 0 fail · 102 files` at `bbc61c2`, all four lanes landed and
cold-gated), **and 6 of the 14 issues become closable when the release is cut**
— `#77` `#78` `#80` `#81` `#83` `#84`.

> **⚠ Sprint 02 stays `Active` deliberately.** A sprint closes when its
> **outcome** is written, and **that cannot be honest until the release
> exists**: two of its four release beats — archiving closed backlog items, and
> commenting the issues — are **downstream of the cut**, not upstream.
> **`outcome.md` is OWED at close** and is the carry-forward artifact for
> sprint 03.

## Other Documents

- [proposal.md](./proposal.md) — why, what, full scope inventory, phase ordering
- [artifacts/](./artifacts/) — working research
- [\_history/](./_history/) — superseded project documents
