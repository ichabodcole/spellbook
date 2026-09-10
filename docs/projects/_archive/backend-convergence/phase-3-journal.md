# Phase 3 journal — imago, the first port driven by the playbook

**Author:** Claude Code (implementer) · **Branch:** `feat/imago-backend-port` ·
**Started:** 2026-09-08 from `ae38029`.

This journal's primary product is **the list of places Phase B of
`docs/playbooks/porting-a-spell-playbook.md` was not enough.** Each gap is
written at the moment it was hit, BEFORE it was solved, per the brief. The port
itself is the secondary product.

**Numbering:** `G<n>` = a playbook gap. `K<n>` = a kit-boundary finding. `F<n>`
= a finding about imago or about an instrument.

---

## Baseline

`bun run gate` unpiped, exit read from a file: **exit 0**, 1963 pass / 0 fail
across 158 files, 267 s. `git status --porcelain` after the gate's build shows
only `skills-lock.json` (modified) and `.claude/skills/shadcn/` (untracked),
which is the correct and required state and is never touched.

Confirmed rather than re-derived, all four of the brief's measurements:

| claim                                                   | measured                                                                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| surface imports the skill folder 33 times               | **33** — 32 of `shared/types`, 1 of `shared/imageOptimize`. No other skill-folder module is imported by the surface. |
| both entries are `if (import.meta.main)`                | **yes** — `cli.ts:642`, `server.ts:1758`.                                                                            |
| both anchors are the bare `dirname(fileURLToPath(...))` | **yes** — `cli.ts:38`, `server.ts:59`.                                                                               |
| no `acc.config.json`                                    | **yes** — absent, and stays absent (D37).                                                                            |

---

## The gaps, in the order they were hit

### G1 · Phase B's PREREQUISITE does not apply to imago, and Phase B does not say so

**Hit at:** the first paragraph of Phase B, before any file moved.

Phase B opens with a prerequisite stated unconditionally and with emphasis:

