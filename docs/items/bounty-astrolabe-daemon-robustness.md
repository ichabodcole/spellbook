---
type: item
title: "Bounty and astrolabe: daemon timeouts, orphans, races and silent drops"
description:
  "The robustness half of spell-refusal-envelope-nits, split out 2026-10-17:
  unbounded daemon requests, orphaned daemons, open races, init --stdin-tasks
  dropping data quietly, and notices for overridden flags."
status: draft
lifecycle: backlog
id: 01a14bc3-07ba-7202-837c-bce36602d259
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-17 }
from: 01a0e711-f00a-77cf-b43b-5b2e10d34c46
---

# Bounty and astrolabe: daemon timeouts, orphans, races and silent drops

Split out of [spell-refusal-envelope-nits](spell-refusal-envelope-nits.md) on
2026-10-17 (Cole, at the project sweep), which keeps only the reply-shape fixes.
These are robustness findings from several no-stake verifiers. Each bullet keeps
the provenance it was filed with. None is tied to a release note, so this can go
into any cycle.

**One-act-one-answer verifier (2026-09-28, on `a7c041d3`):**

- **The tail grace overshoots.** The default 5000 ms grace exits at about 7.8 s;
  with `BOUNTY_TAIL_GRACE_MS=1500` it exits at about 1.8 s.
- **An env-key tail on a closed board retries forever**
  (`BOUNTY_SESSION_KEY=k2 bounty tail`; killed at about 120 s). This is the
  documented B1 behaviour, but the board has a close snapshot and will not come
  back on its own. It's worth deciding whether B1 should read the snapshot as
  the named path now does.

**Its second verifier (on `d3edb3ef`):**

- **Two keys can derive one board id:** `"my key"` and `my-key` both become
  `k-my-key-…`.

**Data-loss cycle's verifier (2026-09-28, on `516d0042`):**

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

**Data-loss cycle's second verifier (2026-09-28, on `af561632`):**

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

> **Resolved 2026-10-02** by
> [a restore keeps every task](../cycles/_archive/2026-10-a-restore-keeps-every-task.md)
> (point 4, `4c5aa186`): the lock loser now refuses the same way (exit 2,
> `restoreSkipped`) when it was given `--restore`, `--title` or `--timeout`. A
> no-stake verifier reproduced the race and saw the refusal.

**"A restore keeps every task" verifier (2026-10-02), on the shipped launcher:**

- **bounty `init --stdin-tasks` drops data and says `tasksDropped: null`.** A
  duplicate id keeps only the first task; `size: "XL"`, `expect: -1`, an unknown
  field and invalid `statusHistory` entries are stripped with no
  `valuesIgnored`. Repro:
  `echo '[{"id":"z","title":"A","status":"todo"},{"id":"z","title":"B","status":"todo"}]' | bounty init --session-key d2 --stdin-tasks`.
  The input report should name what it did not keep. `add --tag " m ,m,n"` is
  cleaned quietly too (smaller).
- **`open --fresh` without `--session-key` is accepted** (exit 0, an unkeyed
  board), though the usage line implies `--fresh` needs a key.
- **`open --restore <file> --session-key K --title X`** comes up with the
  snapshot's title, with no notice that `--title` was overridden.

## Definition of done

- [ ] Every bounty verb that talks to the daemon bounds its wait, as `open` and
      `close` do, and `join.ts`'s WebSocket connect is checked.
- [ ] A daemon that cannot write its discovery file exits instead of being left
      running (bounty and astrolabe).
- [ ] `init --stdin-tasks` names what it did not keep (duplicate ids, invalid
      values, unknown fields).
- [ ] `open --restore … --title X` says when the snapshot's title wins, and
      `open --fresh` without a key is either refused or documented.
- [ ] Each remaining bullet above is fixed, or ruled out with a reason in this
      file.
