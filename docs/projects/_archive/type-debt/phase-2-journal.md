# Phase 2 — digestify, the pathfinder

**Branch:** `feat/type-debt-phase-2` (from `develop`) · **Date:** 2026-09-10 ·
**Status:** complete, calibrated, green **Decisions:**
[`decision-log.md`](./decision-log.md) **T21–T24**

**`src/digestify/backend` 8 → 0 · repo total 543 → 535 (−8, exactly what was
fixed).** No file deleted, no file added, no `!`, no `as any`, no
`@ts-expect-error`, no `?? ` standing in for an invariant. Five test cells
added, none lost.

---

## 1 · ⛔ The `engaged` verdict: NOT DEAD. The compiler was describing itself

The brief opened by asking whether `review.ts:852`'s
`Property 'engaged' does not exist on type 'never'` meant the departure-
observation feature was **dead**, since `never` usually means a branch cannot be
taken. **It is live and shipped.** Full argument in **T21**; the establishment,
in the order it was done:

**a. Read the declaration and the assignments — necessary and not sufficient.**
`departure` is `let departure: Departure | null = null` in `runReview`, assigned
at two sites, **both inside `Bun.serve`'s `fetch` closure** (`POST /left`, one
for a well-formed beacon and one for a malformed one). So there are assignments;
the question is why the compiler cannot see them.

**b. Grep for the consumer.** `departure.engaged` feeds `observed`, which is
written to stdout in the non-submit envelope, and
`docs/projects/digestify-conversion/behaviour-inventory.md` **S13** records
`observed:"engaged-then-left"` from a browser drive. Suggestive. **A document is
not a measurement**, and a deletion argument would normally stop at the grep.

**c. ⭐ Then a MINIMAL REPRO isolated the mechanism, and that is what refuted
the hypothesis.** TypeScript's control-flow analysis does not model a closure's
writes when the read is in the **enclosing** function:

| reference site                | result                                |
| ----------------------------- | ------------------------------------- |
| in the **enclosing** function | `TS2339 … on type 'never'`            |
| in a **nested** function      | **clean** — declared type is restored |

Both halves in one 13-line file. **A `never` from this cause is
indistinguishable, at the error text, from a `never` that means dead code.**

**d. The positive control that settled it — all four arms, through the BUILT
launcher.**

| arm                   | exit    | `observed`              | `departure`                           |
| --------------------- | ------- | ----------------------- | ------------------------------------- |
| never-opened          | 124     | `never-opened`          | `null`                                |
| opened-then-silent    | 124     | `opened-then-silent`    | `null`                                |
| read-then-left        | 124     | `read-then-left`        | `{engaged:false,elapsedMs:11,…}`      |
| **engaged-then-left** | **130** | **`engaged-then-left`** | **`{engaged:true,elapsedMs:4242,…}`** |

**The property TypeScript said does not exist is read, and its value reaches the
agent's stdout.** Re-driven identically after the refactor.

### ⛔ And the finding that matters more than the verdict: `pageServed` is the SILENT TWIN

`pageServed` is a `let` initialised to `false` and written only in the `GET /`
handler — **the same shape, the same blindness, and NO diagnostic at all.**
Probed with `const t: never = pageServed` at the read site: _"Type 'false' is
not assignable to type 'never'"_. The compiler holds the literal type `false`,
so **by its model `observed` is ALWAYS `"never-opened"` and the other three arms
are unreachable.** Nothing reddens, because a wrong belief about a boolean is
not a type error.

⛔ **Had `852` been fixed with a `!` or an `as Departure`, the audible half
would have gone quiet and the inaudible half would have stayed — and the fix
would have looked complete.** The `never` was the audible half of a two-variable
problem. The fix is one parameter boundary
(`classifyDeparture(pageServed, departure)`, on `shouldIdleClose`'s pure-helper
model, which this same file already imports), and it closes both.

### ⚠ The arm the compiler pointed at was the one arm no test drove

`b4 — a departure is observable through a pipe` covers `never-opened`,
`opened-then-silent` and `read-then-left` end to end. **`engaged-then-left` had
no cell.** It is now pinned by five unit cells and by drive d above.

