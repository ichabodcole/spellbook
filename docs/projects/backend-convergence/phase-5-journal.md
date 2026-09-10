# Phase 5 journal — digestify: one entry, single-shot, and the playbook's first real consumer

**Branch:** `feat/digestify-backend-port` · **From:** `74d20eb` · **Date:**
2026-09-09

| chapter                | sha        | contract                                            |
| ---------------------- | ---------- | --------------------------------------------------- |
| **1 · the relocation** | `110a3611` | behaviour unchanged — nothing the caller sees moves |
| **2 · the adoption**   | `67f74097` | behaviour changes, and each change is named         |

There was **no third chapter**. The Phase B paragraph that budgets one as a
MAYBE was checked against three instruments and all three had already been
repaired in advance of this port: `dist-check` ARM 1b names `review.js` in its
own comment (D49), `spawn-path-ward`'s coverage read the disk and produced
digestify's row with nothing staged (D42), and `launcher-pairing-ward` derived a
digestify row with no edit at all. The class the paragraph records did not fire
here; the paragraph stays.

---

## The four questions, answered before B1

| #   | question                             | digestify's answer                                                                                                                                                                                                                                              |
| --- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | what ARITHMETIC does the entry carry | **DAEMON arithmetic in a CLI-shaped entry.** `SCRIPT_DIR` → `SKILL_ROOT = join(SCRIPT_DIR, "..")` → `DIST_DIR`, the assets directory, `DEV_SURFACE_CWD`, and the dev import's five `..`. **All five correct from `dist/`, none from `src/digestify/backend/`.** |
| 2   | does it serve a substituted payload  | **Yes.** `/` returns `substitute(source)` in memory, and its local `serveDist` refuses `index.html` BY NAME.                                                                                                                                                    |
| 3   | is there a SECOND HALF               | **No.** One entry. Nothing for a shared module to be shared BETWEEN.                                                                                                                                                                                            |
| 4   | long-running or single-shot          | **Single-shot.** One human, one review, then exit.                                                                                                                                                                                                              |

Resolved by hand from the address the module ships at — **never read off the
module's own diagnostics**, which is D57's whole point and which the pre-work
had already measured lying confidently in two directions.

---

## What the port shipped

**One entry, one launcher, one artifact.** `src/digestify/backend/review.ts` +
`plugins/spellbook/skills/digestify/scripts/review.ts` (launcher) +
`dist/review.js` (committed). Both test files moved with it; `scripts/` now
holds the launcher and nothing else.

**The launcher is the CLI shape**, decided by the STDOUT question and written
down with its reason at the file. B2's third case — an exit that is load-bearing
for something other than exiting — was **ruled out by driving it**, not by
reading: the process exits on all three endings.

**`import.meta.main` is gone and `run()` is exported.** Not only because a
bundle's `import.meta.main` is false, but because question 1 said every path the
entry computes is wrong at the source address. The artifact is the only address
the entry has.

---

## What was driven, and it is a review rather than a boot

⛔ **This spell's product is a human reading a rendered page and submitting
once.** A booted daemon nobody submits to exercises neither the in-memory
substitution nor the exit that carries the payload, so every drive below runs a
whole session through the real launcher chain.

| drive                                       | result                                                                                                                                                                                                                                                           |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **release, whole session**                  | ready `mode:"release"` · `GET /` 200 with **neither `__TITLE__` nor `__PAYLOAD__` surviving** and the question text rendered · hashed chunk 200 `text/javascript` · `POST /submit` → **exit 0**, `{"answers":{"q1":"because the playbook said so"},…}` on stdout |
| **dev, whole session, cwd `src/digestify`** | ready `mode:"dev"` · `/_bun/client/` and `/_bun/asset/` on the page · the stylesheet carries the surface's own utility (`text-ink-dim`) — Contract 5's cwd pin survived the relocation · `POST /submit` → **exit 0**                                             |
| **`GET /index.html`, both modes**           | **404**, body carries neither placeholder, and `dist/index.html` on disk still holds both — so the cell is not passing because there was nothing to leak                                                                                                         |
| **the assets sibling**                      | `/assets/classic/digestify-mascot-classic.webp` → 200 `image/webp` 27,202 bytes from the emitted location; `/assets/../scripts/review.ts` → 404                                                                                                                  |
| **`POST /cancel`**                          | **exit 130** with `{"submitted":false,"exit":130,"reason":"closed-without-submitting","observed":"never-opened",…}`                                                                                                                                              |
| **all eight failure sites**                 | see D58's table — every one driven, envelope read, exit code read                                                                                                                                                                                                |
| **`--timeout 0`**                           | before: 124 on the first 50 ms tick. after: never — the session ends at `/cancel` (D59)                                                                                                                                                                          |

