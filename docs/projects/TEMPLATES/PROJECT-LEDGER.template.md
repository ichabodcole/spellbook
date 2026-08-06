<!--
USAGE: Copy this file to a multi-sprint project folder as `README.md`.

Only multi-sprint projects need a ledger. A single-sprint project is just
proposal.md + plan.md at the root — don't create this until you promote.

THE ONE RULE: a ledger is an INDEX, not a document. It holds sprint names,
status, dates, and pointers. It holds NO mechanism, NO file references, NO
technical claims, NO design rationale.

That constraint is why it works. Nothing in this file depends on the state of
the code, so nothing in it can go stale. The moment you add "sprint 02 changes
the exit path in cli.ts", the ledger becomes a document that needs maintaining —
and an unmaintained index is worse than no index, because people trust it.

If you're tempted to explain something here, it belongs in proposal.md or in the
sprint's plan.md. Link to it instead.

Keep this file short. If it's over ~60 lines, something has crept in that
doesn't belong.

For more guidance, see the projects README: ../README.md
-->

# [Project Name]

**Status:** Active | Paused | Complete **Started:** YYYY-MM-DD **Current
sprint:** [NN-short-name](./sprints/NN-short-name/)

[One or two sentences: what this project is, in the plainest possible terms. Not
the approach, not the design — just enough that someone who lands here knows
whether they're in the right folder. The full arc is in the proposal.]

**The arc:** [proposal.md](./proposal.md)

## Sprints

| #   | Sprint                                            | Status      | Opened     | Closed     | Outcome                                         |
| --- | ------------------------------------------------- | ----------- | ---------- | ---------- | ----------------------------------------------- |
| 01  | [drained-exit](./sprints/01-drained-exit/plan.md) | Complete    | YYYY-MM-DD | YYYY-MM-DD | [outcome](./sprints/01-drained-exit/outcome.md) |
| 02  | [short-name](./sprints/02-short-name/plan.md)     | **Active**  | YYYY-MM-DD | —          | —                                               |
| 03  | —                                                 | Not planned | —          | —          | —                                               |

**Status values:** Not planned | Active | Complete | Abandoned

**Sprints are not planned ahead.** A row appears when the sprint is scoped, not
before. "Not planned" rows are optional — include one only if you already know a
further sprint is coming.

## Other Documents

- [proposal.md](./proposal.md) — why, what, full scope inventory, phase ordering
- [design-resolution.md](./design-resolution.md) — system-level decisions (if
  any)
- [sessions/](./sessions/) — dev journals across all sprints
- [artifacts/](./artifacts/) — working research
- [handoff.md](./handoff.md) — deployment steps (if any)

[Delete the lines that don't exist. A pointer to a missing file is the one way a
ledger can lie.]
