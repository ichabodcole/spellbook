# cassandra — verify lane: the non-author on S3 and S4, the acc arm, and the local-sim

**Seat:** cassandra (verify) · **Card:** `gc-lane-cassandra` · **Plan of
record:** [`../plan.md`](../plan.md) @ `95dc287` · **Authored:** 2026-09-03,
ratified as of comms `#1130`

**Builds against:** the **CORRECTION** blocks of **S3** (deployed identity,
three clauses) and **S4** (`release-serve.test.ts` with the forced-dev cell),
the **verification gate** (including the acc characterization arm), and **S2**
only as a consumer — `mode` on both transports is what T3 and T4 assert; I build
none of it.

**Authorship split, so nobody re-derives it:** circe **authors**
`release-serve.test.ts` (#1128); daedalus **builds** `resolveMode()` + the
dev-only import + `mode` on the ready event and the discovery JSON (#1129,
recorded by prospero #1130). **I author no shipped cell in this port.** Every
task below is a measurement with a positive control, run as the non-author, in a
detached worktree, published as rows. Where a task finds a cell that cannot
fail, the finding goes back to its author with the mutation named (H16); I do
not relabel or repair it.

**Isolation, read in source this session (the epitaph's trigger):** glamour's
daemon resolves through `tmpdir()/glamour-latest.json` and `cli.ts:147` selects
`glamour-<session>.json` only when `--session` is passed. So `GLAMOUR_HOME`
isolates the **data** and not the **daemon**. Every drive below passes
`--session cass-gc-<task>` **before** any `--` and relocates `TMPDIR` for the
local-sim. The seat doc's discriminator table lists glamour as _no home var at
all_; that row is stale — `server.ts:68` reads `GLAMOUR_HOME` — corrected at
finalize, not here.

---

## T0 — Baseline at join, before anything relocates (DONE, rows below)

The pre-fix arm of every S3 clause has to be taken **while the predecessor still
exists**, or the post-port "absent" reads as vacuous. Taken in a detached
worktree at `95dc287` with `node_modules` symlinked in.

| reading                                                                           | value at `95dc287`                                                                                                                 | why it matters                                                                    |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `git ls-files plugins/spellbook/skills/glamour \| grep -c '/surface/'`            | **25**                                                                                                                             | S3 clause 3's pre-fix arm — the count that must go to 0                           |
| `git ls-files plugins/spellbook/skills/glamour \| grep -c bunfig.toml`            | **1**                                                                                                                              | same clause, the second file that must leave                                      |
| `git ls-files plugins/spellbook/skills/glamour/dist \| wc -l`                     | **0**                                                                                                                              | dist-roster-ward's pre-fix arm; the `.gitignore` un-ignore lines do not exist     |
| `bun scripts/dist-check.ts --no-build`                                            | exit 0, **4** buildable spells, 14 tracked                                                                                         | must become **5**, and 5 alone is half a check (S3 correction)                    |
| `grep -rn 'src/' plugins/spellbook/skills/glamour/scripts/`                       | **0** hits                                                                                                                         | S2's invariant is _exactly one_ post-port; today there are none                   |
| ward 1a pinned inventory, glamour entries                                         | **0** (`import-boundary-wards.test.ts:288` list)                                                                                   | post-port it gains exactly one, and I `existsSync` it by hand (ratify finding)    |
| `import-boundary-wards.test.ts:1089` pins `glamour/scripts/server.ts` **line 77** | still line 77 (acc did not touch `server.ts`)                                                                                      | any insert above it false-reds; expect this during Phase 1                        |
| `acc check scripts/cli.ts --config-dir .` from the spell dir, kit **0.1.11**      | exit **0**, `conformant:true`, L0, core 16/17 passed, 1 unverified (D3), knownFailures 0                                           | the characterization **before** arm; saved as `acc-before.json` in scratch        |
| full suite in the worktree                                                        | **1568 pass / 0 fail / 4545 expect / 119 files**, 148.6s (#1133); 119 tracked `*.test.ts` = 119 ran; matches circe's main-tree run | the `files` denominator is two-sided (seat doc); 1539 (#1122) is the pre-acc tree |

---

## T1 — S4 non-author calibration of `release-serve.test.ts` (after circe lands it)

**Subject:** `plugins/spellbook/skills/glamour/tests/release-serve.test.ts` at
circe's landed sha. **The claim under test is not "the file exists" — it is that
each cell reds on the world it was written to convict.** My ratify (#1122)
measured that the relocation converts `server.ts`'s load-time surface import
into an unreachable dev branch, and the full suite then reports the exact
baseline against a nonexistent `src/glamour/surface/index.html`. This task
proves the new file closes that.

**Method (the seat doc's calibration craft, verbatim):**
`git worktree add --detach <dir> <sha>`, `node_modules` symlinked; print the
applied diff **before** each run and a reverted-check after; cite
`pass / fail / cells`, reconciled against the cell count in the real tree
(**H21**: a copy under-reports cells — 46 vs 30 at one HEAD — so the worktree
count is the denominator and I also run one arm in a `git archive` copy and
report both numbers).

| arm | mutation (applied in the worktree only)                                                                                    | expected                                                                                                                                                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C   | none (control)                                                                                                             | green; every cell name listed                                                                                                                                             |
| M1  | `resolveMode()`: drop the `dev` arm of the `SPELLBOOK_SURFACE_MODE` override                                               | **forced-dev cell red** as `still-running` or exit 0 — the astrolabe cell's own stated mutation                                                                           |
| M2  | make the daemon serve `dist/` regardless of mode (bypass the dev branch entirely)                                          | **forced-dev cell red**; `GET /` cells stay green — proves the cell tests the branch, not the serve                                                                       |
| M3  | delete the board route (`/` → fall through)                                                                                | **"GET / serves dist/index.html" red** — the exact absence `daemon.integration.test.ts` was blind to at ratify (16/0 with the route deleted)                              |
| M4  | rig fixture: remove `dist/index.html` from the copied tree                                                                 | `mode === "release"` precondition fails **first and alone**, naming the mode — not a cascade of 404s                                                                      |
| M5  | rig fixture: leave `surface/` present in the copied tree                                                                   | the `existsSync(surface) === false` precondition reds — the cell must refuse to measure a tree that still has the predecessor                                             |
| M7  | move the discovery-file write ABOVE the dev-branch import (daedalus #1140: the daemon dies at the await, before the write) | only the `discovery file absent after the forced-dev death` assertion reds — proves that assertion is that one and not a side effect                                      |
| M6  | change the dev-branch specifier to a **different** nonexistent path                                                        | forced-dev cell **still red** but the `toContain("src/glamour/surface/index.html")` assertion is what fails — proves the cell names the real successor, not "any failure" |

**Ask which cell reddens, never only whether the suite went red** (seat doc,
sprint 01). A mutation that reddens the wrong cell is a finding about the cell's
title. A mutation whose diff is empty is not a run (M7 scar, acc L0 lane E).

**Also asserted in the same pass, because the file is a copy of two
precedents:** glamour's rig copies `scripts/` **and `shared/`** (imago's earned
cell — a release tree missing `shared/` does not boot after S1), and `mode` is
read from **both** transports — the stdout handshake / discovery JSON _and_ the
`ready` event — since daedalus is building both (S2 correction, item 1). A cell
that reads one transport certifies half the contract.

**Output:** one comms message, headline = the pass/fail/cells table across arms;
per-arm `git diff --stat` lines in the body. If any arm does not red, the card
bounces to circe with the mutation named; **I do not repair it** (H16 is
measured by bounced cards, so a quiet repair would also destroy the
measurement).

---

## T1b — the `TMPDIR` pointer finding (measured, closed at `9f2cbd4`)

circe's cold read said the integration test scopes only `GLAMOUR_HOME`. Measured
(#1166): a planted live `glamour-latest.json` was **deleted**, not overwritten —
the daemon claims the pointer at boot with its own id, so the close-time
ownership check matches and unlinks. Fixture line folded into Phase 1 by
daedalus; at `9f2cbd4` the planted pointer is byte-identical after a 16/0 run
(`tools/obs3-pointer.sh`). The spell-side fix (pointer under `GLAMOUR_HOME`,
five spells) is filed with this as its evidence line.

## T2 — S3 non-author: the three-clause done-when, run by hand at the assembled sha

The plan's correction says the operable invariant is the **file list**, and that
_successor present_ is half a check. Nothing in the suite asserts the other half
(ratify: I planted `surface/` into a shipped spell and the whole gate stayed
green). So this is a **recorded hand-run with published rows**, not a cell —
mechanising it is on the lead's unruled list, and the recommendation is in _Open
items_ below.

Run at the sha the lead names for assembly, in a detached worktree, from the
repo root:

```sh
G=plugins/spellbook/skills/glamour
# clause 1 — predecessor ABSENT from the TRACKED subtree (pre-fix arm: 25 and 1)
git ls-files $G | grep -c '/surface/'            # expect 0
git ls-files $G | grep -c 'bunfig.toml'          # expect 0
# clause 2 — successor PRESENT and TRACKED (pre-fix arm: 0)
git ls-files $G/dist | wc -l                     # expect ≥ 1, and index.html among them
git ls-files $G/dist | grep -c '^.*/index.html$' # expect 1 — Contract 2: the entry is UNHASHED
grep -c "^\!$G/dist" .gitignore                  # expect 2 — the hand-kept un-ignore lines
# clause 3 — nothing on the release path resolves src/ (S2: exactly one, in the dev branch)
grep -rn 'src/' $G/scripts $G/shared | grep -v '^\s*//'   # expect exactly 1 line, in server.ts
# identity, not count — the deployed folder IS the stated list
git ls-files $G | grep -v '^plugins/spellbook/skills/glamour/dist/' | grep -v '/tests/' | sort
```

The last command's output is diffed against the post-port list the S3 correction
states —
`SKILL.md · scripts/{cli,server,persist.server,styles.server,imageOptimize.server,reduce}.ts · shared/{types,imageOptimize}.ts`
— plus `acc.config.json` and `tsconfig.json`, which are tracked today and the
correction does not mention. **If the diff is non-empty, the list is wrong or
the tree is; either way it is reported as a diff, not a count.**

Clause 1 is now **also a cell** — `dist-roster-ward`'s "S3 clause 1" (daedalus,
`513ba9b`), population `roster()`, so it turns on for glamour when
`src/glamour/surface/index.html` exists. The hand-run stays as the arrival check
with the pre-fix arm.

Then the two instruments the plan names, each with its exit printed unpiped:

```sh
bun scripts/dist-check.ts --no-build             # expect exit 0, buildable spells 5, glamour ≥1 tracked
bun test grimoire/dist-roster-ward.test.ts       # the in-suite half of the same arms
```

And the ward-1a hand check my ratify found missing — the pin compares
**strings**, so a pinned escape whose target does not exist stays green:

```sh
# every pinned dynamic escape's resolved target must exist; glamour's is the new one
bun -e 'import {existsSync} from "node:fs"; …'   # written at run time against the PINNED_DYNAMIC_ESCAPES entries, printed one row per entry with true/false
```

**Positive control for clause 1, run in the same worktree:**
`git checkout 95dc287 -- $G/surface` re-plants the predecessor; the two
`grep -c` lines must go back to 25 and 1 **and every other instrument above must
stay green** — which is the finding, restated as a measurement: nothing but
clause 1 sees a copy-not-move.

---

## T3 — The local-sim: the installed artifact at a destination that never ran `install`

The gate's third sentence, and the playbook's Phase 3 — _"manual and nothing
automates it. Write the result down or it will not be run twice."_ Recipe from
`sk-1a-sim` / `sk-1c-sim`, re-grounded for glamour's discovery shape.

```sh
SIM=$(mktemp -d /tmp/glamour-sim.XXXX)            # /tmp, not the scratchpad: nothing up-tree may hold node_modules, package.json, bunfig.toml
ls ~/.bunfig.toml 2>/dev/null                     # the global one is invisible to a parent walk — state whether it exists
git archive <sha> plugins/spellbook/skills/glamour | tar -x -C "$SIM"   # the TRACKED subtree, what the marketplace copies — never a working-tree cp
cd "$SIM/plugins/spellbook/skills/glamour"
find . -name node_modules -o -name package.json -o -name bunfig.toml -o -path '*/surface/*' | wc -l   # expect 0
export TMPDIR="$SIM/tmp" GLAMOUR_HOME="$SIM/home"; mkdir -p "$TMPDIR" "$GLAMOUR_HOME"
bun scripts/cli.ts --session cass-gc-sim open --no-open --title sim --intent logos > open.json; echo "exit=$?"
```

Then, in order, each printed unpiped:

1. **`mode` on both transports.** `cat "$TMPDIR/glamour-cass-gc-sim.json"` must
   carry `mode: "release"`; `curl -sN <url>/events?since=0 | head -1` must be a
   `ready` frame carrying `mode: "release"`. **A board that looks right is not
   the assertion** — a dev daemon with root deps renders the same pixels.
2. **The surface serves from `dist/`.** `curl -s <url>/` contains the hashed
   `chunk-*.js` href; `curl -sI <url>/<that chunk>` is 200 with the right
   content type;
   `curl -s -o /dev/null -w '%{http_code}' <url>/../scripts/server.ts` is 404.
3. **The board renders, driven.** Playwright (`browser_navigate` → snapshot →
   one `say` through the composer → `/state` shows it). Styling by
   **remove-it-and-diff**, not by byte count: computed-style diff of N elements
   with the stylesheet present vs blocked; the seat doc's floor for a page with
   no inline `<style>` is 0/44, so any non-zero delta with the sheet present is
   the styling working and a zero is an instrument defect until proven
   otherwise.
4. **The CLI contract at the destination.** `--version` →
   `{name:"glamour",version}`; `--help` exit 0; `bogus-verb` → one JSON envelope
   on stderr, stdout empty, exit **2**; `state --session cass-gc-sim`
   round-trips.
5. **Control that can fail:** `rm dist/index.html`, re-open under a new
   `--session` → the daemon must **die** (dev branch, unresolvable `src/`
   import) — it must not silently serve nothing at exit 0. Print the exit and
   the stderr line naming `src/glamour/surface/index.html`.
6. `close --session cass-gc-sim`; then `ps -o pid=,command= | grep '[g]lamour'`
   must show **only** processes under `$SIM` — Cole's live daemons on the real
   path are triaged by **path, never by age** (seat doc), and killed by exact
   PID only.

**Recorded where it survives:** the rows go in the comms message, and the
one-line verdict goes in the land's commit message body per the playbook.

---

## T4 — The acc characterization arm (this port's alone)

Before-arm taken in T0 (`acc-before.json`, exit 0, conformant L0, kit 0.1.11).
After the relocation, at the assembled sha, from the spell directory exactly as
the acc session ran it:

```sh
cd plugins/spellbook/skills/glamour
bunx acc version                                          # must print 0.1.11 — a kit drift makes the diff meaningless
bunx acc check scripts/cli.ts --config-dir . --format json > acc-after.json; echo "exit=$?"
```

**Exit 9 is the only "not conformant"; 0 is conformant; anything else is the kit
failing and is reported as a kit failure, never folded into either verdict**
(plan, verification gate). Then the diff that matters is **rule by rule**, not
the verdict line:

```sh
jq -S '.data | {conformant, level, counts, findings: [.findings[] | {rule, status}]}' acc-before.json > b.json
jq -S '.data | {conformant, level, counts, findings: [.findings[] | {rule, status}]}' acc-after.json  > a.json
diff b.json a.json; echo "diff exit=$?"                   # 0 = the port moved nothing acc can see
```

A non-empty diff is a legitimate result **if the port names what it changed**
(plan). The plan's invocation names the repo-relative `cli.ts` path with
`--config-dir plugins/spellbook/skills/glamour` and says _run from the spell
directory_; I run it the way the session doc recorded it (spell dir, relative
paths) and report the cwd, so a difference between the two invocations shows up
as a difference and not as a silent choice.

**Not run here:** the recorded-surface census (acc step 5). It was completed the
same day as L0 and is not in the gate; re-running it is a follow-on if the
after-arm diff is non-empty.

---

## T5 — Gate at close, and the session's delta

`bun run gate` **unpiped to a file**, then read the file; cite
`pass / fail / files` and reconcile `files` against
`git ls-files | grep -c '\.test\.ts$'` (both directions — an untracked test that
executed also moves it). `bun scripts/dist-check.ts` exit 0 counting five. Delta
against T0 posted as a table. H21's number: the release-serve cell count in the
worktree vs in a `git archive` copy, side by side.

---

## What this lane does NOT do (stated, so the absence is legible)

- **Author the release-serve test, the daemon's mode, or any ward.** Those are
  circe's, daedalus's, and thoth's. My output on each is a bounce with a named
  mutation or a clearance with the rows.
- **Build the move-vs-copy cell or the ward-1a `existsSync` guard.** Both are on
  the lead's unruled list; T2 runs each by hand and publishes the rows. See
  below for what I recommend.
- **Fix the css-scope ward's phantom `32`.** It reds on arrival blaming
  astrolabe; that is a filed ward defect, and I will say so on the wire the
  first time it reds rather than let it be read as glamour's.
- **Run `bun run gate` on the shared tree while a peer is mid-relocation.**
  Every measurement above is at a named sha in a detached worktree; the one gate
  I run on the shared tree is my own land, announced with the observation (`ps`
  shows no other `bun test`), not the intent.

## Open items for prospero (asks, not decisions)

1. ~~**Mechanise S3 clause 1 or file it?**~~ **RULED BUILD (#1145), built
   (`513ba9b`), calibrated.** Recommendation: one cell in
   `grimoire/dist-roster-ward.test.ts` — for every spell in `roster()`,
   `git ls-files plugins/spellbook/skills/<spell>` contains no `/surface/` path
   and no `bunfig.toml`. Population-derived, tree-only, no build, and it is the
   exact instrument that was missing when a copy-not-move was literally true of
   this tree. Owner if built: whoever owns `dist-check.ts` (daedalus built it;
   thoth wards). If filed, T2's hand-run is the record.
2. **Ward 1a `existsSync`** stays filed unless you rule otherwise; T2
   hand-checks it for glamour's one entry.
3. ~~**`s5-cal` sits in `doing`**~~ **RULED move (#1145); moved to `todo` with a
   dated PARKED prefix, title and notes read back byte-identical (#1147).**