**Gate green UNPIPED, exit read from a file:** `1982 pass / 0 fail` across 159
files. **`bun scripts/dist-check.ts` exit 0, all arms.**
**`launcher-pairing-ward`:**
`digestify derived=[review] review.ts→dist/review.js`. **`spawn-path-ward`
coverage:** `digestify/dist/review.js … anchor-read=yes pins=5` — **examined,
not absent**, which is the row D42 exists to produce.

> ⚠ **CORRECTED at the repair chapter: this said `pins=6`, and the ward printed
> `5` at the commit these records shipped in.** It WAS 6 at `110a3611` and
> became 5 at `67f74097`, when de-duplicating `resolveMode` replaced an inlined
> `join(DIST_DIR, "index.html")` with `resolveModeIn(DIST_DIR)` — the same read,
> at the same path, now assembled inside a callee from a PARAMETER, which is the
> ward's declared blind spot. **A de-duplication reduced ward coverage, and a
> coverage count going DOWN is not a failure, so nothing said anything.** Driven
> at all three commits; full account in D64 and C4.
>
> (The count reads 6 again at the repair chapter, from a NEW literal `join` in
> the whitelist. Same number, different site — which is the finding, not a
> coincidence: `pins=N` counts literal spellings, not pins.)

---

## The kit, module by module — including the four with nothing to adopt

| module              | ruling                                                                                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `resolveMode`       | **DE-DUPLICATED.** Byte-identical to the kit's; zero-arg wrapper, the house shape.                                                                                                                                             |
| `serveFromDist`     | **DE-DUPLICATED for the FILE half** — the content-type map matched cell for cell. ⛔ **The router half and the `index.html` refusal stay local**; see below.                                                                   |
| `contentTypeFor`    | **DE-DUPLICATED.** ⚠ `guessMime` stays for `/assets/` — that route serves `.webp`, `.woff2`, `.ico`, which are not build outputs and are outside what the kit's map claims to cover.                                           |
| `shouldIdleClose`   | **RECEIVED.** One real subject; and it brought astrolabe's `timeoutMs <= 0` guard with it (D59).                                                                                                                               |
| `errors`            | **GAINED.** Eight raise sites, no `die` to grep for (D58).                                                                                                                                                                     |
| `startHousekeeping` | **NO SUBJECT.** Owns the PAIR of standing timers; digestify has one and no snapshot, so adopting it means a no-op `touch` and a `subscriberCount` that exists to return zero.                                                  |
| `drainAndStop`      | **NO SUBJECT.** No SSE clients, no sockets, no snapshot. Teardown is a 700 ms grace so the browser can finish fetching the sent-screen mascot, then one graceful `server.stop()` — `stop(true)` would kill exactly that fetch. |
| `eventLog`          | **NO SUBJECT.** No events array, no sequence. One human, one submission, one JSON object.                                                                                                                                      |
| `sse`               | **NO SUBJECT.** No stream anywhere; the page POSTs `/heartbeat` and finishes with `/submit`.                                                                                                                                   |
| `tailEvents`        | **NO SUBJECT.** Nothing tails it — there is no second process.                                                                                                                                                                 |
| `discovery`         | **NO SUBJECT**, and the file says so in as many words.                                                                                                                                                                         |
| `heartbeat`         | **NO SUBJECT** — see below.                                                                                                                                                                                                    |

**The epoch ruling is N/A and it is written down:** no event log, therefore no
`createEventLog`, therefore **census defect L6 does not apply — neither closed
nor narrowed.**

### The seam demonstration is N/A, and the derivation is reported instead

There are no both halves, so no `backend/heartbeat.ts` was created; inventing a
one-consumer module to produce this phase's tidiest proof would be theatre. The
RULE still applies and here is its answer: **digestify's idle window is
`--timeout` seconds — the caller's own number, defaulting to 1800 — and it is
slid forward by a beat the PAGE sends, whose gap is expressed once at
`src/digestify/surface/state/timer.ts` (`HEARTBEAT_MIN_GAP_MS = 5000`).**
Nothing was copied from a sibling and no expression was mirrored.

