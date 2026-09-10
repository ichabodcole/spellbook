# Phase 6 journal — grapevine: the port whose deliverable is a refusal

**Branch:** `feat/grapevine-backend-port` · **From:** `240d8c1` · **Date:**
2026-09-09

| chapter                | sha        | contract                                            |
| ---------------------- | ---------- | --------------------------------------------------- |
| **1 · the relocation** | `c2ac1dc1` | behaviour unchanged — nothing the caller sees moves |
| **2 · the adoption**   | `ec543bfb` | behaviour changes, and each change is named         |

**There was no third chapter.** Phase B budgets one as a MAYBE — an instrument
the port itself breaks. Three were checked as they were reached and all three
were already right: `spawn-path-ward` produced grapevine's coverage rows off the
DISK with nothing staged (D42), `launcher-pairing-ward` derived grapevine's row
with no edit, and `dist-check` ARM 1b names `daemon.js` in its own comment
(D49). The class the paragraph records did not fire; the paragraph stays.

---

## The seven questions, answered before B1

Resolved by hand from the address each module ships at — never read off the
module's own diagnostics (D57).

| #   | question                                                 | grapevine's answer                                                                                                                                                                                                                                                                                                |
| --- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | what ARITHMETIC does the entry carry                     | `cli.ts`: `SCRIPT_DIR` → `SKILL_ROOT` → `DIST_DIR`, `SURFACE_CWD` (five `..`), the plugin.json read (three `..`), and **`DAEMON_SCRIPT = join(SCRIPT_DIR, "daemon.ts")` — the flat sibling, B4's defect, which grapevine genuinely had.** `daemon.ts`: the same skill-root chain plus the dev import's five `..`. |
| 2   | does it serve a SUBSTITUTED payload                      | **No.** `/watch` returns the committed `dist/index.html` verbatim; `/` is a JSON status route. Nothing is substituted, so there is **no by-name refusal to keep**.                                                                                                                                                |
| 3   | is there a SECOND HALF                                   | **Yes** — `cli.ts` + `daemon.ts`. The heartbeat seam is real, the first time in four ports.                                                                                                                                                                                                                       |
| 4   | long-running or single-shot                              | **Long-running, and a SINGLETON.** No idle sweep, no snapshot, no `--timeout`; it stands until `stop`.                                                                                                                                                                                                            |
| 5   | does `main()` return while the process must live         | ⛔ **YES.** It resolves the instant `Bun.serve` binds. Confirmed in the port, not re-derived: the natural-return launcher stayed up and answered `GET /`; the pre-work drove the other shape and watched it return to the shell at exit 0.                                                                        |
| 6   | are the log's ids recovered across a restart             | ⛔ **YES.** `loadChannel()` derives `next_id` as a high-water mark over the durable `.jsonl`. **No epoch.**                                                                                                                                                                                                       |
| 7   | does any kit module's subject exist in a DIFFERENT SHAPE | ⛔ **Three.** `eventLog`, `sse`, and half of `housekeeping`. See the REJECT-STRUCTURAL table.                                                                                                                                                                                                                     |

---

## ⛔ THE THREE CAUSES BEHIND ONE SENTENCE, UNTANGLED

`daemon failed to start within 3s` is `cli.ts`'s only report for **three
unrelated defect classes**. All three are named here because a port that fixes
one and still sees the message will believe it fixed the wrong one.