---

## 2 · ⭐ The reachable-`undefined` list, and the contrast with Phase 1's empty one

R3's stated deliverable. **Read one at a time. Reachable count: ZERO — and the
reason is NOT Phase 1's reason, which is the finding.**

| site                        | class   | shape                                                           | reachable?                                                     |
| --------------------------- | ------- | --------------------------------------------------------------- | -------------------------------------------------------------- |
| `review.ts:238`             | TS2345  | regex **MANDATORY group** (`/-p(\d{2,5})$/`)                    | **no** — one alternative, group not optional                   |
| `review.ts:852`             | TS2339  | ⛔ **not an absence at all** — CFA closure blindness            | **the value is never `undefined`; the TYPE was wrong**         |
| `review.test.ts:80`         | TS2532  | `arr[0]` whose precondition is asserted **nowhere**             | **no** — the fixture holds exactly one well-formed block       |
| `review.test.ts:210`        | TS18048 | **Bun API shape** — `stdin` optional on a spawn                 | **no** — the branch's own condition set the option to `"pipe"` |
| `review.test.ts:211`        | TS18048 | same                                                            | **no**                                                         |
| `review.test.ts:238`        | TS2345  | **Bun API shape** — `stdout` is `number \| Stream \| undefined` | **no** — every spawn in the file passes `"pipe"`               |
| `review.test.ts:380`        | TS2345  | `arr[0]` guarded in the **SAME CELL**, one line up              | **no** — `expect(lines).toHaveLength(1)` immediately above     |
| `release-serve.test.ts:212` | TS2322  | `.filter()` that **already guards** but does not narrow         | **no** — mandatory group, and `ref &&` was already there       |

### ⚠ The contrast Phase 1 asked for, and it is not the one Phase 1 predicted

Phase 1's warning was: _"'Zero reachable' is a claim about 41 of 584 errors in
TOOLING — code that walks trees with its own loop bounds. The three big backends
are 404 errors of request handling and state, where an index comes off a wire
payload rather than a `for` bound. Inherit the TABLE, not the zero."_

**Digestify is the first BACKEND area, and its zero came from three shapes Phase
1's table does not contain:**

| shape                                                       | sites | Phase 1's table? |
| ----------------------------------------------------------- | ----: | ---------------- |
| regex MANDATORY group                                       |     1 | ✅ yes (9 there) |
| `arr[0]` guarded in the same cell / by the fixture          |     2 | partly (1 there) |
| ⭐ **BUN API OPTIONALITY** — `proc.stdin`, `proc.stdout`    | **3** | ⛔ **no**        |
| ⭐ **A `.filter()` WITH ITS GUARD ALREADY WRITTEN**         | **1** | ⛔ **no**        |
| ⭐ **A WRONG TYPE, NOT AN ABSENCE** (CFA closure blindness) | **1** | ⛔ **no**        |

⭐ **And here is the part that generalises.** Phase 1 warned that a backend's
indices come off **wire payloads**. Digestify handles wire payloads all day —
`POST /submit`, `POST /left`, `POST /cancel` — and **not one of its eight errors
is a wire-payload index.** The reason is architectural and checkable: the
`/left` handler reads its body as `Partial<Departure> & { sessionId?: unknown }`
and **validates every field with a `typeof` before storing it**
(`typeof b.elapsedMs === "number" ? b.elapsedMs : null`), so the wire never
produces an unchecked index. **Where a backend parses its input at the boundary,
`noUncheckedIndexedAccess` has nothing to say about the wire.**

⚠ **So the honest inheritance for Phases 3 and 4 is neither Phase 1's zero nor
its prediction: it is "look at whether the area validates at the boundary."**
Digestify does, and got a zero. An area that does not will be where the
reachable ones are — and the shape to hunt is **an index taken from a payload
BEFORE a `typeof` check**, not a big error count.

⚠ **And one shape Phase 1 could not have predicted at all: `review.ts:852` is an
error whose diagnosis is in the COMPILER, not the code.** Nothing in the table
triages that. The tell is `never` on a `let` assigned inside a callback, and
Phase 4's three big daemons are built entirely from callbacks.

