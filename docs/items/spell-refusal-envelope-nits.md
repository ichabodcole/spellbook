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

**From the data-loss cycle's verifier (2026-09-28, on `516d0042`):**

- **bounty:** a plain `open` racing `--fresh` or `close` can exit 0 as
  "attached" to a board that is torn down a moment later. It never makes two
  daemons.
- **astrolabe:** `close` is a success but shows no `# warning:` while a registry
  is set aside. Cold `list`/`state` return `projects: []` without reading the
  disk registry (older than the cycle).
- **bounty:** only `open` and `close` bound their requests to the daemon (2 s,
  `DAEMON_ANSWER_TIMEOUT_MS`). `add`, `update`, `claim`, `block`/`unblock`,
  `remove`, `message`, `init` and `state` still wait forever on a stopped
  daemon, and `join.ts`'s WebSocket connect is unchecked.

**From the data-loss cycle's second verifier (2026-09-28, on `af561632`):**

- **bounty `open --fresh`,** when nothing is writable, attaches to the old board
  and exits 0, so the caller doesn't get a fresh board.
- **bounty `open` on a stopped daemon** says "failed to start within 5s" after
  about 8 s.
- **A daemon that can't write its discovery file is left running** (bounty with
  no `TMPDIR` folder; astrolabe with a read-only home and a readable registry,
  one orphan per attempt).
- **astrolabe directory wording:** "move its contents out and retry" still fails
  with EISDIR while the empty directory remains. An emptied set-aside directory
  keeps the notice until it's deleted.

**From the 5.0.0 CI flake diagnosis (2026-09-29):** parallel
`open --session-key K --timeout T` calls get different exit codes depending on
timing. One that arrives after the board is live refuses with exit 2, as #80.1
intends. One that arrives early spawns its own daemon, loses the lock, and
attaches with exit 0, silently dropping its own `--timeout`, `--title` or
`--restore`: the attach-and-discard #80.1 forbids. There are two ways to fix it,
and either changes a ruled contract:

- the lock loser refuses the same way;
- refuse only when the requested value differs from the running board's, which
  needs the daemon to report its timeout.

The CI test was fixed to stop passing `--timeout` (a test artefact).

**From "Scriptorium from real use, round three" (2026-10-01):** scriptorium's
`say`, `task`, `note` and `note-edit` report a missing `--body-file` as `usage`
(exit 2), while grapevine, and now scriptorium's own `version-new`, report it as
`not_found` (exit 5). The shared reader (`readProse`) can already answer 5; the
three verbs were held at 2 only because that cycle shipped as a patch. Aligning
them changes a caller-visible exit code, so it goes in a breaking-changes note.

> **Resolved 2026-10-02** by
> [a restore keeps every task](../cycles/2026-10-a-restore-keeps-every-task.md)
> (point 4, `4c5aa186`): the lock loser now refuses the same way (exit 2,
> `restoreSkipped`) when it was given `--restore`, `--title` or `--timeout`. A
> no-stake verifier reproduced the race and saw the refusal.

**From "A restore keeps every task" (2026-10-02), its no-stake verifier on the
shipped launcher:**

- **bounty `init --stdin-tasks` drops data and says `tasksDropped: null`.** A
  duplicate id keeps only the first task; `size: "XL"`, `expect: -1`, an unknown
  field and invalid `statusHistory` entries are stripped with no
  `valuesIgnored`. Repro:
  `echo '[{"id":"z","title":"A","status":"todo"},{"id":"z","title":"B","status":"todo"}]' | bounty init --session-key d2 --stdin-tasks`.
  The input report should name what it did not keep. `add --tag " m ,m,n"` is
  cleaned quietly too (smaller).
- **The attach refusal repeats the live board's `restoreDropped`**, as it
  already does `restoreFailed`: a fact about that board's boot, not this act.
  Decide both together.
- **`open --fresh` without `--session-key` is accepted** (exit 0, an unkeyed
  board), though the usage line implies `--fresh` needs a key.
- **`open --restore <file> --session-key K --title X`** comes up with the
  snapshot's title, with no notice that `--title` was overridden.