| #     | cause                                             | mechanism                                                                                                                                                                                                                                                                        | how you tell it apart                                                                                                                                     | state after this port                                                                                                                                                                                                                                       |
| ----- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | **The launcher shape** (D69)                      | The daemon binds, writes `daemon.port`, prints `listening` — and the launcher's `process.exit(await run())` kills it. The CLI's `readDaemonPort()` then FINDS the port file the dying daemon wrote, pings it, gets nothing, deletes it as stale, and the 3 s poll loop runs out. | **Run the daemon launcher ALONE, with no CLI in the picture. If it returns to your shell, it is this and nothing else.**                                  | Never introduced. Both launchers are `process.exitCode` + a natural return, and the reason is written at both of them and at the backend source. Driven: the daemon stayed up and answered `GET /` for the whole session.                                   |
| **2** | **The spawn path** (B4)                           | `DAEMON_SCRIPT = join(SCRIPT_DIR, "daemon.ts")` — glamour's exact shipped defect. From `dist/` that is `dist/daemon.ts`, which does not exist. `spawn` fails silently because the daemon's stdio is `ignore`, so no port file EVER appears.                                      | The port file is **never created**, where cause 1 creates it and then orphans it. `ls $GRAPEVINE_HOME` during the 3 s window separates them.              | **Fixed in chapter 1**, up-and-back-down (`join(SCRIPT_DIR, "..", "scripts", "daemon.ts")`), and pinned by `spawn-path-ward`, which resolves it from the EMITTED location: `…/grapevine/dist/cli.js:24 → …/grapevine/scripts/daemon.ts`. Driven end to end. |
| **3** | **A dev-mode daemon dying at its surface import** | `cli.ts:348`'s own comment names it. In dev the daemon must run from `src/grapevine/` for bunfig's Tailwind plugin (Contract 5); at a source-free install the dynamic `import("…/src/grapevine/surface/index.html")` throws, and the daemon dies before writing anything.        | Same signature as cause 2 (no port file), and it is the reason `ensureDaemon` checks `existsSync(cwd)` FIRST and raises a long, specific message instead. | Unchanged, and now louder: that pre-flight refusal is an `internal` envelope rather than prose. `release-serve.test.ts`'s forced-dev cell asserts the daemon dies at the import having written **no port file, no pid file and no channels dir**.           |

⚠ **And the message itself now carries the discriminator.** The `die` at the end
of `ensureDaemon` gained a `hint` naming all three causes and telling the reader
to run the daemon launcher alone. That is the cheapest possible version of this
table, delivered where the defect is actually met.

---

## ⛔ REJECT-STRUCTURAL — three of eight, and the kit was NOT widened

D68's required output, part 1. Part 2 — a line in each kit module's own header
naming grapevine and the reason — is in
`src/kit/wire/{eventLog,sse,housekeeping}.ts` and is the half that survives this
session.

