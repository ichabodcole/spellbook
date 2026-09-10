# Phase 7 journal — mind-mapper, the source spell, last

**Branch:** `feat/mind-mapper-backend-port` · **Landed:** chapter 1 `5dc3fcc1`,
chapter 2 `67f3949a` · **2026-09-09**

**The last of the seven ports, the largest, and the only one where the kit was
the SOURCE rather than the destination.** 55 files / 16,306 lines out of
`plugins/spellbook/skills/mind-mapper/scripts/` into `src/mind-mapper/backend/`,
two launchers, two committed artifacts, six of eight kit modules adopted, one
kit RESTORATION, one forced wire rename.

---

## What shipped

| sha        | chapter                             | contract                                         |
| ---------- | ----------------------------------- | ------------------------------------------------ |
| `5dc3fcc1` | **1 · the relocation** (B1–B7, B10) | behaviour unchanged; nothing a caller sees moves |
| `67f3949a` | **2 · the adoption** (B8, B9, B10)  | behaviour changes, and each change is named      |

**No third chapter.** B0 budgets an instrument repair as a MAYBE with a commit
slot; the port broke no instrument it had to repair, and the two instrument
edits it did make (the `BUILTIN_EXACT` roster clause, the lifecycle ward's
deletion note) change no assertion and belong to the records rather than to a
chapter. The three hand-kept lists that reddened were re-declared inside chapter
1, which is B7's own instruction.

### Acceptance, measured

| box                                      | result                                                                                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| two artifacts built and committed        | ✅ `dist/cli.js`, `dist/server.js`, each in the same chapter as its source (Contract 18)                                                     |
| `bun scripts/dist-check.ts`              | ✅ **exit 0, all arms** — ARM 0/1 8/8 spells 40 tracked, ARM 1b 0 untracked, ARM 2 rebuild is a git no-op                                    |
| pairing ward, mind-mapper's row          | ✅ `derived=[cli, server] · cli.ts→dist/cli.js server.ts→dist/server.js · surface=[index-rjrfjxdy.js] backend=[cli.js, server.js]`           |
| spawn-path ward coverage                 | ✅ `dist/cli.js anchors=yes anchor-read=yes pins=6` · `dist/server.js pins=2` — the rows **switched on at the first backend emit** (see B4)  |
| `GET /cli.js` + `GET /server.js` refused | ✅ 200/208,579 and 200/549,791 at the end of chapter 1 → **404/21 bytes** after, artifacts proven on disk first                              |
| `tail.test.ts` green both sides          | ✅ 4 pass / 16 assertions / 1,249 ms before · 4 pass / 16 assertions / 1,250 ms after — ⚠ with ONE recorded fixture edit, D86                |
| acc, from the skill directory            | ✅ **CONFORMANT L0, exit 0, every count byte-identical to the baseline** (17 core / 16 passed / 0 failures / 1 core-unverified) — no regrade |
| every LOSSY-COPY property disposed       | ✅ two, with both numbers driven — RESTORE and KEEP-LOCAL (D85)                                                                              |
| gate green UNPIPED                       | ✅ `bun run gate > /tmp/g.log 2>&1; echo $?` → **0**; 2,019 pass / 0 fail / 6,181 assertions / 179.7 s                                       |
| daemons torn down                        | ✅ eight, each with its own home under the session scratchpad                                                                                |
| nothing in the repo root                 | ✅ `find . -maxdepth 1 -type d -empty` → nothing                                                                                             |

---

## The absences, said out loud

**Four things this port did NOT have, each spelled differently from a miss
(D56):**