> **Prerequisite, and it has a test rather than a permission behind it:** **acc
> conformance first.** A backend goes conformant before it goes opaque (Phase
> 2's table). Re-run acc from the SKILL DIRECTORY at the end and say the level
> out loud; the port must not regrade it.

and it recurs as a validation checkbox ("**acc re-run FROM THE SKILL DIRECTORY**
… It must not regrade").

**Imago has no `acc.config.json` and acquires none.** There is nothing to run
and nothing to regrade. I could only learn that the prerequisite is inapplicable
by leaving the playbook for `decision-log.md` D37 — which was closed the same
day the brief was written and is not referenced from Phase B at all.

This is the worst-placed gap in the phase, because it is the **first**
instruction and it is a **blocking** one: an agent who read only Phase B would
either stop, or invent an acc config (D37's explicitly not-taken option), and
the first playbook-driven port would be the one port that did not follow the
playbook. Four of the eight spells have no config, and **three of the five still
to port are among them** (bounty, digestify, grapevine).

**The amendment owed:** the prerequisite is conditional on the spell HAVING a
config, and Phase B must say what to do when it does not — nothing, on purpose,
per D37.

### G2 · Phase B prescribes no CHAPTERS, but the brief says "chapter it as B prescribes"

**Hit at:** planning, immediately after G1.

The brief (and the mission) say "Follow Phase B's chapters and let the gate pass
between them" / "Chapter it as B prescribes, gate between chapters." **Phase B
prescribes no chapters.** B1–B10 are ten TOPICS, and they are not in commit
order — B8 (adopt the kit) and B9 (the reachability audit) are one body of work
that must not land in the same commit as B1–B7's relocation, while B10 (build)
is not a chapter at all but a rule that applies to every chapter.

The chaptering rule that actually governs lives in **D9** ("the relocation and
the adoption are one branch, in two chapters, and chapter 1 must be green and
demonstrated on a booted daemon before chapter 2 starts") — decision log, not
playbook. Phase B alludes to the split only in passing, descriptively, inside
B10's blast-radius bullet ("glamour's chapter 2 touched three kit modules").

I read D9 and adopted its two-chapter split. **An agent with only Phase B would
have had to invent one**, and the natural reading — one commit per B-step — is
precisely the shape D9 exists to forbid, because it would land a relocation and
a behaviour change in the same diff with nothing between them.

**The amendment owed:** Phase B states its own chapter split, in order, with the
gate between, and names which B-steps fall in which chapter.

### G3 · ⛔ B4's coverage row is ABSENT, not zero, until the artifact is STAGED — and an absent row looks like nothing to cover

**Hit at:** B4, running the ward on the freshly built imago bundles, chapter 1.
**This is the phase's most transferable finding, and it is the third repetition
of the same shape the ward has now failed on three times.**

B4's starred instruction is:

> ⭐ **SO DO THIS, EVERY PORT, BY HAND:** read your emitted anchor line, then
> run the ward and **confirm its coverage row prints `anchor-read=yes` with a
> non-zero `pins=` for YOUR spell.**

I did exactly that, on a green ward, and got this:

```
SPAWN-PATH WARD — 14 emitted file(s) across 8 spell(s): astrolabe, bounty,
    digestify, glamour, grapevine, imago, magpie, mind-mapper
SPAWN-PATH WARD — coverage:
    …/astrolabe/dist/cli.js     anchors=yes  anchor-read=yes  pins=6
    …/astrolabe/dist/server.js  anchors=yes  anchor-read=yes  pins=2
    …/glamour/dist/cli.js       anchors=yes  anchor-read=yes  pins=6
    …/glamour/dist/server.js    anchors=yes  anchor-read=yes  pins=2
    …/magpie/dist/cli.js        anchors=yes  anchor-read=yes  pins=7
    …/magpie/dist/server.js     anchors=yes  anchor-read=yes  pins=2
7 pass · 0 fail
```

**imago is NAMED IN THE POPULATION LINE and has NO COVERAGE ROW.** Not `pins=0`
— no row at all. B4 tells you what a bad row looks like (`pins=0`) and the brief
repeats it ("If imago's emitted bundles yield `pins=0`, the ward is not guarding
this port"). **Neither tells you that the row can simply be missing, or that a
missing row is the same failure wearing better clothes.**

**Cause, measured.** `emittedJs()` reads `git ls-files` and then filters to
files that exist — deliberately, and the reason is written in its own header (a
rebuilt hashed chunk is absent from the index mid-port, and the ward used to
crash on that). A brand-new `dist/cli.js` is the mirror image: **present on
disk, absent from the index.** It is filtered out, `isBackendArtifact` then
matches nothing, and the spell keeps its place in the population line only
because its TRACKED surface chunk (`dist/index-k9b89bdc.js`) is still there.

So the ward's coverage cell — the instrument D27 built and D36 rebuilt
specifically so that a spell it has never seen cannot slip through — **is blind
to every spell on the exact commit that first emits its backend.** That is the
whole population of the five remaining ports.

**Confirmed by driving it, not by reasoning.** `git add`ing the two artifacts
and re-running, with nothing else changed:

```
    …/imago/dist/cli.js     anchors=yes  anchor-read=yes  pins=5
    …/imago/dist/server.js  anchors=yes  anchor-read=yes  pins=4
```

and the spawn pin resolves where it must:
`imago/dist/cli.js:14  join(SCRIPT_DIR, "..", "scripts", "server.ts")  -> plugins/spellbook/skills/imago/scripts/server.ts`.

**So the brief's fourth measurement is CONFIRMED — the ward does cover imago —
but only after a step B4 does not contain.**

**F1, the same finding stated as a defect in the instrument.** The ward should
not be able to be silent about a spell it has already named in its population.
The honest cell is the one D36 already reasoned to at the level below: _a spell
in the population must produce a coverage row, or red naming the spell._ Today
"in the population" is satisfied by a surface chunk, so the ward cannot even
tell "this spell has no backend" from "this spell's backend is untracked". Filed
here rather than fixed, because chapter 1's contract is behaviour-unchanged and
this is an instrument change with its own calibration to write — **but it is the
first thing Phase 4 should pick up**, and B4 must carry the staging step until
it is fixed.

**Also hit, and this half B7 DID predict:** the ward's "a pin that leaves the
skill folder is ENUMERATED" cell red on imago's `SURFACE_CWD` escape
(`…/imago/dist/cli.js -> src/imago`) — the third instance of the same Contract 5
dev-cwd pin. Re-declared by hand, as B7 says to.

### G4 · B7's list of wards to expect red is INCOMPLETE, and one of its entries did not fire

**Hit at:** B7, running `bun test grimoire/` after the relocation.

B7 names six: `exit-site-inventory`, `import-boundary-wards` (1a's pin, 1b's
`bun` floor, the re-export inventory, any line-number pin),
`terminator-invariant`, `daemon-lifecycle-ward`, `flag-invariant`. Measured on
imago, **seven cells red across five files**, and the set does not match:

| red cell                                                     | in B7's list?            |
| ------------------------------------------------------------ | ------------------------ |
| `exit-site-inventory` — four CLI rows re-addressed           | yes                      |
| `import-boundary-wards` ward 1a — the dev-import pin         | yes                      |
| `import-boundary-wards` ward 1b — `DECLARED_EMITTED_ROOTS`   | yes                      |
| `import-boundary-wards` ward 1b — the `bun` exemption floor  | yes                      |
| `import-boundary-wards` — the re-export inventory            | yes                      |
| `flag-invariant` — imago's `--host/--id/--port` undocumented | yes                      |
| `terminator-invariant` — the positional-hazard pin           | yes                      |
| **`spawn-path-ward` — the ENUMERATED-escape cell**           | **NO**                   |
| `daemon-lifecycle-ward`                                      | listed, **did not fire** |

**The omission.** `grimoire/spawn-path-ward.test.ts` carries a hand-kept list of
its own — the pins that legitimately leave the skill folder — and imago's
`SURFACE_CWD` (`…/dist/cli.js -> src/imago`) is the third instance of exactly
the escape glamour's Phase 2 added. B4 discusses this ward at length as an
INSTRUMENT and never says it also contains a hand-kept list, and B7 enumerates
the hand-kept lists and never names this ward. **A list that appears in neither
of the two steps that would surface it is the shape B7 itself is about.**

**The one that did not fire, and why that is worth writing down rather than
crossing out.** `daemon-lifecycle-ward` stayed green because Phase 1b already
extended both its walks (`daemons()`, `clis()`) across BOTH roots — its header
says so in as many words — so imago's daemon simply appeared under `src/` as it
left `skills/`, and the population zero-guard never moved. **It is listed in B7
because it red for glamour; it is generic now.** Worth saying because the cost
of a stale expectation runs the other way: an agent who sees it green may go
looking for what they broke.

**Also outside both steps:** two LIVE prose references to the old paths that no
ward reads — `import-boundary-wards.test.ts:313`'s comment pointing at
`imago/tests/` for the release-serve gate, and
`docs/backlog/2026-08-31-sharp-is-a-root-dependency-with-one-test-consumer.md`,
whose entire subject is a file path that just moved. Both repaired. **Phase B
has no step for "the prose that names the files you moved"**, and `git grep`
over the old paths, filtered to live files, is a thirty-second step that would
cover it.

### F2 · The relocated tests were verified to still RUN, by arithmetic

Not a gap — a check the playbook does not ask for and that circe's seat doc
(`.anthill/dev/circe.md:242`) earned in the surface port: _a test that leaves
the discovered tree fails silently upward._ `bun test src/imago/backend` → **70
pass / 0 fail across 5 files**, and the full gate went 1963 → 1963 tests across
158 → 158 files with expect() calls 5767 → 5768, the one added assertion being
the inverted `shared/` cell in `release-serve.test.ts`. Nothing was dropped.

## Chapter 2 — the kit adoption

### G5 · ⛔ B8 treats adopting `errors.ts` as free. On a CLI that does not already speak the envelope it is a BEHAVIOUR CHANGE — to the one thing `wire/` is defined as

**Hit at:** B8, reading imago's `die` against the kit's, before writing a line.

B8's whole instruction on this module is one clause: _"All of `src/kit/wire/`:
`tailEvents` + `errors` on the CLI side."_ It is listed beside seven modules
that are genuinely internal, and nothing anywhere in Phase B says what adopting
it does to what a caller sees.

**What it does to imago.** imago's `die` is:

```ts
function die(msg: string): never {
  process.stderr.write(`imago: ${msg}\n`);
  process.exit(2);
}
```

Prose on stderr, and **exit 2** — a missing session, a bad flag and an internal
fault are one number. (⚠ **CORRECTED 2026-09-09:** this said "exit 2 for every
failure" and named the unreachable daemon among them. It is false — an
unreachable daemon never reaches `die` at all; it crashes out of an unguarded
`fetch` at **exit 1**. See R3.) The kit's `die` throws a `CliError`, `main`
reports it as **one JSON envelope** on stderr, and the exit code comes from the
taxonomy: usage 2, internal 1, not_found 5, conflict 6. Every one of imago's 20
failure paths changes both its stderr bytes and, for most of them, its exit
code.

**Why the playbook could not have noticed.** Glamour, the spell Phase B was
written from, was **already CONFORMANT L0** before its port: it had reached the
envelope-and-taxonomy shape independently at its acc pass, so adopting the kit
was for glamour a de-duplication with no observable delta. **Imago is the first
adopter for whom it is not** — and per D37 imago has no `acc.config.json`, so
there is no grade to re-run and nothing in the gate that would have told me.
**Three of the four remaining ports (bounty, digestify, grapevine) are in the
same position.**

⚠ **And note the direction of the trap.** D37's reasoning is "building does not
drag conformance in front of a spell", which is true and which I confirmed. But
the port drags a piece of conformance in ANYWAY, through B8 — the failure
contract, which is the largest observable surface acc grades. A spell can come
out of this port speaking the L0 envelope without ever having been graded.

**How I resolved it, and it is a decision, not a detail (D38).** Adopt in full,
because the mission and B8 say all eight modules and because `wire/` exists
precisely so that this contract is one implementation; then say out loud, in its
own commit and in the decision log, that imago's failure output changed — rather
than letting a "behaviour unchanged" chapter quietly re-spell every error the
spell can emit. Recorded here first, before the change.

**The amendment owed:** B8 must carry a step — _read the spell's existing `die`
before adopting the kit's; if it does not already emit the envelope and the
taxonomy codes, the adoption is a caller-visible change, it belongs in its own
commit with the delta stated, and any test asserting the old prose must be
re-pointed._

### F3 · B9's reachability audit, performed — 21 raise sites, zero swallowing catches, one CONDITIONAL reported

Counted the way B9 says to: **the type, not the token.** Everything that
CONSTRUCTS or THROWS a failure imago's `main` funnel must see.

- **20 direct `die(` sites** (`cli.ts`, after adoption).
- **1 `throw new UsageError`** (`parseArgs`, `:280`) — a spell-local class that
  `dispatch`'s catch converts into a `die`. Invisible to a `die(` grep, which is
  exactly B9's warning; the token count is 20 and the raise count is **21**.
- The transitive set that reaches one: `die`, `daemonRefused`, `readSession`,
  `requireSession`, `parseArgs`, `cmdOpen`, `urlToDataUrl`, `resolveSrc`,
  `cmdInfo`, `postCmd`, `cmdState`, `cmdTail`'s `resolve` closure, `dispatch`,
  `main`.

**Every enclosing catch on every path, classified.** Nine `try` blocks:

| site                            | catch                                          | die-reachable call inside? | verdict               |
| ------------------------------- | ---------------------------------------------- | -------------------------- | --------------------- |
| `readSession` :187              | dies                                           | no                         | PROPAGATES            |
| `readSession` :194              | dies                                           | no                         | PROPAGATES            |
| `api` :219 (`res.json()`)       | `catch {}` — **swallows**                      | **no**                     | safe                  |
| `parseArgs` :270                | `throw new UsageError`                         | no                         | PROPAGATES            |
| `cmdOpen` :328 (liveness probe) | `catch { /* not up yet */ }` — **swallows**    | **no**                     | ⚠ CONDITIONAL — below |
| `cmdSessions` :456              | writes "no saved sessions", returns — swallows | no                         | safe                  |
| `cmdSessions` :466              | skips the snapshot — swallows                  | no                         | safe                  |
| `dispatch` :518                 | rethrows non-`UsageError`, else dies           | **yes** (`parseArgs`)      | PROPAGATES            |
| `main` :698                     | converts to an envelope + exit code            | **yes** (everything)       | PROPAGATES            |

**And the graph now leaves the spell**, which B9 does not mention and which is
new with `tailEvents`: `cmdTail`'s `resolve` closure calls `readSession`, and
the SHARED CLIENT invokes it on a schedule from inside its own `try` at
`tailEvents.ts:376`. Read: that is a `try`/**`finally`**, with no `catch`, under
a comment that says the unguarded call is deliberate. **PROPAGATES** — out of
the kit, into imago's funnel.

⚠ **THE CONDITIONAL, REPORTED AND DELIBERATELY NOT FIXED**, per B9's closing
instruction. `cmdOpen`'s start loop is:

```
const s = readSession();                 // ← die-reachable, THREE LINES ABOVE
if (s && s.session_id !== prevId) {
  try { const r = await fetch(`…/state`); … }
  catch { /* not up yet */ }             // ← swallows
}
```

It is safe today because the die-reachable call sits outside the `try`. One
refactor that widens the `try` to cover the pointer read turns a **corrupt
session pointer** into "not up yet", the loop spins to the 5 s deadline, and the
failure is reported as `imago server failed to start within 5s` — a taxonomy
failure reported as a different taxonomy failure. **This is glamour's `postCmd`
ECONNRESET shape, at a different spell, found by the same audit** — which is the
strongest available evidence that B9's step is worth its cost. Filed, not
smuggled.

### F4 · The SSE stream now opens with a `: connected` comment — a wire change, and one test read "the first line" as "the first event"

`kit/wire/sse.ts` writes `: connected\n\n` before the replay, which imago's
hand-rolled `sseResponse` did not. `release-serve.test.ts`'s ready-frame cell
took `chunk.split("\n")[0]` and `JSON.parse`d it, and failed with
`Unexpected token ':'`. Repaired to read until a `data:` line **and to assert
the preamble** rather than tolerate it.

Not a playbook gap — B8 says adopt the module and the module documents this —
but worth recording as the shape: **the first thing kit adoption broke was a
test that had encoded the OLD module's byte-level output as an incidental.**

### G6 · B8 names eight modules and nothing else — no mapping, no order, and one per-spell RULING it does not mention

**Hit at:** B8, starting the daemon-side adoption.

B8's operative content is one sentence — \*"All of `src/kit/wire/`: `tailEvents`

- `errors` on the CLI side; `serveDist`, `eventLog`, `sse`, `housekeeping`,
  `discovery`, `heartbeat` on the daemon side"\* — followed by four paragraphs
  about `idleMs`, which is genuinely the one rule that cannot be copied.
  **Nothing says what each module REPLACES.** I got the mapping by reading
  `src/glamour/backend/server.ts` beside imago's, which works because glamour is
  imago's fork and will work less well for grapevine.

The mapping is stable across all three adopting daemons and is a table:

| the local shape you are looking for                                     | the kit export               |
| ----------------------------------------------------------------------- | ---------------------------- |
| `function resolveMode()` reading `existsSync(join(DIST_DIR,…))`         | `resolveMode(distDir)`       |
| `STATIC_CONTENT_TYPES` + the `serveDist` file half                      | `serveFromDist`              |
| `const events: […] = []` + `let eventSeq` + `emitEvent`                 | `createEventLog`             |
| `function sseResponse(url)` with its own `ReadableStream` + `hb`        | `sseResponse`                |
| a second `Set` of per-stream timers                                     | (deleted — it is the funnel) |
| presence emitted through `emitEvent`                                    | `client.send`                |
| `const idleTimer = setInterval(…)` + `const snapTimer = setInterval(…)` | `startHousekeeping`          |
| the grace/close/close/race block after `await done`                     | `drainAndStop`               |
| a local `writeAtomic`                                                   | `writeFileAtomic`            |
| `cleanupDiscovery` comparing `session_id` before unlinking              | `unlinkIfMatches`            |
| `idleTimeout: 255` and a literal `15000` heartbeat                      | `./heartbeat.ts`             |

⛔ **AND THERE IS A SECOND PER-SPELL RULING B8 DOES NOT NAME: whether the daemon
STAMPS AN EPOCH.** `createEventLog` takes `{ epoch }`, mind-mapper stamps one,
and census defect L6 is about its absence — so an adopter must DECIDE, and B8
gives no criterion. The house position exists only as a comment inside glamour's
`server.ts`: a session-scoped daemon stamps none, because a session is
identified by `session_id`, a restart is a different session, and a resuming
tail is already talking to a different daemon by name. **I applied it to imago
because imago is the same shape.** A singleton daemon (astrolabe, mind-mapper,
grapevine) is the other shape and the answer flips.

**The amendment owed:** the table above, plus one paragraph making the epoch a
named decision with the session-vs-singleton criterion.

### G7 · `exit-site-inventory` reds TWICE, in both chapters, and B7 describes it as one event

Chapter 1 moved four rows (`imago/scripts/cli.ts` → `imago/backend/cli.ts`) —
addresses change, families and texts do not. Chapter 2 **deleted all four**,
because adopting `tailEvents` and `errors` leaves the CLI with zero live
`process.exit` sites. B7's paragraph reads as a single re-declaration and I
re-declared once, then hit it again after the gate at the end of chapter 2.

Small, and worth a sentence: **the relocation moves the rows and the adoption
removes them**, so the ward is edited in both chapters and an agent who tidies
it once will be surprised. glamour's own inventory rows record exactly this
two-step in prose — the information exists, one file away from the playbook that
needed it.

---

## Kit boundaries — what was checked, and the one divergence found

Imago is the **fourth** consumer, and the brief asks for every boundary that was
wrong for it. **I found none that had to be widened**, which is a weaker claim
than "the kit is right", so here is what was actively checked and did not fail:

- `serveFromDist` — imago has a `/assets/<name>` route ABOVE the dist route, and
  the disjointness comes from the nesting refusal rather than route order. The
  kit's refusal (`rel.includes("/")`) is byte-equivalent to imago's own, and
  `release-serve.test.ts`'s planted-file cell still convicts.
- `createEventLog` — imago's frames carry a payload `id`. This is the boundary
  most likely to have been wrong, and it was right in imago's FAVOUR: the kit's
  assign-after-spread fixed a live defect (see chapter 2's commit).
- `sseResponse` — the `filter` hook was not needed, because `client.send`
  (widened in Phase 2, for glamour, for presence) covers imago's presence case
  exactly. **Phase 2's widening paid for itself here at zero cost**, which is
  the first evidence that a widening generalised rather than fitting one spell.
- `startHousekeeping` — imago's snapshot is synchronous and argumentless; the
  `dirty/clear/write` triple fits without a wrapper.
- `heartbeat` — imago hard-coded 255 and 15,000 and env-tuned neither. The kit's
  derivations accept that as their default case.
- `errors` — fits, and the fit is the problem (G5), not the boundary.
- `tailEvents` — imago's tail had FOUR backoff sites where glamour had three,
  and the extra one (`await sleep(delay)` after the stream ends, on a `delay`
  the successful open had just reset) is absorbed by there being no loop.

**K1 · The one divergence the kit does NOT prevent, reported rather than fixed:
teardown ORDER.** `drainAndStop` bounds the drain, but the steps around it are
still hand-written and the two adopting session daemons order them differently:

| step                    | glamour | imago |
| ----------------------- | ------- | ----- |
| `stopHousekeeping()`    | 1       | 1     |
| final snapshot          | 2       | 2     |
| `cleanupDiscovery()`    | **3**   | **6** |
| `emitEvent({closed})`   | 4       | 3     |
| broadcast to WebSockets | —       | 4     |
| `drainAndStop`          | 5       | 5     |

Imago's order means a CLI verb issued DURING the 150 ms drain still finds the
session pointer; glamour's means it does not. Neither is obviously wrong and
imago's is arguably better, but **it is a difference in observable behaviour, in
a step the spine was supposed to converge, and nothing red.** This is what the
census would find as an L-defect two months from now. Filed, not fixed — closing
it means deciding the order, which is a ruling about all seven daemons and not
one spell's port.

---

## Closing — the seven gaps, and the honest other half

**The gaps, in the order hit:** G1 (the prerequisite does not apply) · G2 (no
chapters) · G3 (the coverage row is absent until staged) · G4 (B7's ward list
wrong in both directions, plus the uncovered prose category) · G5 (`errors.ts`
is the failure contract, not an internal module) · G6 (no module→shape mapping,
and the epoch is an unnamed ruling) · G7 (`exit-site-inventory` reds twice).

All seven are folded into Phase B in ONE amendment pass, made after the port was
green, so it is unambiguous which version this port actually followed: the one
at `ae38029`.

**What I actively checked for and did NOT find**, because "the playbook was
fine" is unfalsifiable and so is "the kit was fine":

- **No kit boundary had to be widened.** The seven checks are listed above under
  "Kit boundaries". The one most likely to have been wrong — `createEventLog`
  against a spell whose frames carry a payload `id` — was right in imago's
  favour and fixed a live defect. ⚠ **AMENDED 2026-09-09: it also silently
  deleted a field, and this bullet did not see it. See "The repair" below.**
- **No step in B1–B7 was WRONG for imago**, as opposed to absent. B4's
  path-pinned-sibling class predicted imago's shipped spawn defect before it was
  looked for; B1's rule decided `state.test.ts`, which its filename would have
  mis-sorted; B3, B5 and B6.1–2 held verbatim.
- **The relocation dropped no test** — checked by arithmetic (1963 → 1963 tests,
  158 → 158 files) and directly (`bun test src/imago/backend` → 70/5).
- **The blast radius was two files.** No `src/kit/` file was modified, and
  `git status` after the gate showed no sibling spell's artifact or stylesheet
  moving — B10's stylesheet-churn check run and clean.
- **Nothing in the brief turned out to be false.** All four "confirm, do not
  re-derive" measurements held exactly, including the 33.

**The one thing in the brief that was incomplete rather than false:** it said
"If imago's emitted bundles produce `pins=0`, the ward is not guarding this
port." The bundles produced **no row at all**, which is the same conclusion by a
mechanism neither the brief nor B4 names. See G3.

## The repair, 2026-09-09 — what the collision actually cost

Two items, found after the port was green and verified, repaired on the same
branch.

### R1 · ⛔ A COLLISION RESOLVED IN ONE FIELD'S FAVOUR IS A FIELD SILENTLY DELETED

The defect this journal celebrates finding — `{ id: ++eventSeq, ...msg }`
spreading the payload AFTER the cursor, so `proposal.send` and
`proposal.dismiss` went out with a proposal's id where the cursor belongs — is
real, and worse than recorded: because `ev.id > since` is false for a string,
**those two frames were never replayed to a resuming tail at all.**

But `createEventLog` fixed it by making the cursor **win**, and the two fields
were fighting over one name. Winning is not merging. Driven, same daemon, same
action, one branch apart:

```
develop : {"id":"m-645f6b32","type":"proposal.send"}   ← cursor broken, proposal present
branch  : {"id":2,"type":"proposal.send"}              ← cursor correct, proposal GONE
repaired: {"id":2,"type":"proposal.send","proposalId":"m-645f6b32"}
```

`server.ts` still passed `id: msg.id` at both sites; nothing dropped it on the
floor loudly. The agent that reacts to `proposal.send` lost the answer to _which
proposal_.

**The generalisation, and it is the one to carry to the four remaining ports:**
when a shared module and a caller both want the same field name, "the module
wins" is a complete fix for the module and a **deletion** for the caller. The
repair is never to pick — it is to **rename** so both survive. The proposal's
identity now rides as `proposalId`; `id` on a frame means the tail cursor and
nothing else, at every spell.

### R2 · `Record<string, unknown>` is what let a TYPED, TWO-SIDED contract go false with no type error

`shared/types.ts` is shipped to the agent as the single contract, and it
declared `"proposal.send": { id: string }` for a full branch during which the
wire carried no such field. Nothing complained, because `emitEvent` is
`(msg: Record<string, unknown>) => log.emit(msg)` — the one signature in the
path that accepts anything and checks nothing. **A declaration file cannot be a
contract if the emitter is untyped; it is a comment with syntax highlighting.**
Tightening `emitEvent` against `AgentEventPayload` is filed, not done here — it
is a real change to a verified branch and belongs in its own chapter.

⚠ **And the reason neither of these was caught: imago had NO test asserting the
SHAPE OF A FRAME.** Thirty-eight integration tests drove the wire and every one
of them asserted state or the presence of an event type. One now asserts a
`proposal.send` frame carries a **numeric** `id` AND the proposal's identity —
which is exactly the pair of claims the two successive defects each broke one
half of (`src/imago/backend/server.integration.test.ts`, "agent event
contract").

### R3 · D38 and B8 both asserted "exit 2 for EVERY failure", and that was false

Falsified by driving `develop`, not by re-reading it: imago's `api()` calls
`fetch` with no handler, so `state` and `say` against a **dead daemon** never
reach `die` — they crash with a raw Bun `TypeError … ConnectionRefused`, the
daemon's source lines quoted, at **exit 1**. The old contract had two shapes.
Corrected in D38 and in Phase B's B8, with the claim's force kept: the adoption
still replaced a prose-and-mostly-2 contract with the house taxonomy, and that
path went from a stack trace to a `kind:"internal"` envelope (exit code
unchanged at 1). **The lesson for the four remaining ports is in B8 now: do not
characterise a spell's old failure contract from its `die`. Run the failures.**
