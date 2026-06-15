# Bounty migration — backlog

Non-blocking findings surfaced during review. Tracked here so they survive to
merge rather than riding in someone's head. Each notes its origin and a proposed
fix; none block the phase they were found in.

## From the finalize-branch independent code review

Dual independent review (bugs/security + plan-alignment) cleared the branch
(both "Ready to merge"). Two doc gaps were fixed on-branch (the join-protocol
`task.update` inaccuracy + the verb exit-1 contract note). These two benign code
nits are deferred:

**R1 — `prevBlocked` keeps a stale entry for a deleted task (NIT).** When a task
is removed, its `prevBlocked` entry isn't deleted. Harmless (the reconcile loop
only walks `state.tasks`), but if a task id were ever recycled it could suppress
that id's first `unblocked`. Browser ids are 6 bytes of randomness (~1 in 10¹⁴),
so it can't bite in practice. _Proposed:_ `prevBlocked.delete(id)` in the remove
paths (agent + WS).

**R2 — non-numeric `?since=` on `/events` degrades to replay-all (NIT).**
`parseInt("abc")` → `NaN`, and `id > NaN` is always false, so a corrupt cursor
replays everything instead of erroring. The CLI always sends a numeric
`--since`, so it's never hit. _Proposed:_ clamp `NaN` → `-1` (replay-all is
already the intended "no cursor" behavior) or 400 on a non-numeric cursor.

(Also noted, not fixed: the `join.ts` "discovers via latest" test relies on the
shared `bounty-latest.json` pointer — theoretically flaky under _parallel_
daemon starts, but the suite runs sequentially and the test asserts the
session_id matches, so it fails loudly rather than false-passes. Low-risk; left
as-is.)

## From the fresh-agent fleet acceptance test (post-Phase D)

A lead + 2 cold worker agents drove a real coordination scenario with only the
SKILL. The experience delivered cold; these are the deferred polish items (the
high-value findings — scoped `state`, computed `liveBlockers`, the
test-isolation leak — were fixed on-branch).

**F1 — no one-shot `tail --drain` / `--once` (MED).** `tail --since N` streams
then blocks forever; the only documented non-blocking consume is wrapping it
with Monitor (push). An episodic agent (per-turn catch-up, like grapevine's
`pull`) has no clean primitive — it must background the tail + kill it (and
macOS has no `timeout`). _Proposed:_ `tail --drain` (or `--once`) that replays
from `--since` to the current cursor and exits 0. Completes the consume-mode
story (push = Monitor, episodic = drain).

**F2 — `sessions` has no filter / limit / recency (LOW).** `cli.ts sessions`
lists every snapshot under `$BOUNTY_HOME` with no cap — a haystack for
`--restore` once a few sessions accumulate. (The worst contributor, e2e tests
leaking into `~/.bounty`, is now fixed.) _Proposed:_ cap to the N most-recent by
mtime, or a `--limit`/`--since` filter.

## Tracked follow-up (does NOT block this branch's merge)

**W1 — the wordmark image still reads "Tuskboard" →
[ichabodcole/spellbook#11](https://github.com/ichabodcole/spellbook/issues/11).**
Surfaced in the surface-port browser verification:
`plugins/spellbook/skills/bounty/assets/wordmark.webp` visibly renders
**"Tuskboard"**. The earlier `grep -rni tuskboard` check passed only because
grep can't see inside a `.webp` — the alt text is "Bounty Board" but the pixels
say Tuskboard. This is the documented exception to the "No live 'Tuskboard'
string remains in the bounty spell surface/contract" success criterion. _Fix:_
regenerate the wordmark asset (image generation / magpie) reading "Bounty". Out
of scope for a faithful view-layer port. **cole chose to DEFER it to a separate
follow-up (#11); it no longer gates this branch's merge** — the criterion is met
modulo this one tracked asset.

## From the Phase A diff review (commit `27c6359`)

**#1 — `/cmd` trust boundary (MEDIUM) — DONE.** The daemon `/cmd` path cast
`body as AgentMsg` and dispatched unchecked, so `init` with a status-only task
or `task.add` with `{}` stored a blank card. Fixed by extracting the WS
narrowing into a shared `validateTask(unknown): Task | null` and calling it in
`handleAgentMsg` (init filters, task.add rejects) and the WS handler. Landed as
a Phase-A follow-up; Phase B restore reuses it (filter-and-keep-valid).

**#2 — `/cmd` ack is unconditional `{ok:true}` — DONE (Phase C).** Was: the
`/cmd` response dropped the `apply*` booleans, so it returned `ok` even when
nothing applied. Pulled forward in Phase C (the cooperative-claim guard needed a
visible rejection): `handleAgentMsg` now returns `{ok, applied?, error?}` for
**every** command and `/cmd` returns it. `cli.ts claim` surfaces a rejected
claim (stderr + non-zero exit); other verbs can inspect `applied` to
self-confirm without a follow-up `/state`.

**#3 — `events[]` is unbounded (NIT).** The daemon's event log grows for the
session's lifetime, and each tail reconnect replays `O(n)` buffered events. Fine
at board scale; a long, churny session could accumulate. _Proposed:_ cap to the
last N events (drop-oldest), keeping the monotonic `id` so `--since` still
resolves; replay from the cap when a reconnect's cursor predates it.

**#4 — `tail` retries forever on abnormal daemon death (NIT).** Normal teardown
emits a `closed` frame and `tail` exits 0. But if the daemon is SIGKILLed (no
`closed` frame), the session file vanishes and `tail` loops "no session yet"
until the Monitor times out. _Proposed:_ give up (exit non-zero) when the
session file **existed then vanished** mid-tail, distinguishing abnormal death
from a not-yet-started session.