1. ⛔ **NO `SKILL.md`, AND THAT IS COLE'S RULING, NOT DEBT.** `47238d7`:
   _"mind-mapper is unfinished, it is undeclared BECAUSE it is unfinished, and
   there is nothing to repair in the four listings, the trigger registry, or the
   missing `SKILL.md`."_ So: **the entry set is derived from `scripts/` alone,
   the exit-code table has no published home, and 39 caller-facing flags stay
   unwarded. The port does not write one.** ⚠ And read the pin, not the older
   note: `flag-invariant.test.ts:151-157` still frames the same fact as an
   undecided _"Cole's product call"_ (#989); `roster-drift.test.ts:32-38` is
   where the decision landed. **Two instruments, one fact, two vintages.**
2. ⛔ **`flag-invariant` IS GREEN OVER THIS SPELL FOR A REASON THAT HAS NOTHING
   TO DO WITH THE PORT**, and B7's promised loud half cannot fire. Its per-spell
   cell returns at `:179-187` when the SKILL.md is missing — before either arm —
   so the recognized-flag enumeration, the unresolved-entry-point assertion, the
   documented set and the two-sided diff are all below the `return`. The daemon
   HAS private flags (`--port`, `--host`, `--no-open`), so the consolation B7
   offers ("a daemon with no private flags would have moved in silence") does
   not apply. **`INTERNAL_ENTRY_POINTS` is hand-work here with no backstop at
   all**, its one key re-addressed by hand, and the green is not cover. The
   widening (point arm A at the CLI's `--help`) is a genuinely better ward and
   is D44's forbidden shape inside a port. **FILED.**
3. **`housekeeping`'s idle sweep and debounced snapshot have NO SUBJECT.**
   `server.ts:1685` — _"Standing until killed (SIGTERM/SIGINT) — no idle timeout
   in V1."_ Adopting `startHousekeeping` would mean writing a no-op `touch` and
   a `subscriberCount` that exists only to return zero: two lies to gain a
   `clearInterval`. Census **L1 likewise has no subject** — there is no idle
   sweep to kill a watching agent with.
4. **`gate-honesty`'s blind set is a NO-OP here.** `DECLARED_BLIND` holds
   CSS/HTML/`bunfig.toml`/`.py`; `.ts` is gateable, so a backend relocation adds
   nothing. Said because a port that leaves the box unticked is
   indistinguishable from one that forgot it.

**Hand-kept lists with ZERO rows or no subject:** none — every list in B7's
table had a mind-mapper row, which is the opposite of digestify's case and worth
recording as the other end of that range.

---

## The fifth verdict, worked

`sse.ts:9` and `eventLog.ts:7` both name this spell as their convergence target,
and it had adopted neither. **The mechanism was nobody's mistake and is
recorded:** D1 ruled the spine be proven on the two spells that already built,
and astrolabe and magpie are downstream FORKS of the mind-mapper line, so the
module boundaries were settled against two copies while the original was not in
the room. **A convergence can name its source and still never consult it.**

| property                                 | verdict / disposition                                                                                                                                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sse` cannot write a frame BEFORE replay | **LOSSY-COPY → RESTORE.** `openFrames?: () => string[]`, four executable lines. **(a) 0 source edits · (b) 0 wire bytes**, both driven before the change was proposed. Re-opens no census row. D85.                                        |
| `eventLog` demoted the epoch to optional | **LOSSY-COPY → KEEP-LOCAL.** One argument at the one construction site plus a re-tightening to REQUIRED in the spell's own frame type; **kit bytes zero**. Re-opens census **L6**, which stays CLOSED here and open for three others. D85. |
| `eventLog` dropped `ALL_EVENT_KINDS`     | ✅ **CONTRADICTED** — `createEventLog<T extends object>` is generic. **"The kit dropped X" is a loss only if the kit ever had a SUBJECT for X.**                                                                                           |

**The count, out loud:** _two properties of mind-mapper's own modules were
LOSSY-COPY at the kit — the pre-replay open frame and the mandatory epoch — one
is a driven RESTORATION and one is KEEP-LOCAL, and neither is filed._

⛔ **The number that mattered most is the one the artifact test gets
backwards.** D79's accidental demonstration was a COMMENT dirtying 11 artifacts
across 7 spells while changing nothing. ⚠ **11/7 is D79's PRE-WORK figure and is
correct only as history — re-measured after this port the same comment-only
probe dirties 13 artifacts across 7 spells** (mind-mapper's own `cli.js` and
`server.js` joined the population; `digestify` and `grapevine/dist/server.js`
remain outside it, which is the structural refusal still being observable as an
artifact that does not move). This restoration is the mirror: **code genuinely
moved** into five `dist/server.js` files (6 insertions / 3 deletions each; the
four real lines separated from the sourcemap by one `grep`) **and the wire did
not move at all.** Both directions of the same point, in one project.

---

## The wire-schema delta (D81's required output)

| field                 | old                           | new                          | forced?                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------- | ----------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| cursor                | `seq`                         | `id`                         | ⛔ **FORCED** — named in `Frame<T>` and in the emit literal                                                                                                                                                                                                                                                                                                                                                                                                                          |
| body                  | `{kind, payload}`             | unchanged                    | ✅ **NOT FORCED — DECLINED.** `Frame<T>` is generic; all five earlier adopters flatten by IDIOM                                                                                                                                                                                                                                                                                                                                                                                      |
| SSE keepalive comment | `: keepalive`                 | `: hb`                       | forced by `sse.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `.html` content type  | `text/html`                   | `text/html; charset=utf-8`   | forced by `serveDist.ts`'s map — the census's one divergent cell, resolved toward the correct copy                                                                                                                                                                                                                                                                                                                                                                                   |
| JSON **key order**    | `{seq, epoch, kind, payload}` | `{id, kind, payload, epoch}` | ⛔ **FORCED, AND OMITTED FROM THIS TABLE UNTIL THE VERIFY PASS.** `createEventLog`'s emit literal puts `id` first (so the monotonic cursor wins over a payload `id`) and appends `epoch` after the spread. **Inert for every JSON parser — and it is still a change to the bytes on the wire**, so it belongs in a wire-schema delta whether or not anything can observe it. A delta table that lists only fields ADDED, REMOVED or RENAMED is not a byte-level account of the wire. |

**Readers, with the counting rule** (comments stripped; word-boundary
`seq|epoch|payload|ServerEvent|BusEvent`; homonyms subtracted by reading every
matched line): **173 occurrences / 167 lines across 5 surface files** and **~209
occurrences / ~158 lines across ~30 backend files**, plus **every JSONL line
`tail` writes into an agent's pipe**, which is outside this repo's control.

**The half a field count misses:** the surface's reducer is a CURSOR CONSUMER —
`isGap(cursor, id)` plus **31** `cursor: event.id` assignments — so the rename
touches the **gap-detection contract**, not a property name.

**The homonyms, named so nobody thinks the sweep was partial.** 34 `seq` tokens
survive in the surface and ~20 in the backend, in three groups: the
`{payload, seq}` UI bump-counter idiom (23 sites — `focusRequest`,
`ComposerSeed`, `ScrollRequest`, `lookHere`, the agent-activity signal, and
every `lastSeq` ref that reads them); `WireMessage.seq` and the `messages`
table's own `seq` column (a message-ROW sequence, wire but **not** this
envelope); and comments describing either. **And the shapes the sweep does NOT
touch:** the grounding line and the synthesized `epoch.changed` carry no cursor
BY DESIGN, precisely so they never advance one.

⛔ **AND THE POPULATION D81 DID NOT COUNT: the WRITERS.** See D86 — the oracle's
own fake server writes the envelope while standing in for the daemon, and a
reader count cannot see it.

---

## What the playbook was still not enough for (amended in one pass; each marked `⭐ mind-mapper-port`)

Recorded at the moment each was hit.

1. ⛔ **B8's `tail.test.ts` ruling collides with B8's own wire-rename ruling**,
   and the collision is exactly one fixture function. **D86.** The playbook now
   says a wire-schema delta has WRITERS as well as readers, and names a fixture
   standing in for the renamed component as the likeliest miss.
2. ⛔ **A kit knob resolved in the seam file makes an in-process `process.env`
   assignment INERT — and D82 wrote that warning about the TAIL knobs while the
   defect was waiting at the BEAT knob.** `sse-keepalive.test.ts` set
   `MIND_MAPPER_KEEPALIVE_MS = "20"` in a `beforeEach` and saw ZERO beats, twice
   over: the constant is evaluated at module load in `heartbeat.ts`, and 20 ms
   is below the kit's 500 ms floor anyway. **The repair is the kit's own
   shape:** the daemon's `sseResponse` takes the beat as a PARAMETER defaulting
   to the seam file's value, because `kit/wire/sse.ts` takes `heartbeatMs` as a
   required option and reads no env at all. ⚠ And a sibling suite's premise was
   silently false in the same way: `presence.test.ts` asks for a 25 ms beat and
   gets 500.
3. ⛔ **B10's "read `git status` for churn in spells you never opened" needs a
   THIRD case.** It has "the kit was widened" and "it fit"; this port is "**code
   moved in five artifacts and no wire did**", which is the case the
   RESTORE/WIDENING discriminator exists for and which B10's two cases cannot
   express.
4. ⚠ **B6's triage table is the right instrument and its OUTPUT is a shared
   module, not a table.** At 32 files the table was worth writing before
   anything moved (three categories × 8 relevant files), and what it produced
   was `backend/paths.ts` — one repo-root marker walk, three named addresses
   (`CLI_LAUNCHER` / `SERVER_LAUNCHER` / `CLI_SOURCE`) and one derived dev cwd.
   B6 tells you to derive from an explicit root and never says the root belongs
   in a file of its own; at seven consumers it does.
5. ⚠ **B7's "green over your spell for an unrelated reason" row needs a second
   instance and it is in the ROSTER PROSE, not in a ward.** A stopgap's deletion
   condition read as an EVENT ("when the backends build") and was meant as a
   PROPERTY ("when these are true by construction"), and only one clause of
   three became true. **D87.**
6. ⚠ **B9's step 4 asks for a count and this spell's is the largest by an order
   of magnitude** — 60 raise sites, of which a `die(` grep finds ONE, and it is
   prose. The playbook's "grepping `die(` under-counts, measurably" is right and
   understated: here it under-counts to zero.

---

## B9's audit, reported

**60 raise sites** — 4 × `new CliError` + 56 × `throw usageError`. **No
exit→throw conversion**, because this CLI already threw with the kit's exact
taxonomy under a comment recording the reason (stdout truncation at 65,536
bytes), so **the audit finds no port-INTRODUCED swallow class.** Said out loud
rather than reported as a clean audit.

**Nine `catch` blocks, classified.** Three have no die-reachable call inside the
`try` (`livePort`'s liveness probe, `passOrThrow`'s body parse, `versionInfo`'s
`plugin.json` read — each swallowing deliberately, each degrading honestly).
`main`'s own catch PROPAGATES by converting to an exit code. And:

⚠ **FOUR CONDITIONALS, pre-existing and not silently fixed.** `propose-edge`,
`delete-batch`, `tags/actions --set` and `send` each call
`await passOrThrow(res)` **one to seven lines above a bare `catch {}`** that
parses an advisory warning off the response. Safe today. One refactor widening
either `try` over the `passOrThrow` line turns a typed 409 into a swallowed
parse and a printed `{"ok":true,…}` receipt at exit 0. **Four spells, four
conditionals, and every one of mind-mapper's four ends by printing a receipt** —
grapevine's exact shape at the most sites yet, which makes it stable enough to
look for on purpose.

**And the call graph leaves the spell.** `tailEvents`'s outer block is a
`try`/`finally` with **no `catch`**, so a `CliError` thrown from `onHttpError`
propagates into `main`. Read, then **driven**: a projectless store answers
`conflict`/6 with the daemon's body verbatim under `error.server`; an unknown
project, `not_found`/5.

---

## Census defects

| row | mind-mapper                                                                                                                      |
| --- | -------------------------------------------------------------------------------------------------------------------------------- |
| L1  | **NO SUBJECT** — no idle sweep, so no agent to kill with its connection open                                                     |
| L3  | **CLOSED** by `writeFileAtomic`; mind-mapper is the spell L3 NAMES as broken                                                     |
| L5  | **CLOSED** by `createEventLog`'s cap                                                                                             |
| L6  | **CLOSED, and already closed** — this is the spell L6's table names as CORRECT. Kept by passing `{ epoch }`, not by a kit change |
| L7  | **CLOSED** by `sse.ts`'s teardown funnel — which is this spell's own funnel, returned to it                                      |

Plus two the census did not number and the kit fixed anyway: a stale watermark
now **replays whole**, and a **non-finite cursor** means "from the start".

---

## The `idleMs` derivation, reported as an expression

`TAIL_IDLE_MS = intOr(process.env.MIND_MAPPER_TAIL_IDLE_MS, tailIdleMs(SSE_HEARTBEAT_MS))`
in `src/mind-mapper/backend/heartbeat.ts`, with
`SSE_HEARTBEAT_MS = heartbeatMs(process.env.MIND_MAPPER_KEEPALIVE_MS, IDLE_TIMEOUT_SEC, 15_000)`.

**The seam is REAL here** (question 3 = yes), and it was hand-mirrored before: a
literal 15,000 in the daemon, `idleTimeout: 255` a hundred lines away with the
relationship written only in prose, and a hard-coded 45,000 in the CLI under a
comment saying "≈ 3 missed server keepalives". **The "≈" is now an "=", and the
number did not change** — 45,000 at the default. Six env knobs across the pair
make this the spell D84 said would pay for D75, D76 and an eight-month-old
journal prediction all at once.

---

## Left open, routed rather than answered

- ⚠ **Whether the built artifact belongs in the published package while the
  spell is WIP.** Cole's `47238d7` ruling settled the declaredness question and
  explicitly left this one open; **this port ADDS two artifacts to that
  package.** Named here and routed to Cole (register D-section).
- ⚠ **The surface types the envelope's `payload` as `unknown`** where the kit's
  `Frame<T>` carries `Record<string, unknown>`, so the two disagree on that
  field even after the rename. Not touched: tightening it would make some
  existing narrowing casts illegal-looking and others unnecessary, which is a
  separate type change from a cursor rename.
