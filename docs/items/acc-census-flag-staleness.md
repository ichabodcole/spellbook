---
type: item
title: A recorded census goes stale on flags without anyone noticing
description:
  acc stays conformant when a census record lists a flag that no longer exists,
  or misses an output change on an existing verb; only added or removed verbs
  fail the gate. Applies to Scriptorium's default and kit censuses alike.
status: stable
lifecycle: done
id: 01a13c0d-a2e8-7086-8455-9aad6109461c
kind: chore
generated: { by: claude-opus-5-5, at: 2026-10-14 }
tags: [acc, scriptorium]
from: items/scriptorium-on-kit-daemon.md
blocked_by: [01a15b3a-2716-70a6-872a-d30f3aad2a2c]
parent: feature/workspace-kit
cycle: 2026-10-cutover
---

# A recorded census goes stale on flags without anyone noticing

Found while verifying [the flagged Scriptorium](./scriptorium-on-kit-daemon.md)
(2026-10-14). There are two cases:

- A census missing a verb's record: acc stays conformant but lists the verb as
  not covered. `acc.test.ts` asserts that list is empty, so adding or removing a
  verb fails the gate.
- A census whose record lists a flag the verb no longer has: acc exits 0 and
  stays conformant, and nothing reports it. An output change on an existing verb
  is missed the same way.

This applied to Scriptorium's default census and its kit census. After the
cutover's flip there is one, in the skill folder. The cutover survey
(2026-10-20) also measured the first case's gap in the house ward:
`grimoire/acc-conformance.test.ts` asserts neither `notCoveredByBatch` nor
`recordedNotAdvertised`; only Scriptorium's kit `acc.test.ts` does. The flip
moves that assertion into the house ward, so this item is the flag and output
half.

## Definition of done

- [x] A census record whose flags or output no longer match the CLI fails a gate
      test, or acc reports it.
- [x] Checked on Scriptorium's one census after the flip, and on the other
      spells' censuses the house ward runs.

## Done and verified

The check is `2af31a66`, all in `grimoire/acc-conformance.test.ts`. Each spell
with a census gets two more cells:

- **Flags.** The spell's own `schema` (an emitted acc declaration) is passed to
  `acc check --declaration`. acc diffs each recorded path's flag set (the
  `choices` its sentinel rejection names) against it. The ward asserts the diff
  ran (`status: "checked"`), found nothing, and compared every declared path.
- **Output.** Every entry of the census's `records` is replayed against the
  launcher on scratch homes (`LC_ALL=C`, as the probe-plan harness records), and
  must give the same exit code, stdout and stderr, byte for byte. The batch's
  separate `identity` record (the `--version` answer) is not replayed, on
  purpose: it carries the release number, so checking it would ask for a
  re-record on every release.

**Choices.**

- acc 0.1.15 has no option that re-checks a batch by itself: `check` passes and
  fails nothing on a batch, and the kit never runs below the root.
  `--declaration` does the diff, so the ward supplies the CLI's own schema and
  asserts the result. That is options (c) and (a) together: acc does the
  comparison, and the ward makes it a gate.
- The replay (option b) is cheap and deterministic. Every record is a
  sentinel-flag rejection, which the parser answers before doing any work. All
  229 records across nine spells replayed byte-identical in about 2s, three runs
  in a row, on scratch homes other than the ones they were recorded on.
- The replay compares exact bytes, not a shape. Any change to an error message
  on an existing verb therefore asks for a re-record, which is the point.
- acc, `schema` and the replay all run with a per-spell scratch `HOME`,
  `SCRIPTORIUM_HOME` and `TMPDIR`, and every other `*_HOME` and `XDG_*` variable
  is dropped (the spells' own homes, such as `GRAPEVINE_HOME` and `BOUNTY_HOME`,
  would otherwise beat the scratch `HOME`). Before, acc inherited the test
  process's environment.

**No census was stale.** All nine (astrolabe, bounty, digestify, glamour,
grapevine, imago, magpie, mind-mapper and scriptorium) compared with no
findings, and every entry of `records` replayed unchanged, so nothing was
re-recorded. The `identity` records are a different matter: 8 of the 9 name an
older version (3.1.0, or 4.0.0 for bounty) than the CLI's 5.2.0, and only
Scriptorium's matches. That is expected, because they are not checked.

**Mutation checks**, each run as the ward file alone and then restored
byte-equal:

1. A flag removed from a verb: `--full` dropped from the kit's `state` row and
   the build rerun. Both Scriptorium cells went red, the diff with
   `accepted-not-declared --full at state`.
2. A flag invented in a record: `--invented` added to the `add` record's
   `choices`. Both cells went red, the diff with
   `accepted-not-declared --invented`.
3. An output change: the `add` record's hint reworded, flags untouched. Only the
   replay cell went red, naming the offset where the two streams part.
4. The declaration not passed: the flag cell went red on all nine spells, so an
   unrun diff cannot pass as an empty one.

This also closes the gap in
[acc-ward-cannot-see-a-stale-surfaces-batch](./acc-ward-cannot-see-a-stale-surfaces-batch.md),
which proposed the same `--declaration` fix.
