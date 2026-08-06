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

Inherited from the proposal. **Definition of done for the project:** all twelve
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

## Phase 0 — The drained exit (#77, #78, #80.2)

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

   **⚠ The vacuity trap — the regression cell must be over 65,536 _by
   construction_.** A test that pipes a small payload and asserts completeness
   **passes in both worlds**, goes green for years, and is still green on the
   day it breaks: a 64KiB truncation of a sub-64KiB payload is indistinguishable
   from success. Put a positive control _inside_ the assertion —
   `expect(bytes).toBeGreaterThan(65_536)` before asserting the parse — so a
   fixture that silently shrinks fails loudly instead of passing vacuously.
   **Mutation-verify it**: restore the `process.exit`, confirm the new test
   fails **alone**, restore the fix.

**Reference control:** `anthill comms read` moves **2.78MB** through a pipe
intact — measured on the same machine, same Bun, in the same session where
`bounty state` truncated at 65,536 (reported 2026-08-06; supersedes the ~983KB
figure from #77). Its success path **returns naturally instead of calling
`process.exit`**. That is the target behaviour, and the reporter notes it is
accidental rather than designed on their side — worth saying out loud in both
repos so nobody later "tidies" a natural return into an explicit exit.

**The mechanism, isolated in a second runtime (reporter, 2026-08-06):**

```
write 300_000 bytes then process.exit(0)   →  pipe 65536    file 300000
write 300_000 bytes, natural return        →  pipe 300000   file 300000
```

One variable, both directions. This is the control the fix should reproduce.

**Gate:** `grapevine pull` and `bounty state --full` both return valid JSON with
`cursor` present, piped, on an over-buffer payload. Three consecutive runs (the
original bug was deterministic at exactly 65,536 bytes).

**#80 corroborates #78 from a second team** and sharpens the cost: the
truncation did not merely produce bad data, it produced a **false rule** — "our
board is too big to read" — which the reporter published and three agents then
worked under for six messages. Nothing to fix beyond #78; recorded because the
harm statement is better evidence than the original.

---

## Phase 0b — The inert `--restore` (#80.1)

**Owner:** daedalus · **Verify:** cassandra · **D3 ruled:** non-zero exit
**and** an envelope field

Separate lane from the drained exit: same phase and same defect class (a command
that cannot do the thing and returns something shaped like success), but a
completely different mechanism — control flow, not stdout draining. Do not merge
the two fixes into one commit.

**The mechanism, verified 2026-08-06 (fact, not claim):**
`plugins/spellbook/skills/bounty/scripts/cli.ts:388-397` — when `--session-key`
resolves to a board that is already live, `cmdOpen` takes the idempotent-attach
branch and **returns**. `--restore` is not appended to the daemon's args until
line 415, past that return. The flag is therefore never consulted on the attach
path, and nothing reports the skip.

**Not covered by D1.3.** Hydrate-by-default addresses the **dead**-daemon
respawn. The reported board was **live and empty**, so hydration never fires —
`--restore` was the only lever, and it was inert.

**Steps**

1. On the attach path, detect that `--restore` was passed and **cannot be
   honoured** (a live board already holds the key).
2. **Exit non-zero** (D3 — ruled), and name the corrective verb in the message:
   `--fresh --restore` tears the live board down and respawns from the snapshot.
   A refusal that points at an available fix does not need a `--force` invented
   for it.
3. **Announce in the envelope** (D1.2's convention, applied):
   `restoreSkipped: {requested, reason} | null` — **`null` when nothing was
   skipped, never absent.** The exit code is what a `set -e` wrapper or a
   Monitor catches; the field is what an agent parses.
4. **`SKILL.md` names the field and stops** (D1.4 — ruled). Two lines at most;
   do not restate the semantics.

**Real-board baseline — captured 2026-08-06 by the reporter, on the recovered
102-card board.** This is the pre-fix artifact the regression test gets written
against; our own repro is synthetic.

```
snapshot 102 · live deliberately diverged to 103
bounty open --session-key anthill-dev --restore k-anthill-dev-adad92ec
  EXIT ..... 0
  STDOUT ... {"url":…,"port":…,"session_id":"k-anthill-dev-adad92ec","title":"Bounty Board"}
  STDERR ... # attached to existing board k-anthill-dev-adad92ec (key "anthill-dev")
live AFTER . 103        (divergence survived)
```

**Nothing in stdout or stderr mentions `--restore` in any form** — not
performed, not skipped, not refused. That absence, plus the unreachable line
415, is what proves inertness. **The task-count delta does not**, per the gate
note below.

**⚠ The gate must read the SNAPSHOT count immediately before the restore call.**
Reading it at the top of the sequence produces a control that cannot come out
differently. Snapshots are **not** close-only: `server.ts:650-651` and `:1235`
mark the snapshot dirty on every board mutation and flush on a ~1s debounce —
verified on a throwaway board 2026-08-06 (card added, snapshot file absent at
t+0, present with the card at t+~1s). So a live board that has been diverged has
almost certainly diverged the snapshot too, and "live unchanged after restore"
is then consistent with both _inert_ and _restored the same contents_. Diverge
live **and** confirm the snapshot still differs at call time, or the gate proves
nothing.

_Recorded because both teams shipped this bug in one evening: the reporter's
first baseline compared 102 to 102, and the sequence this plan's author sent
them as its replacement asserted "live unchanged == restore was inert" — the
same degenerate control, written into the fix for it._

**Gate:** open a keyed board, seed it, kill the daemon's board contents so live
is empty while the snapshot is populated — **re-reading the snapshot at call
time to confirm the divergence is real** — then re-run
`open --session-key K --restore <id>` against the **live** board. It must exit
non-zero and carry `restoreSkipped`. Then confirm `--fresh --restore` on the
same key actually restores. Throwaway board only.

---

## Phase 0c — The unparsed `--flag=value` (#81)

**Owner:** daedalus · **Verify:** cassandra · **D4 ruled:** support `=` **and**
reject unknown flags

Third P0 lane, third mechanism. **This one is house-wide, not bounty-only** — it
is the widest-blast-radius item in the project and the only P0 item that
silently corrupts **writes**.

**The mechanism, verified 2026-08-06 (fact, not claim):** `parseArgs` splits on
whitespace only, so `--owner=forager` yields a flag literally named
`owner=forager` with value `true`, and `flags.owner` stays `undefined`.
Downstream, `typeof flags.owner === "string"` is false → `scope.owner` is
undefined → `cmdState`'s `if (scope.owner || scope.mine)` block never runs → the
unfiltered board prints, exit 0. `--mine` is unaffected only because it is
boolean and takes no value — that asymmetry is what disguised this as an
`--owner` defect in #80.

**Reproduced on a 5-task board** (no large or recovered board needed):

```
state --owner forager        → 3 tasks  ["forager"]                     correct
state --owner=forager        → 5 tasks  ["forager","maestro","None"]    whole board
state --owner=zzz-nobody-zzz → 5 tasks  ["forager","maestro","None"]    whole board, exit 0
add "x" --owner=maestro      → {"ok":true,"sent":"task.add"}            stored owner = NONE
add "y" --status=doing       → {"ok":true,"sent":"task.add"}            stored status = todo
state --totally-bogus-flag z → exit 0, stderr empty
```

**Blast radius — audited 2026-08-06:**

| Spell         | `=` handling                            |
| ------------- | --------------------------------------- |
| `bounty`      | **none**                                |
| `grapevine`   | **none**                                |
| `glamour`     | partial                                 |
| `imago`       | partial                                 |
| `magpie`      | partial                                 |
| `mind-mapper` | the only CLI that rejects unknown flags |

The two with no handling at all are the two most-used spells.

**Reference implementation — anthill's `define.ts` (offered on #80,
2026-08-06).** anthill landed this exact fix hours before we filed #81, for the
positional version of the same class: it splits on `=` at parse time
(`if (!arg.includes("=") && isValueFlag(...))`) and rejects unrecognized flags
at **parser altitude**, across 21 commands. Two lessons come with it, both paid
for:

- **Fix at parser altitude, not per-verb.** Their first attempt scoped the guard
  to one verb's `run()` and reached **1 of 13** leaves. Ours has the same shape
  — `parseArgs` is one function, but the _validation_ of what it produced is
  currently nowhere, and adding it verb-by-verb repeats their miss.
- **Positionals are what break.** Their first guard broke **seven tests**, and
  they now pin three controls where the first positional must keep working
  (`commit -- <paths>`, `comms send <body>`, `join <handle>`). Bounty is more
  exposed than anthill here, not less: `add` (`cli.ts:775`) and `message`
  (`cli.ts:895`) build their text with **`pos.join(" ")`** — free prose, and
  `message` is a verb agents use conversationally. There is no `--` terminator
  anywhere in the file. So `add write the --draft section` becomes a hard error
  the moment step 2 lands.

**Steps**

1. **Support `--key=value`** in `parseArgs` — split on the first `=` only, so
   values containing `=` survive.
2. **Reject unrecognized flags** (D4 — ruled): non-zero exit, the offending flag
   named in the message. **Copy `mind-mapper`'s existing implementation** rather
   than inventing a second convention; if it needs generalising, lift it to a
   shared shape and say so. Do it **once at parser altitude**, not per verb.
   Resolve the prose-positional collision above in the same change — a `--`
   terminator is the conventional answer, and `--stdin` already exists as the
   escape hatch for both affected verbs.
3. **Apply to every spell CLI, not just bounty and grapevine.** The partial
   handlers in glamour/imago/magpie must end up on the same semantics — three
   spellings of one idea is the failure mode the P2 flag-naming note warns
   about.
4. **Regression tests on three axes.** A read path (`state --owner=X` must not
   return out-of-scope tasks); a write path (`add --owner=X` must not silently
   drop the owner) — a read-only test would have missed the worse half; and a
   **positional-preservation** control per affected verb, since that is what
   broke in the reference implementation. Assert the read path with a **bogus
   value through the `=` form** (`--owner=zzz-nobody-zzz` → zero tasks), not a
   valid one: `--owner=forager` returning tasks is a control that cannot come
   out differently, and is precisely the paraphrase that hid this bug for a
   round.
5. **`SKILL.md` sweep:** any documented example using a spelling that now errors
   must be corrected in the same change.

**⚠ This is a deliberate behaviour change.** Step 2 makes previously-silent
callers start failing. That is the intent (D4), but it means P0c is the item
most likely to surface breakage elsewhere in the house.

**anthill's caller audit — answered 2026-08-06, and it clears.** Its complete
invocation set is four calls (`bounty state`, `bounty sessions`,
`bounty open --session-key … --pin --no-open`, `grapevine who <channel>`), all
space-separated, with no `=` anywhere in code or in shipped prose — and it calls
neither `add` nor `message`, so the `--` terminator work breaks nothing on their
side. Their channel name, the one agent-controlled value they pass us, is
validated against `[A-Za-z0-9._-]` and so cannot be re-read as a flag.

**The residual argues _for_ P0c.** Their prose teaches the space form
everywhere, but nothing stops an agent improvising `--status=doing` — agents
adapt shipped examples constantly, which is what examples are for. Today that
silently no-ops and reports `ok:true`. **The check is still ours to run for
every other caller**, but the largest external consumer is clear.

**Field corroboration (weak, and recorded as weak).** The reporter audited their
102-card board for the write-corruption half: of cards whose titles name a seat,
19 have an owner, **5 are unowned**, 0 mismatched. They explicitly decline to
attribute those 5 to `--owner=` — the `add` calls were hand-typed in agent panes
and `grep` for `--owner=` across their tree finds nothing. Treat this as
pattern- consistent, not as a confirmed instance. The reproduction is the
evidence; this is not.

**Gate:** for each spell CLI, a `--key=value` flag is honoured identically to
its space-separated form, and an unknown flag exits non-zero naming the flag.
Plus the write-path assertion: `add --owner=<name>` stores the owner. Plus: no
verb that takes free-prose positionals regressed.

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
6. **`state` should report the scope it applied** (added 2026-08-06 from the
   anthill vine — small, and the same defect class as the rest of P0). `--mine`
   means _own **plus claimable**_ (`cli.ts:241`), which is intended and is
   documented at `SKILL.md:391`. `cli.ts:521` even announces it per call —
   `# scoped to --mine (owner=X + claimable)` — **but it writes that to stderr,
   and every consumer of `state` reads stdout through a pipe.** A second team
   read `--mine` returning 62 rows as a filtering bug and came within a message
   of filing it next to #81. Put the scope in the payload it describes, beside
   `cursor`: `scope: {mine, owner, as, includesClaimable}`. **No semantic
   change** — `--mine` keeps meaning mine-plus-claimable. This is the same rule
   as D1.2 applied to a read: _a disclosure on a channel the consumer does not
   read is not a disclosure._
7. **`bounty sessions` emits prose, not JSON** — alone among the read verbs
   (`k-anthill-dev-adad92ec  102 tasks  — anthill-dev — session 12`). Every
   other read returns an envelope, so a caller that reasonably assumes JSON gets
   a parse error from the one verb used **during recovery**, when they are
   already worried the data is gone. Same family as #79: the tool answering in a
   shape the caller did not ask for. Give it the standard envelope; keep a human
   rendering behind `--human` if it is worth keeping at all.

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
- ~~D3 (#80: does a skipped `--restore` exit non-zero?) needs Cole.~~ **Ruled
  2026-08-06** — non-zero exit **and** the envelope field. P0b is unblocked.
- ~~#80's `--owner` sub-claim is unreproduced.~~ **Resolved 2026-08-06 — it was
  real, and it was not the truncation.** The reporter's measurement was
  **unpiped** against a whole 122KB payload, with a discriminating control: a
  **nonexistent** owner also returned the full board, which a
  working-but-permissive filter cannot produce. Root cause is `parseArgs` not
  handling `--key=value` → **#81**, now P0c. The earlier "symptom of #78" theory
  was wrong, and the scratch board failed to reproduce it for one reason:
  **every check used the space-separated form.** _Lesson for the remaining
  phases — reproduce the reporter's exact spelling, not a reasonable paraphrase
  of it._ The reporter's generalisation, which is the better statement and is
  adopted here: **a paraphrase of the input is a control that cannot come out
  differently, because it removes the variable under test while still looking
  like the same test.** Applies to every gate in this plan, not just repro —
  before accepting a gate as passed, ask what result would have failed it.
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
