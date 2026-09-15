# Phase 7 pre-work — Phase B was written for spells the kit was AHEAD of, and mind-mapper is the spell it was COPIED FROM

**Measured 2026-09-09, before writing mind-mapper's brief. No spell was
ported.**

## Why a new document rather than an append to `phase-6-prework.md`

That doc is grapevine's pre-work; its subject is a phase whose only refusal was
an ABSENCE meeting a spell whose modules are PRESENT and unrepresentable, and
its findings are grapevine's (D68–D70). This one's subject is a phase whose five
verdicts all assume the kit is the destination, meeting **the one spell two of
the kit's modules were converged toward by name** — so the direction of the
whole of B8 reverses. Its port is mind-mapper's, the last of the seven and the
largest.

Two ports, two subjects, two documents — the same reasoning `phase-6-prework.md`
gives for not appending to `phase-5-prework.md`, and `phase-5-prework.md` gives
for not appending to `phase-4-prework.md`. Appending would bury a fifth verdict
inside grapevine's account and imply this work was grapevine's.

## The finding

An independent cold read of Phase B, taken as mind-mapper's porting agent,
reported seven items. **All seven were measured against the tree. Four are
confirmed, two are confirmed with the mechanism corrected, and one is
contradicted outright** — plus three things neither the report nor the playbook
mentions, one of which is the largest of them.

**mind-mapper's shape:** two caller-facing entries, `cli.ts` + `server.ts`. **55
files, 16,306 lines** in `plugins/spellbook/skills/mind-mapper/scripts/` — 23
non-test modules (7,234 lines) and **32 test files (9,072 lines)**. An
`acc.config.json` at the skill root. **No SKILL.md** — the only spell in the
roster without one. And it is the **named convergence source** of `sse.ts`
("target #1") and `eventLog.ts` ("target #2").

---

## 1 · The four steps that dispatch on a file that does not exist — CONFIRMED, and the asymmetry is the point

Phase B reads a SKILL.md at **eight sites**, not four: :974, :1143, :1687,
:1717, :1807, :2148, :2184/:2189, :2465. Every one is indicative. There is no
"if the spell has no SKILL.md" clause anywhere in the 3,052-line document.

**The other missing-artifact case has one**, added the moment imago hit it
(:1040-1049, :2467-2470, D37): _"there is nothing to run, nothing to regrade,
and you do not acquire one as part of the port. Do not stop, and do not write
one."_ ⚠ **And mind-mapper is not eligible for it** — :1041 names mind-mapper as
one of the four spells that HAVE an acc config, so the hatch that exists is the
wrong one and acc stays live for this port.

**The hatch is now written, in the same words and for a stronger reason** (D80).
⛔ **And the reason is not "it is Cole's call" — it is that COLE HAS ALREADY
MADE IT.** `grimoire/roster-drift.test.ts:32-38`: the pin originally read as
debt awaiting repair, and **Cole ruled the undeclared state INTENTIONAL AND
CORRECT** (`47238d7`) — _"mind-mapper is unfinished, it is undeclared BECAUSE it
is unfinished, and there is nothing to repair in the four listings, the trigger
registry, or the missing `SKILL.md`."_ A port that writes one **reverses a
standing ruling**.

⚠ **Two instruments carry the same fact at two vintages.**
`flag-invariant.test.ts:151-157` still frames it as an undecided _"Cole's
product call"_ (#989) because that comment predates the ruling; `roster-drift`
is where the decision landed. **The newer one is the ruling.** ⚠ And what that
ruling leaves OPEN is live for this port and must be routed rather than
answered: whether the built artifact belongs in the published package while the
spell is WIP — **this port adds artifacts to that package.**

### And the loud instrument B7 promises cannot fire here — CONFIRMED, with one correction

`flag-invariant.test.ts:179-187` returns from the per-spell cell **before either
arm runs** when the SKILL.md is missing. The recognized-flag enumeration, the
unresolved-entry-point assertion, the documented set and the two-sided diff are
all below the `return`. The cell passes for a stated reason — an honest repair,
recorded at :135-149 — but it passes over zero checking, across mind-mapper's
**39 caller-facing flags, more than any checked spell**.

The daemon does have private flags, so B7's "a daemon with no private flags
would have moved in silence" does not save it: `--port`, `--host`, `--no-open`
(`server.ts:448-457`).