---

## 3 · The fix idiom for SHIPPED code, decided and recorded

Phase 1's answer was `grimoire/lib/must.ts` — throw naming the invariant. ⛔
**It does not transfer**, structurally (`src/` does not import `grimoire/`;
`src/kit/` is a leaf) and — the reason that decided it — **substantively: a ward
that crashes gets repaired within the hour, a daemon that crashes is an
outage.** Full rule table in **T22**. The short form:

- **A ward**, absence impossible → `must()`. Unchanged.
- **Shipped code, and the function already publishes an answer for the shape →
  THAT ANSWER, with the invariant stated in a comment.** `review.ts:238` is the
  worked example: `parsePortFromSessionId` already returns `null` for "that is
  not a port" at two other returns, and the session-id port is a _recovery
  hint_. A throw would kill a review over a strange `--session-id`.
- **Shipped code with no such answer** → a named throw, having first asked
  whether the function should have an answer.
- **A test file under `src/`** → a **LOCAL** `must()` copy, on T11's own
  `scripts/instruments/*` precedent.

⭐ **And 238's fix is behaviourally FREE, which is what makes it safe rather
than merely defensible:** `parseInt(undefined)` is `NaN`, `NaN >= 1` is false,
so the range check already returned `null` on that input. Nothing moves.

⛔ **`must` was NOT added to `src/kit/`.** Adding a throw helper to the leaf
every spell imports, on the evidence of one site that did not need it, would
make the throw the default answer for the population where it is least
appropriate.

⚠ **AND THE SITE IS FOUR-WAY DUPLICATED, WAITING IN PHASES 3 AND 4.**
`parsePortFromSessionId` is byte-identical in digestify,
`imago/backend/ server.ts:111`, `magpie/backend/server.ts:117` and
`bounty/backend/ server.ts:326`, **with the same error in all four.** ⛔
Promoting it to `src/kit/` was deliberately not done: **that is the D64 move** —
one de-duplication lowering four counts with nothing established. Filed.

---

## 4 · Nine drives — every touched ward cell seen RED

⛔ Two of the four touched files are wards over a security boundary, so a type
fix can change what they **catch**. A cell that still passes is not evidence.

| #   | subject                                          | mutation                                                                                   | result                                                                                                                                                  |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `release-serve.test.ts` — served-source exposure | delete `if (rel === "index.html") return null` from `serveDist`, **rebuild**               | **RED** — `Expected: 404 / Received: 200`, exactly the leak the cell was written for                                                                    |
| 2   | `linkedChunks()` (the whitelist)                 | force it to return `[]`                                                                    | **RED ×3** — content-type, INVENTORY **and** case-variants; the helper is load-bearing for three cells and none is vacuous                              |
| 3   | `linkedChunks()` — **set parity**                | run HEAD's expression and this branch's side by side                                       | **BYTE-IDENTICAL** — `["index-ty4gdnpw.css","index-dfcfc4w0.js"]`, and zero `undefined` in the raw group population                                     |
| 4   | `must(proc.stdin, …)`                            | spawn `stdin:"ignore"` while `stdinText` is defined                                        | **RED in 0.73 ms**, by name — where HEAD starved the subprocess and failed 5 s later as _"didn't print ready line"_, blaming the daemon for the harness |
| 5   | `readStdout`'s `ReadableStream` guard            | spawn `stdout:"inherit"`                                                                   | **RED**, by name (`got undefined`) — ⚠ and it took two tries: the first cell chosen never reads stdout, so **a drive is cell-specific**                 |
| 6   | `must(questions[0], …)`                          | suppress `questions.push` in `review.ts`                                                   | **RED in 0.26 ms**, by name                                                                                                                             |
| 7   | `must(lines[0], …)`                              | make the daemon write nothing to stderr, **rebuild**                                       | **RED — on the `toHaveLength(1)` one line ABOVE.** The sibling guard convicts first, so the `must` is a restatement, exactly as its comment claims      |
| 7b  | `must(lines[0], …)` — reachability               | same, with the `toHaveLength` guard **removed**                                            | **RED**, by name — so the throw is not dead                                                                                                             |
| 8   | `classifyDeparture` ×3                           | arms swapped · `pageServed` gate dropped · `opened-then-silent` folded into `never-opened` | **3 red / 1 red / 1 red**, each reddening **only** its own arms — five discriminating cells                                                             |
| 9   | the **LOWERED** pin                              | append one deliberate error to `review.ts`                                                 | **`ROSE — area "src/digestify/backend" 0 -> 1 (+1)`** — the new zero convicts                                                                           |

