---
type: cycle
title: Scriptorium from real use, round three
description:
  "Three asks from Cole's 2026-10-01 sessions on 5.0.1: the version-new race
  (#117), Diff with one version (#116), and an End session button."
tags: [scriptorium, surfaces]
status: draft
lifecycle: planned
started: 2026-10-01
appetite:
  Stop when the three ship as a patch and a no-stake verifier has driven each in
  a real browser; anything that grows a design question is filed, not stretched.
after: []
generated: { by: pdocs, at: 2026-10-01 }
---

# Scriptorium from real use, round three

## Why now

All three come from Cole's own sessions on 5.0.1, on 2026-10-01: the signal this
project waits for before building UI. One (#117) is a race the 5.0.0 new-version
toast made likely, so it is ours to close.

## Scope

- **[item/scriptorium-activate-races-version-write](../items/scriptorium-activate-races-version-write.md)**
  (#117) — `version-new --body-file`/`--stdin`, and a truer safeguard message.
- **[item/scriptorium-diff-with-one-version](../items/scriptorium-diff-with-one-version.md)**
  (#116) — Diff disabled with one version, and an honest message on any other
  route in.
- **[item/scriptorium-end-session-button](../items/scriptorium-end-session-button.md)**
  — an End session control in the top bar; the daemon ends the session after a
  confirmation modal (Cole's ruling).

**Release:** a patch. `--body-file`/`--stdin` are new optional flags, and the
`closed` event gains a field; nothing a caller sees changes meaning.

## Decision log

Decisions as they are made, with the options not taken.

| #   | Date       | Decision                                                                                                                                                                                                                        | Options not taken                                                                                                                                                |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 2026-10-01 | #117 is fixed at the source: `version-new` takes the content, so no unwritten copy is ever offered; plus a truer safeguard message.                                                                                             | Toast only once the copy changes (hides the race, and a deliberate unchanged copy is a real use).                                                                |
| 2   | 2026-10-01 | **Cole's ruling on End session:** the daemon ends the session itself, and the agent learns from `closed` (marked as ended by the human). A confirmation modal in the browser guards against a stray click; no agent round trip. | The button asks the agent to close (never closes if the agent is gone); confirm through the agent (slower than typing); no confirmation (a stray click ends it). |

## Outcome

## Sessions
