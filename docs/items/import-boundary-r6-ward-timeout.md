---
type: item
title: import-boundary-wards' R6 1b tests time out under load
description:
  Two R6 ward 1b cases in grimoire/import-boundary-wards.test.ts run close to
  bun's 5 s default and time out whenever the machine is loaded, turning the
  gate red; the file always passes alone.
status: stable
lifecycle: done
id: 01a175d7-744b-77a0-83f0-40725bd2b0f1
kind: chore
generated: { by: claude-opus-5-5, at: 2026-10-25 }
from: cycles/2026-10-release-6.md
cycle: 2026-10-release-6
priority: high
---

# import-boundary-wards' R6 1b tests time out under load

Seen on 2026-10-25 in three of four full gates on `cycle/release-6`, and in
three agents' gates the same day. Two tests in
`grimoire/import-boundary-wards.test.ts` time out at bun's 5 s default when the
machine is loaded:

- "R6 ward 1b — the shipped execution path carries no dependencies > no bare
  specifier outside node: / bun: / bun" (5.3 s);
- "… > the `bun` exemption's population is LOOKED AT AND EMPTY" (7.2 s and 9.0
  s).

The file always passes alone; `test-timings.json` puts the whole file at about
5.5 s. Each red gate costs a re-run and a judgement call about load.

## Definition of done

- [x] The two tests do their work in well under 5 s alone (for example, read the
      shipped bundles once per file, not once per test), or carry an explicit
      timeout sized from a measurement, with the measurement cited.
- [x] Ten parallel gates in a row on a loaded machine show no timeout from this
      file.

## Done and verified

Commit `32b37de4` adds `refsOf()`, a per-file memo of `scanSpecifiers`, and uses
it in wards 1a and 1b. The time was going into scanning, not reading. Ward 1b's
population is 55 files (12.9 MB, mostly the emitted bundles). One scan of it
costs about 380 ms on an idle machine, and reading it costs 4 ms. 1b scanned it
four times and 1a scanned an overlapping set three times. Comment blanking in
the scanner is most of a scan's cost.

Measured in interleaved runs at a load average of about 12:

- The `bun`-exemption cell, alone, went from 0.80 s to 0.42 s.
- The "no bare specifier" cell, alone, stays at 0.37 s. It does one scan either
  way.
- In the whole file, all 1b cells now take under 0.05 s, because 1a's first cell
  fills the cache.
- The whole file went from 4.3 s to 2.0 s.

No timeout was added, so there is no measurement to cite beside one.

The population, the predicate and the failure messages are unchanged. Two plants
into `astrolabe/dist/server.js` were checked against both the old and the new
file, and each was restored byte-equal:

- A runtime `bun` import reddens the `bun`-exemption cell.
- `import "sharp"` reddens the bare-specifier cell and the `bun`-exemption cell.

Each plant gave the same failure in the old and new file.

Ten gates ran back to back on 2026-10-26, while other agents' suites were also
running (load average 10–90). All ten exited 0: 6446 pass, 0 fail, and nothing
timed out in any file.

Deliberate choice: the shared scanner in `grimoire/lib/import-graph.ts` is left
alone. Making it faster would affect every ward that uses it, which is outside
this item. On an idle machine one scan is 0.4 s, which is the cost a single cell
now pays at most.

## Related Documents

- [Release ready: Spellbook 6.0.0](../cycles/2026-10-release-6.md)
