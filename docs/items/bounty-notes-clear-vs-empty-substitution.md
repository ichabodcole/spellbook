---
type: item
title:
  '`bounty update --notes ""` cannot tell a deliberate clear from a substitution
  that produced nothing'
status: stable
description:
  Clarify and fix semantics of clear versus empty substitution in bounty notes
lifecycle: review
id: 019feeaa-e8f1-7900-b3f9-8be01f026ccf
kind: task
generated: { by: unknown, at: 2026-08-10 }
cycle: 2026-09-filed-is-not-fixed
parent: feature/spell-hardening
---

# `bounty update --notes ""` cannot tell a deliberate clear from a substitution that produced nothing

**Filed:** 2026-08-10 · **Status:** open, unsized · **Board card:** `s5-5` ·
**Scope ruling:** OUT of sprint 05 — a fix, not a gate

> ⚠ **RELAY — this finding is not mine.** Written up by `circe` at the lead's
> request so it survives the session; **every measurement below is TAKEN ON
> REPORT** from the seats named. Nothing here was re-run by the author.
> Attributions are per-claim rather than per-document, because the claims came
> from four seats and were corrected twice.

## The defect

**TAKEN ON REPORT (prospero, found 2026-08-08 by committing it; independently
reproduced by cassandra on an isolated board, 2,760 characters destroyed):**

`bounty update --notes ""` cannot distinguish **a deliberate clear** from **a
command substitution that produced nothing**. Both are the empty string by the
time the CLI sees them; both destroy the existing notes; both answer
`{"ok":true}`.

Unlike the `b7` and `b15` restore defects, **the damage is immediate rather than
latent.**

## The framing that makes it cheap to justify

**TAKEN ON REPORT (cassandra):** bounty **already warns on a board-level
destructive write and is silent on a card-level one.** The protective instinct
exists in the codebase; it was scoped to the board and never extended to the
card.

That is not a missing feature, it is an **inconsistent** one — a stronger
argument for repair and a much cheaper one to make.

## The honesty field that was present and did not cover it

**TAKEN ON REPORT (prospero):** `valuesIgnored: null` was on the wire
throughout. Its domain is _bad flag values_; a well-formed empty string is not
in it. Recorded at the time as the fifth instance in one sprint of a correct
honesty field that does not cover the case in front of it.

## What this file deliberately does not do

The card carries three candidate fixes (refuse an empty value without an
explicit `--clear`; report `notesReplaced: {previousLength, newLength}`; both).
**They are not reproduced here as a recommendation.** The remedy goes through a
design pass, and the one constraint worth carrying forward is a comparison
rather than a choice: whichever shape is picked should match the **existing
board-level warning**, so the two stop disagreeing.

## The authoring hazard attached to this card is a separate, larger thing

The card accumulated a long sub-thread about how the loss actually happened, and
it was **wrong twice before it was right** — first blamed on shell backtick
execution (falsified: the payload was single-quoted, and prospero measured that
the real primary cause was a **JS template literal** terminated early by
backticked identifiers in its content), then on a pre-flight file check
(falsified by daedalus: a file-existence test catches none of the ways a payload
goes empty).

**The surviving rule is one sentence and it is not about quoting:**

> After a destructive-capable write, **read the record back and assert on its
> content.** A pre-flight check tests what you are about to send; only a
> read-back tests what the system now holds.

That has since been promoted into `.anthill/principles.md` (with a further
amendment — normalise whitespace, or prefer byte-equality against the source you
still hold) and is **not** part of this backlog item. It is noted here only so a
reader of the card does not mistake the quoting sub-thread for the defect.

## Related

`docs/backlog/2026-08-08-cli-empty-vs-failed-read.md` — the same
empty-versus-failed ambiguity at the read path rather than the write path.

## Fixed (2026-09-27)

Commit `97909819` on `fix/bounty-update-empty-and-stdin`, fixed together with
`s5-9`, per the cycle's ruling (refuse, not warn):

- `update --notes ""` (and `--notes=`, and a dead `$(…)`) is **refused** at exit
  2 (`usage`), with the recovery in the message: _"to clear notes on purpose,
  pass --clear-notes"_. The notes are untouched.
- New boolean **`--clear-notes`** clears the notes; `--clear-notes` together
  with `--notes` is refused.
- `update --title ""` is refused too (the re-measure's "wider than filed"), as
  `add` refuses an empty title.
- The success envelope names the fields it wrote (`fields`), so a clear reads
  back as `"fields":["notes"]`.

**Pinned by** `src/bounty/backend/server.test.ts`, "update refuses empty values
and --stdin with --title; --clear-notes clears; fields named (s5-9, s5-5)", and
by golden cases for each refusal.

**What's left:**

- The board surface still clears notes with an empty string, on purpose: the
  detail dialog sends `task.edit` with `notes: ""` over the WebSocket
  (`useBoard.ts` `editNotes`; `server.ts` allows it). That is a human's explicit
  edit, not a CLI flag, and is unaffected. No test or caller sends empty notes
  through the CLI (`server.test.ts` only sends non-empty `--notes`).
- Reporting prior values (`notesReplaced`) stays deferred, as ruled. The
  board-level warning this file asked to match is a warning; this repair refuses
  instead, so the two still differ in kind.
