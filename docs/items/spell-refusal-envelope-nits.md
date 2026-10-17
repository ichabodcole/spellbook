---
type: item
title: Small inconsistencies in the bounty and astrolabe refusal envelopes
description:
  Replies that say the wrong thing - a come-back command for a dash-leading key
  that does not run, warm astrolabe refusals without the choices cold ones
  carry, an ok:true nested in bounty's conflict envelope, retry comments that
  claim a board never existed, a repeated restoreDropped.
status: draft
lifecycle: triage
id: 01a0e711-f00a-77cf-b43b-5b2e10d34c46
kind: bug
generated: { by: claude-opus-5-5, at: 2026-09-28 }
cycle: 2026-09-reply-shape-leftovers
---

# Small inconsistencies in the bounty and astrolabe refusal envelopes

Found by the no-stake verifier of
[cycle/2026-09-one-act-one-answer](../cycles/_archive/2026-09-one-act-one-answer.md),
2026-09-28, on `a7c041d3`, under a scratch `HOME`; filed, not chased. Its
scripts were `t1.sh`–`t9.sh` in that session's scratchpad (not kept).

None of these is wrong on its exit code or `kind`. Each is a place where two
paths answer the same act differently.

**Re-scoped 2026-10-17** (Cole, at the project sweep). This item now holds only
the replies an agent reads that say the wrong thing, the
[reply-shape-leftovers](../cycles/2026-09-reply-shape-leftovers.md) cycle's
part. The robustness findings it had gathered moved, with their provenance, to
[bounty-astrolabe-daemon-robustness](bounty-astrolabe-daemon-robustness.md).
Scriptorium's missing-body-file code (2 to 5) needs no fix here: the kit path
already answers `not_found`, so it is fixed at the cutover.

**First verifier (one-act-one-answer, 2026-09-28, on `a7c041d3`):**

- **Astrolabe warm vs cold:** with the daemon up, `status`, `remove`, `poke` and
  `attention` on an unknown id carry no `choices` or `hint`; the cold path (new
  this cycle) carries the registered ids. Warm `join` does carry them. A
  duplicate `add` has neither, warm or cold.
- **Bounty's conflict envelope nests
  `"server": {"ok": true, "applied": false, …}`** inside an `ok:false` envelope.
  `server` is the daemon's own body, verbatim, but `ok:true` inside a failure
  reads as a contradiction.

**Second verifier (on `d3edb3ef`):**

- **A come-back command for a dash-leading key does not run.** For
  `tail --session-key=--weird`, the hint and the come-back name
  `open --session-key --weird --no-open`, which exits 2 as ambiguous; the
  runnable form is `--session-key=--weird`. `comeBackCmd()` quotes spaces and
  `'` correctly, but not a leading dash. This is a response that names an act it
  cannot perform, so it's the most worth fixing on this list.
- **The retry comments still say `# no session yet for …`** for a board that
  existed and closed. That is the same unproven "never existed" claim this cycle
  removed from the hint.
- **The not_found hint says "it hashes the repo root"** even when the cwd is not
  in a repo.

**"A restore keeps every task" verifier (2026-10-02):**

- **The attach refusal repeats the live board's `restoreDropped`**, as it
  already does `restoreFailed`: a fact about that board's boot, not this act.
  Decide both together.

## Definition of done

- [ ] A come-back command or hint for a dash-leading key runs as printed
      (`--session-key=--weird`).
- [ ] Astrolabe's warm `status`, `remove`, `poke` and `attention` on an unknown
      id carry the same `choices` as the cold path; a duplicate `add` says which
      id exists.
- [ ] Bounty's conflict envelope carries no `ok: true` inside `ok: false`.
- [ ] The retry comments and the not_found hint claim only what is known (no "no
      session yet" for a closed board, no "hashes the repo root" outside a
      repo).
- [ ] The attach refusal's `restoreDropped`/`restoreFailed` are decided
      together, and say whose boot they describe.
- [ ] The release note names each reply that changed.
