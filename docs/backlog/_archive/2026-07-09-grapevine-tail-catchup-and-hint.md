# Grapevine: bounded tail catch-up + uniform truncation hint

**Added:** 2026-07-09

Two small `tail`-path papercuts from anthill's multi-agent field use, batched
for a single fix-and-release pass. Both touch the tail event path; neither is a
correctness risk.

## #68 — bounded catch-up for a cold mid-session joiner (`priority: low`)

An agent that joins a live channel mid-session has no clean way to catch up: a
live `tail` only shows messages from subscribe forward; `--from-start` replays
the _whole_ log (unbounded on a long session); `--since <id>` needs a cursor the
joiner was never handed. The joiner's binding constraint is **volume**, not
recency — so the fix is a _count-based_ bounded backfill, not a time window.

Fix (cheap): `tail <channel> --last <n>` (and/or `pull <channel> --last <n>`) —
return the most recent `n` messages, then continue live. The daemon already
computes `latest_id` at subscribe (it's in the `subscribed` event and the "N
earlier exist" hint), so this is a `latest_id - n` slice — no new bookkeeping.
Composes naturally with the existing "N earlier message(s) exist" subscribe hint
(a dial against a number the joiner can already see).

## #67 — emit `truncation_hint` on _every_ truncated tail event (`bug`, `priority: low`)

A long tail event is truncated with `...(truncated)`, but only _some_ truncated
events carry the `truncation_hint` naming how to recover the full body
(`"+2557 chars — full: read <channel> <id>"`). Others truncate with no hint, so
the reader has to infer the id and `pull --since`/`read`. Inconsistent, not
missing — the hint already exists on the code path for some events. Make it
uniform: every truncated event carries the hint (or an equivalent
`read <channel> <id>` pointer).

## Acceptance Criteria

- [ ] `tail --last <n>` returns the most recent `n` messages then continues
      live; bounded (`n` messages, not `n` minutes, not body-length `--max`).
- [ ] Every truncated tail event carries a `truncation_hint` / `read` pointer —
      no truncated event ships without one.
- [ ] Tests: `--last` slice bounds (fewer-than-n available, n=0, live continues
      after backfill); hint present on every truncation path.

## References

- `plugins/spellbook/skills/grapevine/scripts/{cli.ts,daemon...}` — tail event
  path, `truncation_hint` producer, `latest_id`/`subscribed` event
- Issues: #68, #67 (both filed on behalf of anthill'"'"'s coordination use case)