⭐ **Drive 7 is the one worth reading twice**, and §5 is why.

**Population parity:** `review.test.ts` 43 → 48 cells (+5, the
`classifyDeparture` block), `release-serve.test.ts` 15 → 15. **None lost.**
`bun test src/digestify`: **158 pass / 0 fail**, 469 expect() calls, 12 files.

---

## 5 · ⛔ The hazard Phase 1 could not have found: calibration reads `dist/`

**Drive 7 came back GREEN when it should have been red, and the drive was
measuring nothing.** The mutation was correct and the cell is correct. The cell
**spawns the LAUNCHER**, which imports
`plugins/spellbook/skills/digestify/dist/ review.js` — `review.test.ts`'s own
header says so at length, for a completely different reason (playbook Phase B,
B6.1). Re-run with `bun run build` between the mutation and the test: **red**.

⛔ **A green is normally evidence. Here it was the absence of a subject** — the
`dist-roster-ward` vacuity of T18, and D64's shrinking denominator, arriving in
the **calibration** rather than in the ward.

⚠ **Phase 1's subjects were `grimoire/` and `scripts/`: run directly, no
`dist/`. Phase 2 is the first phase whose subject is a built entry, and every
remaining phase's is too** — astrolabe, magpie, glamour, bounty, imago and
grapevine all ship a built backend. **Contract 18 governs committing the
artifact; nothing warned that calibration reads it.**

⚠ **And the two kinds of cell live in the same file.** Drive 6's cell imports
`parseQuestions` from `./review.ts` directly and needs no rebuild; drive 7's
spawns a launcher and does. Recorded as **T23**.

---

## 6 · The ratchet's fall path, as its SECOND user

**The FELL message, as printed, before the baseline was touched:**

```
FELL — area "src/digestify/backend" 8 -> 0 (-8). Good news, and THE BASELINE IS
NOW STALE: lower it to 0. ⛔ First establish that 8 error(s) were FIXED and not
silenced — an `arr[i]!`, an `as any`, a `@ts-expect-error`, a deleted file, or a
de-duplication that hid an indexed read behind a parameter (D64) all lower this
number with nothing fixed.
```

`11 pass / 2 fail` — the movements cell and, separately, the arithmetic cell.
**Identical to Phase 1's, in both cells and both deltas. The mechanism works.**

### ⛔ And that is the problem: T15's three corrections were recorded and NOT applied

The sentence above is **byte-identical to the one Phase 1 quoted**, including
the gap Phase 1 filed as correction #1: _"it asks for an account and names
nowhere to put it."_ **Phase 2 received the same sentence.** That is the
predicted failure of a correction that lives in a journal instead of in the
instrument. Two are now in the code (**T24**):

1. ✅ The FELL sentence now says _"lower it to 0, **AND WRITE THE ACCOUNT IN THE
   COMMENT BLOCK ABOVE `DECLARED_BASELINE`**"_.
2. ✅ The census's warning block now says a green means nothing about the FILE
   COUNTS (`filesExamined` and `filesInTree` are asserted equal to each other,
   so a file added while fixing closes the pair silently — Phase 1's `must.ts`,
   grimoire 20 → 21, nothing red). Phase 2 added no file, so **545 of 545** is
   unchanged; the inheritance is in the ward now regardless.
3. ⚠ Not applied — _"a grep is not a second opinion, it is a second predicate."_
   No code can hold it.

### ⭐ Two silencing routes the FELL sentence did not name, and Phase 2 took both

The list was `arr[i]!` · `as any` · `@ts-expect-error` · a deleted file · a D64
de-duplication. **Two of Phase 2's eight fixes are outside it:**

