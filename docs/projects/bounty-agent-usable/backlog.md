# Bounty migration — backlog

Non-blocking findings surfaced during review. Tracked here so they survive to
merge rather than riding in someone's head. Each notes its origin and a proposed
fix; none block the phase they were found in.

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

**#2 — `/cmd` ack is unconditional `{ok:true}` (LOW).** `handleAgentMsg` drops
the `apply*` booleans, so `/cmd` returns `ok` even when nothing applied
(`update`/`remove` on a missing id; duplicate-id `add`). #8's contract is
"confirm via `/state`," so it's not wrong — but returning `{ok, applied}` would
make `/cmd` self-confirming and save a follow-up `/state` round-trip.
_Proposed:_ thread the `apply*` boolean back through `handleAgentMsg` → the
`/cmd` response.

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