⚠ **And asking B8's question of a spell with no second entry found something the
question was not aimed at.** Those two numbers ARE a chained pair — the same
class as the bug `kit/wire/heartbeat.ts` exists for — and the seam they cross is
**backend↔surface**, not entry↔entry. At `--timeout 3` the 5 s rate limit can
time out a human who is typing. The kit cannot carry it (its derivations are
keyed on a server-sent SSE beat and a tail watchdog) and there is no home a
backend artifact and a surface bundle both import. Filed as register **D9**, not
repaired: it is a design question about where a backend↔surface constant lives.

### `serveFromDist` — the row whose other half can break a route

The kit guards empty / `..` / nested and **nothing else**. The refusal of the
entry document BY NAME is digestify's, and the house router expression
(`path === "/" ? "index.html" : path.slice(1)`) is exactly what this spell must
never write. A verbatim adoption leaves `GET /index.html` answering the
**unsubstituted** page at HTTP 200 with nothing red anywhere.

The refusal stays one line above the call, the reason is written at the call
site, and — the part B8 did not ask for — **it is now held by a cell**, at both
ends. A drive finds this once; a cell keeps it.

---

## The error contract — D58, and the count is eight

The brief and the pre-work both said **fourteen** sites of stderr prose. Counted
by following the returns rather than the writes: **eight** are failures that
`return 2`. The other stderr writes are the ready line, the heartbeat trace and
the `stale_cancel_ignored` event — three JSON diagnostics, not raises. The
difference does not change any ruling and is recorded because a count is a
claim.

All eight convert. **124 and 130 stay outside the taxonomy**, and three codes
move (`5`, `5`, `6`). **SKILL.md's exit table carries all of it**, with the two
populations named — a destination nothing in Phase B mentions (amendment 5).

### D8's reachability audit, following the call graph

**8 raise sites** (all `die`; no error subclass, no rethrow of a `CliError`),
across a transitive set of **3 functions** — `runReview` holds every raise,
`main` calls it, `run` calls `main`. **6 enclosing `try` blocks.** Every catch
on every path **PROPAGATES**: the five inside `runReview` each END in a `die`,
and `main`'s converts a `CliError` to an exit code and rethrows anything else.

**Zero SWALLOWS, zero CONDITIONALs.** Five swallowing catches exist in the file
— `openBrowser`, the stdin reader's `releaseLock`, and the `/submit`, `/left`
and `/cancel` body parses — and **none is die-reachable**; their bodies call
`Bun.spawn`, `releaseLock` and `req.json()`, none of which is in the transitive
set.

⚠ **And unlike imago, the call graph does NOT leave the spell.** imago's audit
had to follow `tailEvents`'s `resolve` closure into a `try` it did not write.
Digestify adopts no scheduled or callback-taking kit module, so there is no
die-reachable call inside a handler this file does not own. Checked, not
assumed.

---

## Hand-kept lists — including the ones with zero rows

| list                            | digestify                                                                        |
| ------------------------------- | -------------------------------------------------------------------------------- |
| `exit-site-inventory`           | **ZERO rows, and that is correct** — no `process.exit` anywhere, before or after |
| `terminator-invariant`          | **ZERO rows, and that is correct** — same reason                                 |
| `INTERNAL_ENTRY_POINTS`         | **no key, and it did not gain one**                                              |
| `flag-invariant`                | derived; followed the entry with no hand edit                                    |
| ward 1a's pin                   | **RED, re-pointed** → `dist/review.js` (NOT `dist/server.js`)                    |
| `DECLARED_EMITTED_ROOTS`        | **RED, declared** — digestify added                                              |
| `spawn-path-ward`'s escape list | **RED, declared** — `dist/review.js -> src/digestify`, the fifth instance        |
| `daemon-lifecycle-ward`         | generic since Phase 1b; green, as expected                                       |

⚠ **Re-run at the END of chapter 2**, which is the one direction chapter 1
cannot predict: adopting `errors.ts` adds **no** exit site, because `die`
throws. Still zero.

