---
type: item
title: Small inconsistencies in the bounty and astrolabe refusal envelopes
description:
  Warm astrolabe refusals lack the choices cold ones carry; bounty's conflict
  envelope nests an ok:true server body; the tail grace overshoots by about 2.8
  s at the default.
status: draft
lifecycle: triage
id: 01a0e711-f00a-77cf-b43b-5b2e10d34c46
kind: bug
generated: { by: claude-opus-5-5, at: 2026-09-28 }
parent: feature/spell-hardening
cycle: 2026-09-reply-shape-leftovers
---

# Small inconsistencies in the bounty and astrolabe refusal envelopes

Found by the no-stake verifier of
[cycle/2026-09-one-act-one-answer](../cycles/2026-09-one-act-one-answer.md),
2026-09-28, on `a7c041d3`, under a scratch `HOME`; filed, not chased. Its
scripts were `t1.sh`–`t9.sh` in that session's scratchpad (not kept).

None of these is wrong on its exit code or `kind`. Each is a place where two
paths answer the same act differently.

- **Astrolabe warm vs cold:** with the daemon up, `status`, `remove`, `poke` and
  `attention` on an unknown id carry no `choices` or `hint`; the cold path (new
  this cycle) carries the registered ids. Warm `join` does carry them. A
  duplicate `add` has neither, warm or cold.
- **Bounty's conflict envelope nests
  `"server": {"ok": true, "applied": false, …}`** inside an `ok:false` envelope.
  `server` is the daemon's own body, verbatim, but `ok:true` inside a failure
  reads as a contradiction.
- **The tail grace overshoots.** The default 5000 ms grace exits at about 7.8 s;
  with `BOUNTY_TAIL_GRACE_MS=1500` it exits at about 1.8 s.
- **An env-key tail on a closed board retries forever**
  (`BOUNTY_SESSION_KEY=k2 bounty tail`; killed at about 120 s). This is the
  documented B1 behaviour, but the board has a close snapshot and will not come
  back on its own. It's worth deciding whether B1 should read the snapshot as
  the named path now does.

**From the second verifier (follow-ups, on `d3edb3ef`):**

- **A come-back command for a dash-leading key does not run.** For
  `tail --session-key=--weird`, the hint and the come-back name
  `open --session-key --weird --no-open`, which exits 2 as ambiguous; the
  runnable form is `--session-key=--weird`. `comeBackCmd()` quotes spaces and
  `'` correctly, but not a leading dash. This is a response that names an act it
  cannot perform, so it's the most worth fixing on this list.
- **The retry comments still say `# no session yet for …`** for a board that
  existed and closed. That is the same unproven "never existed" claim this cycle
  removed from the hint.
- **Two keys can derive one board id:** `"my key"` and `my-key` both become
  `k-my-key-…`.
- **The not_found hint says "it hashes the repo root"** even when the cwd is not
  in a repo.