⚠ **Correction to the report: `--project` is NOT one of them.** `server.ts:500`
reads `project` only as an HTTP query param; `--project` is caller-facing on ~28
CLI verbs (`cli.ts:374-404`). The finding survives; the flag list does not.

**So B7 gains a row it has never needed:** an instrument that is green over your
spell **for a reason unrelated to your port** — not a zero-row list, not a stale
expectation, but a ward with a subject, a pin and no reach.

---

## 2 · "All of `src/kit/wire/`" is wrong for six of eight rows — CONFIRMED, and the six are wrong in one direction

B8's eight-row table is labelled "Measured for digestify", but it is the only
per-row guidance a porting agent has. Scored as _would an agent following it
verbatim reach the wrong verdict for mind-mapper_:

| kit module                    | B8 says                            | mind-mapper's true verdict                                                                | right? |
| ----------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------- | ------ |
| `serveDist`                   | PARTIAL, read the caveats          | PARTIAL + **RECEIVED** (the whitelist, and a `charset=utf-8` header delta)                | ✅     |
| `heartbeat`                   | PARTIAL, "the seam does not exist" | **GAINED**, and the seam **does** exist — `cli.ts` + `server.ts`                          | ❌     |
| `housekeeping` idle/snapshot  | has a subject                      | **NO SUBJECT** — `server.ts:1685`, "no idle timeout in V1"                                | ❌     |
| `housekeeping` `drainAndStop` | no subject                         | **DE-DUPLICATED** — `server.ts:1700`, `stopMs` 200, grapevine's D73 shape exactly         | ❌     |
| `errors`                      | a documented caller contract       | **DE-DUPLICATED**, and the kit is WEAKER at the catch                                     | ✅     |
| `eventLog`                    | "NO SUBJECT. No `events` array."   | **the module's convergence SOURCE** — adoption is a wire rename + an epoch demotion       | ❌     |
| `sse`                         | "NO SUBJECT. No stream anywhere."  | **the module's convergence SOURCE** — REJECT-STRUCTURAL on the grounding frame            | ❌     |
| `tailEvents`                  | "NO SUBJECT. Nothing tails it."    | **GAINED** — and mind-mapper is the spell the kit's own constant-backoff warning is about | ❌     |
| `discovery`                   | "NO SUBJECT"                       | **GAINED** — `server.ts:1675-1676` is census **L3, mind-mapper named as BROKEN**          | ❌     |

**Six of eight wrong**, and the failure is systematic rather than incidental:
**five of the six say "NO SUBJECT" about a spell that is the SOURCE of two of
the eight modules.** An agent following the table would skip `eventLog`, `sse`,
`tailEvents` and `discovery` as absent, adopt an idle sweep into a daemon that
has none, and decline to build the `heartbeat.ts` seam B8 calls "the cleanest
proof the port worked".

### Two corrections to the report, both of which make the row-by-row cheaper

- **`errors` is NOT a byte-exact de-duplication.** The wire is identical — same
  keys, same order, same `ErrKind` union character-for-character, same `2/1/5/6`
  — but the source diverges (`usageError` constructs where `die` throws;
  `readonly kind` + `extra` vs flattened fields; `hint` guarded on truthiness vs
  presence, so a `hint: ""` ships from one and not the other). ⛔ **And the
  reverse-direction finding B8 has no cell for: the kit is WEAKER here.**
  `cli.ts:544-558` triages `ERR_PARSE_ARGS*`, `SyntaxError` and `ENOENT` into
  `usage` envelopes; `reportCliError` returns `null` for all three. Adopting it
  naively **regresses three documented usage classes into a stack-trace crash**
  — the defect `cli.ts:537-540` records as cassandra's P2 gate finding. The
  kit's own header says mind-mapper reached this shape independently
  (`errors.ts:33`); B8 names only glamour.
- **`server.ts:1683` is the wrong line.** The "no idle timeout in V1" comment is
  at **:1685**.

---

## 3 · The `eventLog` adoption renames a published wire field — CONFIRMED, and one half of the claim is wrong

mind-mapper emits `{ seq, epoch, kind, payload }` (`events.ts:96`); the kit
builds `{ id: seq, ...msg }` typed
`Frame<T> = T & { id: number; epoch?: string }`.

