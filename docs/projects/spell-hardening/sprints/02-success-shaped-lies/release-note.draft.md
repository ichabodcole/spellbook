# Release note — DRAFT

**Status: DRAFT, and every figure below is `UNVERIFIED` until re-checked against
what actually shipped.** Drafted by `prospero` while the ward and P0c's cold
gate were still running, so that **the counts are not improvised at release
time** — which is where this project's own defect class recurs.

**Two beats are NOT yet discharged and their results may change lines here:**
thoth's ward (16/16) and cassandra's cold gate of P0c at `e7504cf`.

> **The honesty rules this note is written against live in
> [`plan.md`](./plan.md)'s Release section (rules 0, 0a, 0b, 1–4).** Read them
> before editing a number here.

---

## Lead with the harm, not the mechanism

> **`bounty close --help` used to CLOSE YOUR BOARD.** `--help` was unrecognised,
> the hand-rolled parser discarded it, and the verb ran anyway. `state --help`
> dumped the board; `tail --help` opened the stream and never exited. **The
> three verbs that refused did so by accident** — they demanded a positional.
>
> **It no longer does.**

**Not** _"unknown-flag rejection now works across the house"_ — that implies we
built something that mostly already existed, and **reads as false to anyone who
greps** (10 of 16 entry points were already conformant).

---

## What shipped, per lane, saying WHICH HALF

| lane    | what it is                                                                                                                                                                       | what it does NOT reach                                                                                                                      |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0b** | `bounty open` **refuses** rather than silently discarding `--restore`, `--timeout`, `--title` on the idempotent-attach path. Exits 2, carries `restoreSkipped` present-and-null. | **Names no corrective verb** — deliberate; the obvious suggestion destroys the user's snapshot (#73).                                       |
| **P0d** | Writes report **whether they applied**. `bounty add` checks `applied`; `/cmd` in glamour · imago · magpie returns a **verdict** instead of an unconditional `ok:true`.           | The verdict means **"was the type RECOGNISED"**, _not_ "did state change". The narrower contract is **named and left unclaimed**.           |
| **P0f** | `tail` **drains its terminal frame before exiting**, at five sites — bounty · astrolabe · glamour · imago · magpie.                                                              | **Only the five `tail` pairs.** The ~30 other in-function exits, the SIGINT handlers, and `bounty/join.ts`'s hang are **filed, not fixed**. |
| **P0c** | **Six hand-rolled parsers replaced** with `node:util` `parseArgs` at **parser altitude**: `--key=value` support, unknown-flag **rejection**, and a `--` terminator.              | **6 converted · 10 already conformant · 16 total.**                                                                                         |

**⚠ The `--flag=value` half was silently corrupting writes, and it was live:**
`add "write the --draft section"` stored the title as **"write the"**;
`message "fix the --stdin handler later"` **deleted two words from the middle of
a sentence and flipped a real behavioural flag.** Both exited 0. **`--` is not a
new convention; it is the fix for a live corruption.**

**⚠ `glamour style-archive --restore` is renamed `--unarchive`.** The old flag
had **no correct type** — boolean in one verb, string in another, both published
in `SKILL.md`. The rename also kills a live bug: `--restore foo` **archived**
instead of restoring, exit 0.

---

## PINNED vs VERIFIED — a test prevents regression tomorrow, a drive proves it today

**P0f: `2 pinned · 3 driven`.**

- **PINNED** (red-pre-fix cell, mutation-verified): **bounty · astrolabe**
- **VERIFIED BY DRIVE, NOT PINNED**: **glamour · imago · magpie** — 65536
  pre-fix, complete post-fix, precondition valid at each. **No CLI-process
  harness exists in those three**; building one is explicitly out of scope.

**Do not write "5 of 5 gated."** Five sites are **fixed**; **two** are pinned.

---

## The flake comparison — and the only comparative sentence it supports

> **The pre-P0d suite passed 4 of 4 full runs at `8f4d92d` (1304 tests / 101
> files each). The post-P0d suite failed 1 of 4, in
> `imago > marksUnseen freshness flag`. Both are four-run samples; they differ
> by one observation and we are not claiming a rate change.**

**No percentage. No "P0d made it worse."** The difference **points toward P0d
having introduced it** — stated because it is the least convenient direction —
and **n=4 cannot distinguish that from two draws of one distribution.**

**Ambient load was NOT controlled:** 14 daemons live throughout, **12 predating
the session.** So the flake figure is **partly a statement about one machine on
one day** and **does not travel to CI.**

---

## The type table — three claims, not one

| claim                                                             | strength                                                                         |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **119 of 119** declared consistently with their consumption sites | **transcription verified** — catches a dropped or typo'd key                     |
| **13 of 119** corroborated by a genuinely independent source      | grapevine's shipped `BOOLEAN_FLAGS`, extracted **before** reading the table      |
| **106** rest on a **single derivation**                           | careful and **unfalsified — which is not cross-checked**                         |
| **100 of 119** exercised by at least one test invocation          | **confirmed by execution rather than reading**; **19 are not, 9 of them magpie** |

