# Bounty: caller-owned stable session key (deterministic board binding)

**Added:** 2026-07-09

Give a coordinating caller (anthill, or any multi-board consumer) a way to bind
every command to _its own_ board by a **key the caller chooses** — so board
resolution is deterministic _by construction_, never via the global `latest`
pointer and never requiring the caller to persist a random daemon-minted id that
can go stale. This is the design-level successor to the mitigations already
shipped in 1.15.1 (#59 pin precedence + `open --pin`, #62 noop-vs-error); those
made mis-routing _fail loud_, this removes the mis-route.

Tracks **#69**. Fork resolved in favor of the **caller-owned key** (over
per-project `latest` scoping or refuse-on-ambiguity as the primary mechanism) —
it's the only option that also closes the initial-resolution gap and makes
`open` idempotent, rather than leaving the caller to _discover_ rather than
_own_ its binding. (Per-project scoping still shows up below — as the collision
guard, not the primary handle.)

## The mechanism

- **`open --session-key <key>`** registers the board under a caller-chosen key.
  Every verb already accepts `--session <key>`; that stays the addressing form.
  Resolution precedence is unchanged: `--session` > `$BOUNTY_SESSION` >
  walked-up `.bounty-session` > (legacy unpinned) `latest`. `open --pin` writes
  the **key** into `.bounty-session` (today it writes the random `session_id`).
- **Idempotent open = liveness-gated attach.** `open --session-key K` looks up
  the registration for K: **live daemon → attach** (return its port/session,
  spawn nothing); **dead or absent → spawn + (re)register**. Re-using a key
  after the board died therefore _auto-recovers_ instead of resolving a dead
  board — the exact stale-id footgun #69 calls out, gone.
- **`open --session-key K --fresh`** tears down any existing board for K and
  starts clean — the escape hatch for a caller that reuses a channel-derived key
  across sessions but wants a new board (mirrors anthill's grapevine
  `open --fresh` at convene).

## The collision question (the part to get right)

Two failure shapes were flagged; both resolve cleanly once the key is
**project-scoped** — the registration's identity is `(repo-root/cwd-tree, key)`,
not the bare string:

- **Two concurrent callers, _different_ projects, same nominal key** → different
  scope → independent boards. No collision. (This is why scoping is the guard
  even though the key is the handle.)
- **Two concurrent callers, _same_ project, same key** → they attach to the
  _same_ board. This is **correct, not a hijack**: a caller-owned key is
  deterministic, so two things in one repo deriving the same key are — by the
  contract's own logic — asking to share (exactly what anthill wants: all seats
  bind one board via one key). Optional non-blocking safeguard: `open` stamps
  the registration with a caller-supplied owner `--label`, and a later attach
  whose label differs emits a **warning** (never a refusal) — surfaces an
  _accidental_ same-scope collision without breaking the intended-share case.
- **Single caller, same key twice (sequential)** → that's idempotent attach /
  `--fresh`, above. It's the feature, not a bug.

Net: the only genuinely ambiguous case (same scope, same key, distinct callers)
is defined _as_ an intended share, with a warning to catch accidents — no path
silently writes to a stranger's board.

## Acceptance Criteria

- [ ] `open --session-key K` registers under `(scope, K)`; a second `open` with
      the same key **attaches** to the live board (no new daemon) and
      **respawns** if the prior board is dead.
- [ ] All verbs bind to the board via `--session K` deterministically — never
      consulting `latest` when a key is given (closes the one-shot-verb + the
      initial-`tail` resolution gaps #69 names).
- [ ] Keys are project-scoped: same nominal key in two different repos → two
      independent boards.
- [ ] `--fresh` replaces the board for a key; same-scope-same-key concurrent
      attach shares (with optional `--label`-mismatch warning), never hijacks.
- [ ] `open --pin` persists the **key** (not a random id) to `.bounty-session`.
- [ ] Tests cover: idempotent attach, dead-board auto-recover, cross-project
      isolation, `--fresh` replace, same-key attach-not-hijack.
- [ ] `SKILL.md` documents `--session-key` + idempotent open; the anthill-side
      integration note (convene can own `open --session-key <team-channel>`) is
      linked back to #69 for the consumer.

## References

- `plugins/spellbook/skills/bounty/scripts/{server.ts,cli.ts}` — board
  resolution (`resolveSession`), `bounty-latest.json`, keyed registry lives here
- `plugins/spellbook/skills/bounty/SKILL.md` — pin precedence docs (#59)
- Issue: #69 (this) · shipped floor: #59, #62 · same area, distinct: #64
  (idle-die)
- Consumer: anthill `#23`/`#19` — convene would own
  `open --session-key <channel>`
