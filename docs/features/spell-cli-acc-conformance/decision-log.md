---
type: artifact
title: "Spell CLI acc conformance: decision log"
description:
  Decisions made while executing the acc-conformance cycle, each with the
  options not taken, kept live for Cole's review.
status: draft
generated: { by: claude-opus-5-5, at: 2026-09-26 }
---

# Decision log

Logged live while running the
[acc-conformance cycle](../../cycles/2026-09-acc-conformance.md). Cole delegated
execution on 2026-09-26 ("make calls as needed; note major decisions"). **⭐
marks one Cole should look at.**

| #   | date       | decision                                                                                                                                | option(s) not taken                                            | why                                                                                                        |
| --- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1   | 2026-09-26 | Items moved `triage` → `ready` by the lead, not at a triage session                                                                     | leave in triage until Cole returns                             | Cole delegated execution; the items were filed from a measured baseline minutes earlier                    |
| 2   | 2026-09-26 | One item per spell (steps 3–6 in its definition of done), plus a gate item and a shared-registry research item                          | one item per spell × step (≈60 items); one item for everything | per-spell keeps one owner per code area; per-step would cross-link endlessly                               |
| 3   | 2026-09-26 | `c1` (terminator-eats-session-key) moves from spell-hardening's planned cycle into this one                                             | leave it in spell-hardening                                    | acc's A6 is the same defect on the same parser; fixing it twice is waste. Its parent stays spell-hardening |
| 4   | 2026-09-26 | Execution by subagents (one implementer per item, a separate no-stake verifier), lead reviews and merges into `feature/acc-conformance` | anthill team; lead implements                                  | Cole's instruction                                                                                         |