| change                      | forced?                                                                                                                                                          |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seq` → `id`                | ⛔ **FORCED.** Named in the type and in the emit literal. No option.                                                                                             |
| `{kind, payload}` FLATTENED | ✅ **NOT FORCED.** `Frame<T>` is generic. **All five existing adopters flatten**, so a port that copies a sibling flattens and one that reads the type need not. |

⚠ **An idiom five siblings share is indistinguishable from a contract until you
open the type** — and the whole of B1 trains the opposite instinct. ⚠ And the
CLI half forces nothing at all: `cursorOf`/`epochOf` are caller-supplied, so a
spell can adopt the entire tail client with **zero** wire change.

**Nothing in Phase B registers a wire-schema rename as a cost.** `seq` appears
in the phase twice, both about grapevine and neither about a rename; none of the
seven entry questions asks what a module's wire field names are or who reads
them; and `eventLog` for mind-mapper would be ruled DE-DUPLICATED, which owes
nothing. ⛔ **The class has been recorded four times — D20, D35, D47, D51 — and
never grew a step.** `wire-observable` appears **zero times** in Phase B.

**Counted, with the rule stated** (comments stripped; word-boundary
`seq|epoch|payload|ServerEvent|BusEvent`; homonyms subtracted by reading every
matched line — the surface's UI bump counters, `WireMessage.seq`, the `messages`
table's own `seq` column, `epoch` meaning unix epoch, `payload` as prose):

| tree                             | envelope-only                                |
| -------------------------------- | -------------------------------------------- |
| `src/mind-mapper/surface/`       | **167 lines / 173 occurrences**, 5 files     |
| `plugins/…/mind-mapper/scripts/` | **~158 lines / ~209 occurrences**, ~30 files |

⛔ **The report's 108 and 84 could not be reproduced by any stated rule**, and
both were too LOW. A blast-radius number without its counting rule is not
evidence (D78, arriving at a second kind of count). And the half a field count
misses: `reducer.ts:25-26`'s `isGap(cursor, seq)` plus ~30 `cursor: event.seq`
assignments — **a rename touches the gap-detection contract, not a property
name.** Count the readers of the MEANING.

The wire leaves the repo: `cli.ts:750` writes the verbatim envelope into an
agent's pipe on every bus line. `cli.ts:733`'s grounding line and `:741`'s
synthesized `epoch.changed` carry no `seq` by design — name them, or the next
reader thinks the sweep missed two shapes.

**Ruled as D81**, with a required output and a third question ("FORCED, or the
house IDIOM?") that halves this port's bill.

---

## 4 · THE MISSING VERDICT — CONFIRMED, and the count is two, not three

Ruled as **D79 · LOSSY-COPY**. The kit module names your spell as its
convergence target and your module holds a property the kit's does not; adoption
is a **net loss of a guarantee that shipped**.

**Why it could not exist before now, and it was nobody's mistake.** D1 ruled the
spine be proven on the two spells that already build; D17 says so in as many
words — _"Checked against these two spells rather than against the census's
counts"_. Astrolabe and magpie are downstream forks of the mind-mapper line, so
the module boundaries were settled against two COPIES while the original was not
in the room. Meanwhile the proposal's own ruling reads: _"Convergence is toward
the best sibling, not a merge of equals. **Mind-mapper's `sseResponse` and event
bus**…"_

| claimed loss                                            | measured                                                                                                                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sse` cannot express the per-stream grounding frame     | ⛔ **REAL** — and the mechanism in the report is wrong; see below.                                                                                                        |
| `eventLog` demoted the epoch from MANDATORY to OPTIONAL | ⛔ **REAL**, and it reproduces census **L6** in the one spell L6's table names as CORRECT.                                                                                |
| `eventLog` dropped `ALL_EVENT_KINDS`                    | ✅ **CONTRADICTED.** `createEventLog<T extends object>` is generic; the vocabulary was never kit material. `ALL_EVENT_KINDS`, `EventKind` and the totality cell all stay. |

⚠ **The third is worth keeping as a shape: "the kit dropped X" is only a loss if
the kit ever had a SUBJECT for X.** A generic parameter is not a dropped
feature, and a cold read cannot tell the two apart without opening the type.

### The `sse` loss is NOT an arity change, and Question 7 cannot find it