- **A `.filter()` TYPE PREDICATE** (`(ref): ref is string =>`). It lowers the
  count by asserting to the compiler. Honest at `release-serve.test.ts:212`
  **only because the runtime clause `ref &&` was already there and was left
  untouched** — proven by drive 3's byte-identical set. Added without that
  clause it is `!` with extra steps.
- **A VALUE MOVED ACROSS A FUNCTION BOUNDARY** into a non-optional parameter —
  `classifyDeparture`. **An extracted helper launders a genuinely-absent value
  exactly as well as it launders a false narrowing.** It is honest here because
  the absence was the compiler's error and the behaviour is pinned by drives at
  both ends.

Both are now in the FELL sentence. The FELL path was re-driven after the message
edit and the ROSE direction was calibrated against the lowered pin (drive 9).

### The deliberate lowering

`src/digestify/backend: 8 → 0`, `DECLARED_TOTAL: 543 → 535`, with a
re-declaration account above the pin answering the FELL sentence **route by
route** — no `!`/`as any`/`@ts-expect-error`/`?? `, **no file deleted**, **no
file added** (unlike Phase 1, so `filesInTree` does not move), **no D64
de-duplication** (T22, the four-way duplicate left alone), and the two new
routes argued rather than hidden.

Ratchet after: **13 pass / 0 fail**, 535 errors in 57 files (tsc's own total
535), 32 areas of 32 measured, 545 files of 545 examined, **18 areas at ZERO**
(was 17).

### One thing to correct, in Phase 3's interest

⚠ **The FELL sentence is now long.** It names seven routes and a destination in
one paragraph, and Phase 3 will read it in a terminal. If an eighth route is
found, the sentence should probably become a pointer to a ROUTES block in the
file rather than growing again — **but not before someone has actually taken an
eighth**, because the reason this one grew is that Phase 2 took two.

---

## 7 · What the measurements contradict

- ✅ **8 errors, 3 files** — exact, and the brief's per-line table reproduces
  row for row.
- ✅ **Two in shipped code, six in test files** — exact.
- ✅ **`src/digestify/surface` is 0** — the surface owns `useReview.ts`'s
  beacon, the other half of the `/left` seam, and it is clean.
- ⛔ **The brief's premise that `review.ts:852` might be DEAD CODE does not
  hold**, and the way it fails is the phase's most transferable output: the
  error's diagnosis is in the **compiler**, not the code, and its silent twin
  had no error at all.
- ⚠ **"The six test-file errors are mostly Bun API shapes (`proc.stdin` is
  optional on a spawn)"** — correct for **three** of the six (210, 211, 238).
  The other three are an unasserted `arr[0]` precondition, an `arr[0]` guarded
  one line above by an `expect` the compiler cannot read, and a `.filter()`
  whose runtime guard was already written. **"Mostly" is right; the residue is
  three different shapes.**
- ⚠ **Phase 1's "the 404 big-backend errors index off wire payloads"** is not
  refuted — **but digestify handles wire payloads all day and produced zero such
  sites**, because it `typeof`-validates every field at the boundary. §2 argues
  what to inherit instead.
- ⚠ **`src/kit` is still 1**, and it is `serveDist.ts:153` — **the same
  `(string | undefined)[]` shape as `release-serve.test.ts:212`, in the module
  the test drives.** Left alone: `src/kit/` is not this phase's area and a
  single-error area is not worth a cross-area commit. Its fix is already
  written, one file over.

---

## 8 · Gate

- `bunx tsc --noEmit`: **535** errors (was 543). `src/digestify/backend` **0**,
  `src/digestify/surface` **0**.
- `bun run gate` **unpiped**, exit read from a file: **exit 0**.
- `bun scripts/dist-check.ts`: exit **0** — 8 spells, 40 tracked / 40 on disk,
  ARM 2 reproduction clean.
- `bunx biome check --write` on every changed `.ts`.
- **Build only ever through `bun run build`**; `dist/review.js` committed in the
  same chapter as its source (Contract 18).
- Repo root clean; no empty directories.