**Prose sweep:** two live instances (`seams.md`'s b4s proof pointer, and
`reaches-the-agent.test.ts`'s successor note). imago had two, bounty had
thirteen; digestify has two, which fits the "scales with the spell's history"
reading rather than the size of the port. A third category was found and NOT
swept — nine line-number pins into `review.ts` from the surface, filed as
register **D8**, because renumbering them re-commits to the wrong kind of pin.

---

## Blast radius

**ONE artifact.** No kit module was modified, so no other spell's `dist/` moved.
That is imago's case rather than glamour's or bounty's, and it is a finding in
its own right: **the wire modules fit a single-shot consumer with no widening at
all** — the first evidence they generalise past the eight standing daemons they
were extracted from.

---

## Where Phase B was still not enough — six, and the ruling is D60

Each was recorded at the moment it was hit, before it was solved, and all six
were amended in ONE pass at the end (marked `⭐ digestify-port`).

1. **B6 never says where the `SKILL_ROOT` comes from once the test is in another
   tree.** No count of `..` reaches it. The house form — a
   `.anthill/config.json` marker walk — existed inside this spell's own
   `dev-styled.test.ts`, under a comment recording that a hand-counted climb
   died at spawn.
2. **B4's "do not stage as a ward workaround" reads as a contradiction against
   B10's `dist-check` exit 0.** ARM 1b **failed** here until the artifact was
   staged. Hit exactly as predicted by the shape of the two texts.
3. **B10's checklist says "booted daemon", and a boot proves nothing for a
   single-shot spell.**
4. **B8's `housekeeping` row never names `startHousekeeping`**, the export an
   "adopt the module" reading takes first.
5. **B8 never names SKILL.md as the destination of an error-contract ruling.**
6. **B8 says DRIVE the defence the kit does not carry, and stops there.** A
   drive does not survive the session; the kept defence needs a cell.

### And what actively held, checked rather than assumed

- **B3's ruling** — the permission is the arithmetic, not the label — gave the
  right answer, and **D57's correction is what made it survive contact**: the
  paths were resolved by hand from `dist/`, and the drives later showed the same
  dev-refusal message naming the CORRECT directory
  (`…/Spellbook/src/digestify`), where the pre-work's broken-anchor run named
  `/Users/colereed/src/digestify`, which does not exist. Same message, same
  code, one true and one a confident lie.
- **B5's derived pin destination.** A literal follow would have pinned
  `dist/server.js`. The depth coincidence was **verified**, not inherited:
  `scripts/` and `dist/` are both one level under the skill root.
- **B7's zero-row discipline.** Two lists with no subject, said out loud in the
  chapter-1 commit rather than discovered by a reader.
- **B8's no-subject table.** Four modules with nothing to adopt, plus two more
  found by extending the same discipline to individual exports.
- **B6.1's split-constant trap** (bounty's `CLI` / `CLI_SRC`): looked for, and
  **absent** — `SCRIPT` is only ever spawned here, and the pure-function cells
  import the source directly.
- **B6.3's fixture rule.** The glob was replaced by one named launcher, and the
  scar it defended is now true by BUNDLING.
- **B10's build rule.** Every build through `bun run build`; the roster build
  after chapter 2 dirtied exactly one file.

---

# The repair chapter — 2026-09-09, driven by an independent verify pass

**The port's own headline was a defence class, and the port created a hole in
it.** Everything below was found by a verify pass this implementer did not run,
against a branch this implementer had already called done. That is the second
consecutive session where the no-stake reader found what the author's own drive
missed, and it found it by asking the SAME question one step wider: not "does
`GET /index.html` refuse?" but "what ELSE is in the directory that route
serves?"

## A · The served set — before and after, driven

Boot the real launcher chain from the real skill root, release mode, and fetch:

| route                                       | before (`20e3135`)                                                                     | after (this chapter) |
| ------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------- |
| `GET /review.js`                            | **200** · 122,389 B · `text/javascript` · sha256 `6ed9d235…` = **`dist/review.js`**    | **404** · 21 B JSON  |
| `GET /REVIEW.JS`                            | **200** · 122,389 B · `application/octet-stream` · same sha                            | **404**              |
| `GET /INDEX.HTML`                           | **200** · 1,180 B · `application/octet-stream` · **`__TITLE__` + `__PAYLOAD__` in it** | **404**              |
| `GET /Index.html`                           | **200** · `text/html; charset=utf-8` · unsubstituted                                   | **404**              |
| `GET /index.HTML`                           | **200** · unsubstituted                                                                | **404**              |
| `GET /iNdEx.HtMl`                           | **200** · unsubstituted                                                                | **404**              |
| `GET /index.html`                           | 404                                                                                    | **404**              |
| `GET /index-dfcfc4w0.js`                    | 200 · `text/javascript`                                                                | **200**, unchanged   |
| `GET /index-ty4gdnpw.css`                   | 200 · `text/css`                                                                       | **200**, unchanged   |
| `GET /` (the substituted page)              | 200, payload injected                                                                  | **200**, unchanged   |
| `GET /assets/classic/…-mascot-classic.webp` | 200 · `image/webp`                                                                     | **200**, unchanged   |