The report says `onOpen?: () => void` "takes no argument". True — **and
mind-mapper's own `onOpen` takes no argument either** (`server.ts:380`). The
grounding frame is not written from a hook at all; it is `server.ts:423`'s
`safeEnqueue(...)` inside `start()`, placed **before** `bus.subscribe` at
`:424`. The kit's `onOpen` fires at `sse.ts:208` — after `": connected"`, after
`log.subscribe` at `:200`, after `clients.add`.

⛔ **So the incompatibility occupies no type, which is why Q7 answers
"representable".** Q7's procedure is type-to-type; the kit's subject-type is
`Set<SseClient>` and mind-mapper holds no registry at all, so constructing one
is trivial — you pass an empty set. **The real incompatibility is an ORDERING.**
A caller that supplies its own `clients` set and sends from `onOpen` gets the
grounding line **after the replayed backlog** instead of as the first data line,
and `cli.ts:670`'s `grounded` flag forwards the first grounding it sees.

**Q7 therefore gains a second half:** where a module's subject is a SEQUENCE of
writes, compare the ORDER of the module's hooks against the order your spell
writes in. **A type check cannot see a position.**

### The epoch loss, and why the repair is NOT to widen

`events.ts:67` is `epoch: string`, stamped unconditionally from
`crypto.randomUUID()` at `:90`. `eventLog.ts:78` is `epoch?`, stamped only
`if (epoch !== undefined)`. The header's heading says **"THE THREE THINGS THIS
FIXES BY CONSTRUCTION"** and item 2's own text immediately qualifies it to
_"when the caller asks for one"_. Items 1 and 3 are genuinely by construction;
**item 2 is by opt-in, and three spells have since opted out** — D39 (imago, L6
narrowed), D48 (bounty, narrowed), D70 (grapevine, does not arise).

⛔ **Making the kit's `epoch` mandatory would reverse all three. Do not propose
it.** mind-mapper passes `{ epoch: crypto.randomUUID() }` at its one
construction site and re-tightens its own local frame type; kit bytes zero. What
the kit owes is an **honest header**: L6 is closed by opt-in, not by
construction.

### The discriminator: RESTORATION vs WIDENING

Provenance is not the test — **it does not remove one artifact from the blast
radius**, and D68 prices widenings in artifacts across spells. The test is two
numbers, both of which must be **zero**: with the change applied and every
kit-bundling spell rebuilt, does any OTHER adopter **(a)** need a source edit to
compile, or **(b)** differ by a byte on its WIRE (status, headers, body, stdout,
stderr, exit code)?