| module         | the KIT's shape, as a type                                                                                                                                                                               | GRAPEVINE's shape, as a type                                                                                                     | the READER that makes them incompatible (measured)                                                                                                                                                                                                                                                                                                                                                                                                                                                  | the widening NOT done, and its cost                                                                                                                                                                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `eventLog`     | one process-wide `Frame<T>[]` capped at `REPLAY_BUFFER_SIZE = 1000`, one monotonic `seq`; its own header says it is "a REPLAY window for reconnects within one daemon's lifetime, **not a durable log**" | **N** durable append-only `.jsonl` files, one per named channel, each with its own `next_id`, replayed off disk by `readBacklog` | `loadChannel()` derives `next_id` as a **high-water mark over every parseable line of the file on boot** (`next_id = Math.max(maxId, lines.length) + 1`). There is no array to be that mark of, and no cap that would not discard history a caller can still request by id.                                                                                                                                                                                                                         | Widening `createEventLog`'s storage and its `subscribe` contract to admit a per-channel durable store changes what **five other daemons compile against** and re-emits **six artifacts across five spells**, each owed a drive.                                                                  |
| `sse`          | `SseClients = Set<SseClient>`, `SseClient = {close, send}` — anonymous closers; `size` is all any adopter reads                                                                                          | `Map<symbol, {alias, human, lurk, send}>`, per channel                                                                           | **SIX routes read the metadata**, counted: `GET /presence` (`daemon.ts:419-421`), `GET /channels/:name/subscribers` (739-747), the roll/clear broadcast (909-921), the archive live-guard (981), the watch-presence registration (1111-1117), and the tail's own registration (1307-1314). `alias` is a name a human reads in a roster, `human` tells an agent it is talking to a person, `lurk` excludes a connection from every count. **There is no way to put an alias into a set of closers.** | Same six artifacts across five spells — and `sse.ts`'s own header records the endpoint: _"A signature wide enough to absorb those stops being a file server and becomes a router."_ A module widened for the one spell that shares nothing is eight copies again with a union type over the top. |
| `housekeeping` | `shouldIdleClose` + `startHousekeeping` (idle sweep + debounced snapshot) + `drainAndStop`                                                                                                               | **no timer of that kind exists**; teardown is `Promise.race([server.stop(true), 200 ms])`                                        | — (see the split below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | —                                                                                                                                                                                                                                                                                                |

**`housekeeping` is SPLIT and ruled per export**, because a row is a module:

- `shouldIdleClose`, `startHousekeeping` — **NO SUBJECT.** Grapevine is a
  singleton broker with no `--timeout` and no snapshot. Adopting the
  pair-manager means writing a no-op `touch` and a `subscriberCount` that exists
  only to return a number nobody acts on: two lies to gain a `clearInterval`.
- `drainAndStop` — **ADOPTED, as a DE-DUPLICATION.** Its server-stop race WAS
  grapevine's, `stopMs: 200` exactly. ⚠ **Called with no `clients`, and that is
  a measurement:** grapevine's subscriber records carry `send` and **no
  `close`** — the per-stream teardown is a closure stashed on the ReadableStream
  controller, reachable only from `cancel()`. There is nothing to hand the
  argument. `graceMs: 0` for a separate reason: grapevine emits no farewell
  frame at daemon shutdown, and `DELETE /` already returns the response and
  schedules teardown 10 ms later, so its flush window is at the route.

**Said out loud, in the shape D68 asks for:** _three of eight kit modules are
REJECT-STRUCTURAL for grapevine — `eventLog`, `sse` and half of `housekeeping` —
and the kit was not widened._

---

## The other five rows, and what each one WAS

| module       | verdict                                          | what changed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------ | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `serveDist`  | **RECEIVED**                                     | The local copy was the pre-whitelist kit function verbatim — empty / `..` / nested + `existsSync`, no by-name refusal, because grapevine substitutes nothing. Adoption GAINS the whitelist (D65). See the leak below.                                                                                                                                                                                                                                                                                                                                                                                      |
| `errors`     | **GAINED, and caller-visible at 38 raise sites** | See the error-contract delta below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `tailEvents` | **GAINED**                                       | 220 lines of hand-written reconnect loop replaced. Three things arrived with it that grapevine did not have: an **idle watchdog** (it had NONE — `await reader.read()` was unbounded, so a half-open socket parked the tail forever and a parked tail is indistinguishable from a quiet channel), a **spec-correct frame parser** (the local one did `.slice(5).trim()`, which strips all whitespace rather than the one leading space the spec removes), and a **signal path that drains** (the old handler was `stopped = true; process.exit(0)` — the P0f defect, in the half five spells did not fix). |
| `heartbeat`  | **GAINED, and it is the seam**                   | `src/grapevine/backend/heartbeat.ts`, imported by BOTH halves.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `discovery`  | **DE-DUPLICATED + RECEIVED**                     | `fileHasValue` + `unlinkSync` IS `unlinkIfMatches`. And the port/pid writes were unawaited `Bun.write`s — `writeFileAtomic` makes them atomic and synchronous, so a CLI polling for the port file cannot read a half-written value.                                                                                                                                                                                                                                                                                                                                                                        |

### The `idleMs` DERIVATION — the expression, not the number

`TAIL_IDLE_MS = tailIdleMs(SSE_HEARTBEAT_MS)` where `SSE_HEARTBEAT_MS = 3_000`.
**9,000 ms.** ⚠ **Grapevine is the spell that makes astrolabe's rule sharpest:
it beats at a FIFTH of the house default**, so a copied 45,000 would tolerate
FIFTEEN missed beats where every sibling tolerates three. The seam demonstration
is NOT N/A here (question 3 answered yes) — before this file the heartbeat was a
literal `3000` inside the daemon's SSE stream, `idleTimeout: 255` was a second
literal ten lines away with the relationship written only in prose, and the CLI
had no corresponding number at all. Both halves now import one file, and the
`heartbeat <= idleTimeout / 2` invariant is enforced by `heartbeatMs` rather
than asserted in a comment.

### The epoch, written out because an absence must not read like a miss

_Grapevine's ids are recovered from durable storage and are continuous across a
restart, therefore **no epoch**, therefore **census defect L6 does not arise** —
it is neither closed nor narrowed, because the condition it describes (ids
restarting at 1) cannot occur here._ (D70.) Stamping one would not be inert:
`tailEvents`'s `onEpochChange` sets `cursor = 0`, and grapevine's tail route
answers `since=0` with `readBacklog(name, 0)` — the whole channel log off disk,
into an agent's pipe, on every `roll`.

---

## ⛔ The leak this port created, measured before and after

Chapter 1 moved the implementation INTO the directory the daemon serves. Driven
through the real launcher against the chapter-1 tree:

| route                    | chapter 1                                 | chapter 2 |
| ------------------------ | ----------------------------------------- | --------- |
| `GET /daemon.js`         | **200**, 146,330 bytes, `text/javascript` | **404**   |
| `GET /cli.js`            | **200**, 251,310 bytes                    | **404**   |
| `GET /watch`             | 200                                       | 200       |
| `GET /index-f0x3896g.js` | 200                                       | 200       |

Both bundles carry an inlined sourcemap with the complete original TypeScript
(D7's ruling is about what a shipped artifact CONTAINS; this was about who could
FETCH it). The fix is `serveFromDist`'s whitelist, derived from what the built
`index.html` transitively links — so the neighbour nobody named is refused for
the same reason, with no second entry to keep in sync. Celled at both ends in
`release-serve.test.ts` (D67's shape): the artifacts are asserted **on disk and
over 50 KB** before the refusal is asserted, or "refused" and "absent" would be
spelled the same way.

---

## The error-contract delta, driven

**Before:** `process.stderr.write(\`grapevine: ${msg}\n\`);
process.exit(code)`— prose at exit **2** for every failure the spell could produce, with two rare internal faults at 1. ⚠ **And`die`was only half of it.** Four rejections in the parser wrote their own prose and`return
2`— a second contract, with its own wording and its own markers, and the one an agent meets FIRST. A grep for`die(`
would have reported the contract as 46 sites; it was 46 plus those.

**After:** one JSON envelope on stderr, stdout empty, and the acc taxonomy.
Driven, on the real launcher:

| invocation                      | before                                                          | after                                                                                                                        |
| ------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `pull no-such-channel`          | prose, **2**                                                    | `{"kind":"not_found","exit_code":5,…,"hint":"try: bun …/cli.ts open no-such-channel","server":{…}}`, **5**                   |
| `send <archived> --from a x`    | prose, **2**                                                    | `kind: "conflict"`, hint `try: bun …/cli.ts unarchive drive3`, **6**                                                         |
| `restart` with live subscribers | prose, **2**                                                    | `kind: "conflict"`, **6**                                                                                                    |
| `send x --timeout 5`            | `grapevine: send: …\n  recognized flags: --as --body-file …`, 2 | `kind: "usage"`, `choices: ["--as","--body-file","--from","--in-reply-to","--force","--quiet","--stdin","--verbose"]`, **2** |
| `info extra`                    | prose, 2                                                        | `kind: "usage"`, `hint: "expects: info (no arguments)"`, **2**                                                               |
| `nosuchverb`                    | prose, 2                                                        | `kind: "usage"`, `choices: [32 verbs]`, **2**                                                                                |

⛔ **THE ENUMERATIONS MOVED FROM A PROSE MARKER INTO `choices`, AND THAT IS THE
ONE PLACE THIS ADOPTION COULD HAVE QUIETLY DEGRADED SOMETHING GOOD.**
Grapevine's rejections were deliberately shaped for acc's flag-set extractors —
`recognized flags: --a --b`, with a comment recording that a qualifier between
the noun and the colon "reads as prose, not a set", and a sort putting long
flags first because an extractor stops at the first token that is not a `--long`
flag. Inside a JSON document a prose marker is a substring of an escaped string.
The house answer already existed and was checked rather than assumed: **glamour
is CONFORMANT L0 and publishes its flag set as `choices`**, not as a marker. The
sort is kept anyway — free, and still right for any consumer that flattens the
array back to a line.

**SKILL.md now publishes the table**, with a per-code sentence an agent can act
on, the envelope shown, and the note that 5 and 6 are new. No ward reads that
prose (B7's last paragraph is about paths; this is prose naming BEHAVIOUR),
which is why it is a step rather than a consequence.

⚠ **Grapevine has no `acc.config.json` (D37), so nothing regrades and the gate
says nothing.** That is register row A4, and this port makes it one spell worse:
grapevine now emits the house envelope with no grade asserting it.

---

## D8's reachability audit

**38 raise sites** — 37 literal `die(` calls plus one `throw new UsageError`,
which a token grep for `die(` does not see — across **28 die-reachable
functions**, computed transitively rather than by grepping call sites. Nine of
the 37 go through `dieApi`, which raises with the kind mapped from the daemon's
HTTP status.

**Three enclosing `try`/`catch` pairs sit on a path to a raise. All three
PROPAGATE; zero SWALLOW.**

1. `cmdGrep`'s `new RegExp(pattern)` — the `die` is in the **catch**, not in the
   try. The shape that makes this audit cheap.
2. `runCommand`'s `parseFlags` — the `die` is in the catch, and the catch
   re-throws anything that is not a `UsageError`.
3. `main`'s `dispatch` — this IS the reporter (`reportCliError`), and it
   re-throws what it does not recognise rather than reporting an unknown fault
   as a tidy taxonomy failure.

**And the call graph leaves the spell**, which step 3 stops at unless you push
it: `tailEvents`'s `resolve` closure calls `ensureDaemon`, which raises. Read
rather than assumed — the kit's outer block is a `try`/**`finally`** with no
`catch`, under a comment saying the unguarded call is deliberate, so the
`CliError` propagates into `main`.

⚠ **One CONDITIONAL, reported and NOT fixed** (B9's instruction): `cmdRoll` and
`cmdRestart` both call `const fresh = await ensureDaemon()` sitting BETWEEN two
`catch {}` blocks — one line below one, two lines above another. Safe today. One
refactor that widens either `try` over that call turns "the daemon failed to
start" into a swallowed `pid = null` and a printed `{ok:true, rolled:true}`:
success reported for a roll that did not happen. Same shape as imago's `cmdOpen`
and glamour's `postCmd`; the third instance, and the second at a verb that
reports a receipt.

---

## The hand-kept lists — both directions, including the zeroes

| list                                             | grapevine                                                                                                                                                                                                                                                                                                                                                                                                                                                        | done                            |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `exit-site-inventory`                            | **RED EXPECTED, TWICE.** Chapter 1 moved five rows (`scripts/` → `backend/`; families and texts unchanged). Chapter 2 DELETED three of them: the CLI's `process.exit(0)` (tail signal handler) and `process.exit(code)` (die) both left with `tailEvents` and `errors`, and the daemon's `process.exit(code),` — the trailing comma is the tell — went with `drainAndStop`. **grapevine's CLI now has ZERO live `process.exit` sites, the sixth to reach that.** | ✅ both chapters                |
| `terminator-invariant`                           | one key, re-addressed                                                                                                                                                                                                                                                                                                                                                                                                                                            | ✅                              |
| `INTERNAL_ENTRY_POINTS`                          | **NO KEY, AND IT MUST NOT GAIN ONE.** `cli.ts` is caller-facing and its 26 flags are SKILL.md's. The daemon parses no arguments at all, so it is not in the population either — an exclusion would be inert.                                                                                                                                                                                                                                                     | ✅ nothing to do, said out loud |
| `flag-invariant`                                 | derived (`argParsingEntryPoints`, both roots). No hand edit.                                                                                                                                                                                                                                                                                                                                                                                                     | ✅ green                        |
| `import-boundary-wards` ward 1a                  | **RED EXPECTED, one row** — re-pointed to `dist/daemon.js`. The five `..` are byte-identical either side, because `dist/` sits at the same depth as the `scripts/` it replaced; **asserted, not trusted**, since the specifier is `--external` and never resolved at build time.                                                                                                                                                                                 | ✅                              |
| `import-boundary-wards` `DECLARED_EMITTED_ROOTS` | **RED EXPECTED** — grapevine added, sixth root.                                                                                                                                                                                                                                                                                                                                                                                                                  | ✅                              |
| `spawn-path-ward`'s escape list                  | **RED EXPECTED** — `…/grapevine/dist/cli.js -> src/grapevine`, the **sixth** instance of the one Contract 5 dev-cwd escape.                                                                                                                                                                                                                                                                                                                                      | ✅                              |
| `daemon-lifecycle-ward`                          | generic since Phase 1b; green is the expected outcome, not a symptom.                                                                                                                                                                                                                                                                                                                                                                                            | ✅                              |
| `launcher-pairing-ward`                          | derived both ways; grapevine's row appears with no edit.                                                                                                                                                                                                                                                                                                                                                                                                         | ✅ green with grapevine present |

**Coverage rows, read by hand rather than trusted (B4's instruction):**

```
plugins/spellbook/skills/grapevine/dist/cli.js     anchors=yes  anchor-read=yes  pins=6
plugins/spellbook/skills/grapevine/dist/daemon.js  anchors=yes  anchor-read=yes  pins=5
```

Both **examined**, not absent. On the first-emit commit both printed
`NOT STAGED` and were scanned anyway, which is D42 working as designed.

**The prose sweep (B7's last paragraph): three live instances**, counted rather
than inherited from imago's "thirty seconds" — a repo instrument's derivation
note naming `grapevine/scripts/cli.ts` as one of the two files a rule was
measured from, and two surface-source comments naming the backend's old address.
All three repaired; the archived and historical mentions were left alone.

---

## What was DRIVEN

- **The daemon launcher alone**, no CLI: stayed up, `GET /` →
  `{"ok":true,"pid":28877,…,"mode":"release"}`, torn down by `DELETE /`. This is
  the discriminator for cause 1 and it is one invocation.
- **The CLI through the launcher chain** (`scripts/cli.ts` → `dist/cli.js` →
  spawned `scripts/daemon.ts`): `open`, `send`, `pull`, `info`, `stop`, exit 0
  each. This is what proves cause 2.
- **Release mode**: `mode release`, `/watch` 200, the committed hashed chunk
  200, `/daemon.js` and `/cli.js` 404 with the artifacts proven on disk first.
- **Dev mode**, from `src/grapevine/` through the same launcher: `mode dev`, and
  `/watch` serves `_bun/client/index-….js` + `_bun/asset/….css` — which is what
  proves Contract 5's cwd pin survived the relocation.
- **A tail through `tailEvents`**: the grounding line on stdout, `# subscribed`
  and `# topic:` and `: grapevine-keepalive` on stderr, a live frame with its
  `full: read <ch> <id>` pointer, clean SIGTERM.
- **Every failure class** in the error-contract table above.
- **Lifecycle files**: written atomically, and both removed at teardown, leaving
  only `channels/`.

Every daemon had its own home under the session scratchpad and was torn down.

## What was NOT verified

- **`GRAPEVINE_IDLE_TIMEOUT_SEC` / `GRAPEVINE_HEARTBEAT_MS`** — the env
  overrides arrive with the kit's parsers and are NEW; the clamp is unit-tested
  in `src/kit/wire/heartbeat.test.ts` but neither variable was driven against a
  live daemon here, and neither is documented in SKILL.md.
- **The tail's idle watchdog firing.** 9,000 ms of silence against a wedged
  half-open socket is not reproducible in a drive without a proxy that accepts
  and stops sending; the kit's own suite covers the mechanism. Gotcha 9 says the
  reconnect rows need a fixed-port proxy, and that was not built here.
- **A `roll` under a live tail.** `resolve` re-spawning across a daemon
  replacement is the property `tailEvents` was adopted for; the suite covers
  reconnect but not the roll specifically.
- **acc.** No `acc.config.json` (D37), so there is nothing to run and nothing to
  regrade. Said explicitly rather than left unticked.
