# Spell Hardening — Implementation Plan

**Created:** 2026-08-05 **Related Proposal:** [proposal.md](./proposal.md)
**Status:** Draft — awaiting the team's seam ratification (`anthill:plan`)

---

## Overview

Four phases against the shipped spells, ordered by harm and by one hard
dependency (P0 → P2). This plan is a **skeleton with claims**, not blanks to
fill: the file references below were verified during triage, but per the R12/R13
lesson, **a claim in a skeleton is a hypothesis until the owning seat confirms
it.** Falsify anything here that turns out wrong and say so.

**Execution:** the anthill team. `daedalus` owns the CLI/daemon work, `circe`
the board surface, `cassandra` cold-gates each phase, `prospero` leads and
lands. Run `anthill:plan` first so the owning seats ratify the seams they touch.

## Outcome & Success Criteria

Inherited from the proposal. **Definition of done for the project:** all ten
issues resolved-or-deferred-with-reason, gate green, cold-gate passed, release
cut, `SKILL.md` true.

**Non-goals:** feature work of any kind; mind-mapper; the primitive
investigations; a shared CLI library (P0 fixes a shape, it does not factor one).

## Approach Summary

**Harm-ordered, with one forced dependency.** P0 before P2 is not a preference —
a bounded dump that exits is the exact shape that loses its tail to the P0 bug,
so P2 before P0 would ship a new way to lose history.

Each phase ends at a **cold gate** (cassandra) before the next begins, because
three of these bugs are invisible to the person best positioned to notice them.

---

## Phase 0 — The drained exit (#77, #78)

**Owner:** daedalus · **Verify:** cassandra · **Blocks:** P2

The single highest-harm item. Payloads are complete; only the write is lost.

**The mechanism, already diagnosed — do not re-derive it.** Bun's stdout is
asynchronous on a pipe and synchronous on a TTY or file, so `process.exit`
discards whatever has not drained.

**Sites — verified 2026-08-05 (these three are facts, not claims):**

- `plugins/spellbook/skills/grapevine/scripts/cli.ts:351-353` — `printJson`
- `plugins/spellbook/skills/grapevine/scripts/cli.ts:1805-1807` — `main` →
  `process.exit(code)`
- `plugins/spellbook/skills/bounty/scripts/cli.ts:941-943` — identical shape

**⚠ The audit is wider than the two reported spells.** A first-pass
`grep -rln "process.exit(code)"` over `plugins/spellbook/skills/*/scripts/*.ts`
returns **seven files**:

| File                          | Status                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `grapevine/scripts/cli.ts`    | reported (#77)                                                                 |
| `bounty/scripts/cli.ts`       | reported (#78)                                                                 |
| `astrolabe/scripts/cli.ts`    | **unreported — same shape**                                                    |
| `glamour/scripts/cli.ts`      | **unreported — same shape**                                                    |
| `imago/scripts/cli.ts`        | **unreported — same shape**                                                    |
| `magpie/scripts/cli.ts`       | **unreported — same shape**                                                    |
| `grapevine/scripts/daemon.ts` | **unreported** — check whether a daemon's exit path can carry a payload at all |

**This grep is a starting point, not the audit.** It matches one literal
spelling, so it can miss variants (`process.exit(0)`, an exit inside a handler)
and it over-matches — a site only _bites_ if it can emit a >64KiB payload, which
a daemon or a short help path may never do. Confirm per site rather than
patching all seven blind. mind-mapper did not match this spelling and should be
checked separately (its CLI lives under `plugins/spellbook/skills/mind-mapper/`
with sources in `src/mind-mapper/`).

**Steps**

1. Fix the shape: await the drain, or drop the explicit `exit` and let the
   process end naturally. **Not pagination, not a `--complete` flag.**
2. **Audit the five unreported sites above** (plus mind-mapper and digestify,
   which the grep did not reach). For each, decide whether it can emit an
   over-buffer payload; fix the shape where it can, and record the ones you rule
   out and why — a silent skip is indistinguishable from a miss.
3. Regression test per spell: generate a >64KiB payload, read it **through a
   pipe**, parse it. A test that doesn't pipe cannot catch this bug.

**Reference control:** `anthill comms read` moves ~983KB through a pipe intact —
its success path returns naturally. That is the target behaviour.

**Gate:** `grapevine pull` and `bounty state --full` both return valid JSON with
`cursor` present, piped, on an over-buffer payload. Three consecutive runs (the
original bug was deterministic at exactly 65,536 bytes).

---

## Phase 1 — Daemon lifecycle and snapshot integrity (#64, #73, #74, nits)

**Owner:** daedalus · **Verify:** cassandra · **D1 ruled:** backup-then-write,
announce in the envelope, hydrate by default

**Order within the phase is forced:** #64 is the trigger, #73/#74 the
consequence. But do **not** block the guards on a complete #64 root-cause — the
clobber is a footgun on a healthy daemon too.

**Steps**

1. **Backup-then-write** (D1.1 — ruled). A snapshot write that would replace a
   non-empty snapshot with an empty/materially-smaller state **backs up first,
   then writes**. It does **not** refuse: a refusal adds a second failure to an
   already-degraded recovery path, and trains `--force` into the runbook.
2. **Rotation** — `<session>-<ts>.json`, keep N. Must still read an old
   single-slot snapshot (additive).
3. **Announce in the envelope** (D1.2 — ruled):
   `snapshotBackedUp: {path, taskCount, reason} | null`. **`null` when nothing
   happened, never absent** — a readable blank distinguishes "not needed" from
   "not reported." stderr prose does not count; the consumer is an agent parsing
   JSON.
4. **`open --session-key` hydrates by default** (D1.3 — ruled), announcing
   `hydrated: {from, taskCount} | null`, with `--fresh` to opt out. **Do not
   prompt** — a prompt in an agent path is a hang.
5. **#64 root cause — enumerate, don't guess.** The failure survived a
   keep-alive tail, so the "idle timeout" theory is incomplete. The existing
   backlog item says this explicitly.
6. **Fold in the robustness nits** (`2026-06-15-bounty-daemon-robustness-nits`):
   R1 `prevBlocked` stale entry; R2 non-numeric `?since=` replaying everything;
   #3 unbounded `events[]`; **#4 `tail` retries forever on abnormal daemon
   death** — #4 is the "fails silently" half of #64 and belongs here.
7. **Tail-death visibility:** a final `daemon exiting` event on the SSE stream
   so consumers can tell death from idle. Three agents' Monitors died silently
   alongside the daemon.

**Gate:** kill a daemon holding a populated board; respawn; `close`; confirm the
snapshot still holds the tasks. This is the exact sequence that destroyed data
twice — reproduce it on a **throwaway** board.

---

## Phase 2 — Bounded reads (#75 + bounty tail-drain twin)

**Owner:** daedalus · **Verify:** cassandra · **Depends on:** P0

Two spells, one missing primitive, surfaced independently. **Pick one flag name
and one semantic and ship both** rather than letting `--drain` and `--no-follow`
diverge into two spellings of one idea.

**Steps**

1. Name the flag (one decision, both spells).
2. `grapevine tail` — print the requested range (`--from-start` / `--since <id>`
   / `--last <n>`) and exit 0 without following.
3. `bounty tail` — the same verb and semantic (closes
   `2026-06-15-bounty-tail-drain`).
4. **Piping regression test** — this command's whole job is print-then-exit, so
   it is maximally exposed to the P0 shape.
5. Check whether `anthill:join`'s backfill step should be simplified upstream;
   file there, don't fix it here.

**Gate:** a cold agent backfills a >64KiB channel in one command and gets
complete, parseable history.

---

## Phase 3 — Legibility and honest signals (#79, #72, #11, #76, #40)

**Owners:** circe (surface) + daedalus (CLI/derivations) · **D2 ruled:** take
the big swing

**Steps**

1. **Define what counts as evidence** — the one open sub-question, and the only
   thing that must be settled before code. Candidates: commits by this owner
   while holding the card, board mutations, vine activity. Propose to the lead;
   this is not a licence to expand scope.
2. **Build the evidence-based poke** (#76 + #40 in one model). A `doing` card
   pokes when there is **no evidence of movement**, not when a timer elapses.
   **Blocked-ness is one evidence input, not a separate skip** — that is what
   unifies the two issues instead of layering a skip on a timer.
   - Touches `server.ts` (`computeDuePokes` ~L106-135, `cardOverdue` ~L145-152,
     `expectedMinutes` ~L97-101, `Task.blockedBy` ~L76) **and** the Alpine
     `cardOverdue` mirror in `template.html`.
   - `2026-06-22-bounty-heartbeat-skip-blocked` carries the approved
     blocked-predicate derivation (`blockedBy` ∩ not-done) — **reuse the
     predicate, drop its skip-shaped framing.**
   - ⚠ The `SKILL.md` line survives but **changes job**: under blocked-skip it
     was a prerequisite ("model waits as block edges or this does nothing");
     under evidence-based poking it is a hint. Do not carry the old wording over
     — it would overstate what the human must do.
3. **#79 `bounty list`** — either rename to `bounty boards`, or have the output
   name its own noun ("2 boards") so a plausible zero can't read as "your cards
   are missing." One or the other, not both.
4. **#72 size badge** — `S`/`M`/`L` chip on the card, `--expect` minutes on
   hover, plus an edit affordance so re-sizing isn't CLI-only. Note the size's
   role weakens once poking is evidence-based; it stays useful as a human
   planning signal, which is what #72 asked for.
5. **#11 wordmark** — the surface still renders "Tuskboard"; regenerate as
   Bounty.

**⚠ Surface-mirror discipline:** every `server.ts` derivation touched here has a
hand-written Alpine twin in `template.html` and **no test guards the drift.**
Change both in the same commit, and name both paths in the land.

**Gate:** a blocked card and a session-length card that are both **moving**
produce no pokes; a card with **no evidence of movement** still pokes regardless
of size; a card whose only blocker went `done` and which then goes quiet pokes
again. Note this gate is stated in evidence terms, not elapsed-time terms — if
it still reads as a timer, the model didn't change.

---

## Release

1. Conventional commits throughout (`fix(bounty)`, `fix(grapevine)`,
   `feat(bounty)`) — release-please owns versions, **no hand-edited version**.
2. Re-read both `SKILL.md` files against what actually shipped. Anything this
   project falsified must be corrected here; that is the in-scope slice of
   `2026-07-09-bounty-grapevine-skill-review`.
3. Cold-gate the assembled release (cassandra), not just the phases.
4. Cole cuts the release and pushes — **the agent does not push or release.**
5. Move every closed backlog item to `docs/backlog/_archive/`.
6. Comment the GitHub issues as they close.

## Open Questions

- ~~D1 and D2 need Cole.~~ **Both ruled 2026-08-05** (proposal). One
  sub-question survives: **what counts as "evidence"** for D2's poke — owning
  seat proposes, lead rules.
- ~~Does P0's audit find the shape beyond the two reported spells?~~ **Yes —
  seven files.** Now a question of which of the five unreported ones can
  actually emit an over-buffer payload.
- **Does an envelope field belong on other destructive verbs too?** D1.2 adds
  `snapshotBackedUp` to the snapshot path. If the reasoning holds (agents parse
  JSON; a readable `null` beats an absent key), the same shape may be owed
  elsewhere. Do **not** expand scope for it here — note what you find.
- Is #64's root cause reachable this session, or does it need its own
  investigation? If enumeration stalls, ship P1's guards anyway and split #64
  out rather than blocking the release on it.
- Does the bounty snapshot format change warrant a migration note for teams with
  live boards?
