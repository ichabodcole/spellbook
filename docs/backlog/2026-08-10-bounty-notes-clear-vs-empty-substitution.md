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