**⛔ Do NOT write "119 flags verified."** The lane **consumed** the artifact, so
the comparison **cannot disagree with itself**, and `strict: true` guards the
**name**, not the **type**.

**⚠ Two denominators, deliberately not merged: `119` is per ENTRY POINT
(coverage); `115` is per SPELL (documentation).** Four glamour flags are one
name in two parsers.

---

## What a fix does NOT reach

- **The discovery pointer.** `d650c97` closed the **test-side** channel; the
  **shipped-source sites remain**, and seats run the **cached** plugin copy, so
  an in-repo fix does not touch already-running daemons. **No number** — three
  counts are on record (22 · 19 · 10), none with a stated denominator.
- **A test DEPENDED on the defect.** `imago/tests/cli.test.ts` asserted the `=`
  form on **`--text`, a flag imago does not have** — it passed only because the
  old parser accepted anything. **A permissive parser lets tests accumulate
  assertions about flags that do not exist, and every one reads as coverage.**
- **The `--` terminator is DOCUMENTED NOWHERE** — 0 of 6 `SKILL.md` files
  mention it, and it is **new user-facing behaviour** that P0c introduced.
  **Bounded, and the bound matters:** the refusal message teaches it **twice**,
  inline, at the moment of failure — _"place it at the end of the command after
  `--`"_ and _"for free text containing dashes, use `--stdin`, or put it after a
  bare `--`"_ — and exits **2**. **Driven, not asserted:**
  `add -- write the --draft section` stores `'write the --draft section'`
  verbatim; the unterminated form refuses. **So it is discoverable at FAILURE
  time and not at COMPOSITION time** — which is the gap that matters for an
  agent, because `SKILL.md` is what it reads _before_ acting. **One line per
  affected spell closes it.**
- **glamour · imago · magpie document no `/cmd` envelope at all**, so `applied`
  has nowhere to land in three of the four spells P0d changed. **Absent, not
  stale** — and whether they should acquire one is out of scope.

---

## Issues

**Closable: 6 of 14** — `#77` · `#78` · `#80` · `#81` · `#83` · `#84`.

**⚠ `#80` spans BOTH sprints** — its truncation half was sprint 01, its
skipped-`--restore` half is P0b. **Cite both.** **⚠ `#77` and `#78` were fixed
in SPRINT 01 and never closed.** This release closes sprint 01's work too; a
note implying sprint 02 fixed them is false. **⚠ P0f closes NO issue** — it has
no number because this project found it.

**The other eight, each with its reason:** `#64` genuinely unexplained · `#73`
`#74` `#79` are P1, **unratified** · `#72` `#76` are P2/P3, **unratified** ·
`#82` on hold · `#85`–`#88` deliberately out of scope with the contract
investigation.

---

## ⚠ TWO BEATS ARE DOWNSTREAM OF THE RELEASE, NOT UPSTREAM — the plan lists all four as the agent's

**Found running the beats. `plan.md` lists "archive every closed backlog item"
and "comment the GitHub issues as they close" alongside beats the agent CAN
discharge — and neither can be done before Cole cuts.**

| beat                             | when                                                      |
| -------------------------------- | --------------------------------------------------------- |
| `SKILL.md` re-read               | ✅ **DONE** — 3 of 4 clean, one gap (the `--` terminator) |
| cold-gate the assembled release  | ✅ **agent-side, pending the ward**                       |
| **archive closed backlog items** | ⛔ **AFTER the release**                                  |
| **comment the issues**           | ⛔ **AFTER the release**                                  |

**The backlog audit, run anyway so the work is ready:**

- **`2026-08-05-cli-stdout-truncation-on-pipe.md`** — tracks **#77 + #78**, both
  closable. **The ONLY archivable item**, and **it is not archivable YET**:
  archiving it now marks it done **before the release that fixes it exists.**
- **Four items are explicitly _"Not among the fourteen"_ and were deliberately
  NOT folded in** — the performed-`--restore` silence, `tail`'s full-history
  replay, the machine-global discovery pointer (**Cole ruled: file, don't
  fix**), and `bounty message` leaving no durable trace. **All stay.**
- **Everything else maps to P1/P2/P3, all UNRATIFIED**, or to `#64`, which is
  genuinely unexplained. **None closed.**

> **So the honest count is: 1 backlog item becomes archivable when Cole cuts,
> and 0 are archivable now.** _Doing it early would be the release note's own
> defect class committed in the filing system — marking work done against a
> release nobody can install._

## Not for the agent

**Cole cuts the release and pushes.** The agent stages the branch and stops.
**Commenting the issues is an outward-facing act and is not done before the
release exists** — drafts are handed over, not posted.