**`GET /review.js` 404s on `develop`** — there was no such file to serve until
this port moved the implementation into `dist/`. **The case variants are
pre-existing**: `rel === "index.html"` is case-sensitive and APFS is not, so
four spellings reached one inode. The fix is one change for both — a whitelist
of the names the built `index.html` LINKS, matched exactly, which makes the
refusal case-insensitive by construction. D61 carries the ruling and the five
options not taken.

**Cells, each calibrated by mutation:**

| cell                              | calibrated by                                                                                                                     |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| the backend-bundle refusal        | RED against the pre-fix artifact (200, the bundle) before the rebuild                                                             |
| the case-variant refusal          | RED against the pre-fix artifact (200 × 4, unsubstituted) before the rebuild                                                      |
| both, against an empty subject    | each asserts its subject is ON DISK first — the artifact carries the backend's own marker, `index.html` still holds `__PAYLOAD__` |
| exactness, not a second blacklist | an upper-cased HASHED CHUNK 404s while the exact name 200s — in the same cell                                                     |
| the INVENTORY cell                | RED when `review.js` is dropped from its refused list                                                                             |

## B · `pins=6` was false when it shipped

See the corrected coverage line above, D64, and C4. Driven at three commits by
putting each one's artifact under the live ward: `110a3611` → 6, `67f74097` → 5,
`20e3135` → 5, this chapter → 6 again from a new site. **A de-duplication
reduced ward coverage**, and the count came back for an unrelated reason, which
is what says the number measures literal spellings rather than pins.

## C · The exit table was not true of the shipped code

| drive                     | result                                                                  |
| ------------------------- | ----------------------------------------------------------------------- |
| `--file <a directory>`    | **exit 1** · raw Bun stack · `EISDIR` · **no envelope**                 |
| `--file <chmod 000 file>` | **exit 1** · raw Bun stack · `EACCES` · **no envelope**                 |
| `--port notanumber`       | **exit 6** `conflict` · `hint: host=127.0.0.1 port=NaN: … Received NaN` |
| `--host nonsense.invalid` | **exit 6** `conflict` · `hint: host=nonsense.invalid port=0: …`         |

SKILL.md's new paragraph said `1`, `2`, `5` and `6` "each write exactly one JSON
envelope", and its own row for `1` contradicted it. **Ruled: the table narrows**
— row 1 says no envelope and why, row 5 gains the second `not_found` site, row 6
stops claiming to be only about a busy port and points at `hint`. **The
conversion of the numeric flags to `usage` is filed as C6, not made** (D62).

## D · `--timeout`'s received change was never about `0`

| drive           | result                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------- |
| `--timeout=1`   | **exit 124** at the idle window — the guard works                                        |
| `--timeout 0`   | **never** times out (killed at 10 s)                                                     |
| `--timeout=-1`  | **never** times out — identical, because the guard is `timeoutMs <= 0`                   |
| `--timeout -1`  | **exit 2** `usage` — `parseArgs` calls the space form ambiguous; never reaches the guard |
| `--timeout abc` | **never** times out · `NaN` · **no diagnostic anywhere**                                 |

D59, this journal and SKILL.md all named `0`. The received change is **any
non-positive value**. The `NaN` case is ruled a usage error and **filed** with
`--port notanumber` as one item (D63, C6); SKILL.md documents it as current
behaviour meanwhile, because a caller told the default is 1800 and not told
`abc` means never finds out by waiting.

## E · Two more stale pointers

`src/digestify/backend/review.ts` and `grimoire/import-boundary-wards.test.ts`
still said `scripts/release-serve.test.ts`. The chapter-2 sweep found two and
repaired two; these are two more, in files this port edited. ⚠ **A third hit is
CORRECT and was left alone** — `import-boundary-wards.test.ts`'s grapevine row,
because grapevine's test really does still live at `scripts/`. The sweep's
instrument is a grep; the grep cannot tell those apart, which is why the count
was wrong.

## What this chapter says about the phase

**The port that makes a defence its headline is the port most likely to breach
it.** The whole of D60's sixth gap is about keeping a defence the kit does not
carry — written, driven, celled, shipped — and it was written in the one chapter
that also moved a 122 KB implementation into the directory that defence guards.
The cell was over the name it knew. **Move-the-implementation and
guard-the-directory were the same chapter, and nobody asked what the move did to
the guard.**