⚠ Measure the wire, never the artifact bytes — an optional parameter changes
every artifact's bytes, so a `dist/` diff calls every change a widening and the
discriminator dissolves (D77's one-way implication).

⛔ **Driven, in this pre-work, by accident.** Its own repairs to `tailEvents.ts`
and `eventLog.ts` are **comments only** — zero executable bytes — and
`bun run build` re-emitted **11 artifacts across 7 spells**, each a diff of
**exactly 1 insertion / 1 deletion, all of it the base64
`//# sourceMappingURL=`** (Bun embeds `sourcesContent`). **The artifact-bytes
test grades a comment as a seven-spell widening.** ⚠ And
`grapevine/dist/server.js` was **absent from the 11**, because grapevine refused
those two modules at D68 — **a structural refusal is observable as an artifact
that does not move.**

⛔ **The house has already run this test once without naming it.** D32 widened
`SseClients` for glamour and justified it with exactly (a) and (b):
_"`drainAndStop` was the only other consumer; neither adopting spell
dereferences the elements."_ Both numbers were zero and nobody wrote down that
this was the test.

Predicted for the grounding frame: zero and zero, because none of the other five
writes at open. **That prediction is to be DRIVEN before the change is proposed,
not after** — and if it fails, the row is KEEP-LOCAL.

⚠ **And the hook was rejected once for a reason that does not reach this case.**
D32's not-taken carries _"a `sseResponse` hook that hands the caller a raw
`send` … the caller then has to keep its own collection of them"_. That was
argued against glamour's presence BROADCAST, which pushes to already-open
streams from outside. Mind-mapper needs one frame, on one stream, at open, and
keeps no collection. **Read what a not-taken was argued AGAINST before treating
it as settled.**

---

## 5 · `tail.test.ts` — "re-point it" is unexecutable, and the repair is not to rewrite it

**CONFIRMED:** the file imports `bun:test`, `node:fs`, `node:os`, `node:path`
and **nothing from the spell**. It reaches the CLI by `Bun.spawn` against a
scripted fake SSE server. There is no import to re-point.

**Ruled as D82: the file is left ALONE — assertions untouched — and becomes the
ORACLE the adoption is measured by.** Its only edit is B6.1's: `CLI_SCRIPT`
follows the launcher. Green before chapter 2, swap the loop for `tailEvents`,
green after. A test whose subject is what the PROCESS writes does not care which
module wrote it, and that is exactly why it is the acceptance criterion.

⚠ Re-pointing the path does not point it at the shared client; it points it at a
CLI that now runs `tailEvents`, so every assertion becomes a claim about **how
mind-mapper CONFIGURES `tailEvents`**. `tailEvents.test.ts:5-8` carries the
matching error from the other end and should be corrected, not acted on.

### B8's derive rule kills two of four cells, and the worse one goes GREEN

All four cells set `MIND_MAPPER_TAIL_IDLE_MS=200` and
`MIND_MAPPER_TAIL_RETRY_MS=50` (`tail.test.ts:90-91`). glamour's `heartbeat.ts`
is three plain `export const`s with no env override, wired to
`idleMs: TAIL_IDLE_MS` with no hatch at the call site either.

| cell                                      | followed literally                                                                                       |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| :125 idle watchdog aborts a silent stream | **FAILS** — 45,000 ms watchdog, the 5 s deadline expires, reads as a broken watchdog                     |
| :149 keepalives feed the watchdog         | ⛔ **PASSES VACUOUSLY** — it asserts nothing was aborted, and 45 s cannot abort inside its 800 ms window |
| :166 grounding forwarded once             | survives                                                                                                 |
| :198 epoch change resets the cursor       | survives                                                                                                 |

⚠ **The report predicted both cells failing to a deadline. The measured pair is
worse** — one red, one green-with-no-subject — which is D57's shape again: the
predicted symptom was safer than the measured one. And the derived path cannot
reach the value even deliberately: the kit floors the BEAT at
`MIN_HEARTBEAT_MS = 500`, so the smallest watchdog reachable through
`tailIdleMs` is 1,500 ms and **200 ms is unreachable by construction**.

**The repair already exists and is D75** — the env knob resolves in the SEAM
FILE, and the derivation supplies the DEFAULT rather than the value:
`TAIL_IDLE_MS = intOr(env.MIND_MAPPER_TAIL_IDLE_MS, tailIdleMs(SSE_HEARTBEAT_MS))`.
`tailIdleMs` carries no floor of its own, so a direct override reaches 200 ms.

### The grounding-suppression cell has an affordance — CONTRADICTED

`accept` and `render` are caller-written closures; `render` returns `null` for
the second grounding, `cursorOf` returning `undefined` leaves the seq-less frame
harmless, and `query`'s `firstConnect` is a second route. **The honest statement
is narrower: no DEDICATED affordance and no worked example, and the closure's
STATE lives outside `tailEvents` across reconnects `tailEvents` owns.** That
last clause is the real risk and the kit does not answer it.

**Measured before touching anything: all four cells green, 16 assertions, ~1.25
s.**

---

## 6 · The smaller items — three confirmed, two contradicted, one refined

| item                           | measured                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B7's `exit-site-inventory` row | ⛔ **CONFIRMED.** The CLI has zero `process.exit` (`cli.ts:1730` is `process.exitCode`); the one row is `server.ts` / `E-terminal` and must NOT move, per bounty's precedent at `exit-site-inventory.test.ts:231-238`. ⚠ Its pinned TEXT is unique in the map — any launcher rewrite that normalises it reds the cell.                                                                   |
| B4's coverage printout         | ⚠ **REFINED.** The ward does not list mind-mapper as covered — it lists it in the **population header** and produces **zero coverage rows**, because `dist/` is surface-only. That is B4's own "the one that happens is no row", sitting green. ⛔ And it is green over a live `join(SCRIPT_DIR, "server.ts")` at `cli.ts:113-114` — glamour's exact shipped defect shape.               |
| B6's triage for a big suite    | ⛔ **CONFIRMED and understated.** **32 test files / 9,072 lines**, against a `CLI`/`CLI_SRC` split written for bounty's **2**. More than all six landed ports combined (23). Five distinct path-constant spellings, one of them `new URL(…, import.meta.url).pathname`, which neither a `SCRIPT_DIR` nor a `join(` grep finds.                                                           |
| B0's "1,700-line relocation"   | ⛔ **CONFIRMED as an understatement.** `cli.ts` alone is **1,731 lines**. The relocation is **16,306 across 55 files** — ~9.6×.                                                                                                                                                                                                                                                          |
| B1's `shared/` assumption      | ⛔ **CONFIRMED.** `src/mind-mapper/surface/` imports **zero** modules from `scripts/`. All 23 non-test modules move; mind-mapper is the first spell to end B1 with an empty shared set, and it has no `shared/` to keep.                                                                                                                                                                 |
| B9's premise                   | ⛔ **CONFIRMED as inverted.** No `die` anywhere; `CliError` already **throws**, with `usage:2 · internal:1 · not_found:5 · conflict:6` — `errors.ts`'s taxonomy exactly — under a comment saying why (stdout truncation). B9's stated cost is already paid; its step-1 warning ("look for the raise, not the helper") is what still bites, under-counting to **zero**.                   |
| `server.ts:1708` re-exports    | ⛔ **CONFIRMED.** `export { main, readDoc, sseResponse };`, imported by `sse-keepalive.test.ts:7`. **The daemon is a library with an entry point**, and B6's "test the artifact" rule models only the process shape — bounty's scar is about one constant doing two jobs; here it is **four spawners and one importer, in five files**, so grepping for a shared constant finds nothing. |

---

## Three things neither the report nor the playbook mentions

1. ⛔ **D75, D76 and an eight-month-old journal prediction never reached the
   playbook** (D84). B8's `idleMs` ruling still shows only glamour's no-knob
   shape. `phase-1-journal.md:151-155` named `MIND_MAPPER_TAIL_IDLE_MS` and
   `MIND_MAPPER_TAIL_RETRY_MS`, mapped them onto `idleMs` and `retry.initialMs`,
   and concluded _"a spell whose tests drive a short window will need one"_ —
   written for this port and addressed to nobody who would read it. **The
   generalisation: a ruling made in a REPAIR chapter is the likeliest to stay in
   the decision log**, because ports amend the playbook when they finish and
   repairs happen after that.
2. ⚠ **The orphaned-`enqueue` measurement is already re-homed** (D83) —
   `sse.ts:14-33`, under its own heading, landed the same day. `tailEvents.ts`'s
   "It stays where it was measured" is false as written and read by two agents
   as a warning about a file this port touches. **A refusal recorded in one
   module's header is invisible from the module it points AT.**
3. ⚠ **Two pieces of live prose expire at this port.**
   `import-boundary-wards.test.ts:1082` still names "digestify, grapevine,
   mind-mapper" as the three spells shipping daemons as source — two have
   landed, and mind-mapper's port takes that population to **zero**, which is
   the stated reason the `bun` row in `BUILTIN_EXACT` still exists.
   `src/build.ts:121` says "imago and mind-mapper have only a surface"; imago
   ported. Both are B7's last-paragraph class, and neither is found by grepping
   for a moved PATH.

⚠ **And one non-finding worth recording so nobody hunts it:** the acceptance
box's blind-set re-declaration is a **no-op** here. `DECLARED_BLIND` holds
CSS/HTML/`bunfig.toml`/`.py` only; `.ts` is gateable, so a backend relocation
adds nothing. `src/mind-mapper/`'s three existing entries are untouched.

## What this changes

- **D79** — the fifth verdict, **LOSSY-COPY**, and the RESTORATION/WIDENING
  discriminator (two numbers, both zero).
- **D80** — the missing-SKILL.md escape hatch, and B7's green-for-an-unrelated-
  reason row.
- **D81** — a **WIRE-SCHEMA DELTA** is a first-class cost, with a required
  output and the FORCED-vs-IDIOM question.
- **D82** — `tail.test.ts` is the oracle, not a re-point; the env knobs resolve
  in the seam file.
- **D83** — the `tailEvents.ts` sentence is corrected; nothing moves.
- **D84** — D75/D76 reach B8, and the collection gap is named.

The playbook amendments are marked `⭐ mind-mapper` throughout Phase B.
