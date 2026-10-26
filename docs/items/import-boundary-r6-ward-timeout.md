---
type: item
title: import-boundary-wards' R6 1b tests time out under load
description:
  Two R6 ward 1b cases in grimoire/import-boundary-wards.test.ts run close to
  bun's 5 s default and time out whenever the machine is loaded, turning the
  gate red; the file always passes alone.
status: stable
lifecycle: active
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

- [ ] The two tests do their work in well under 5 s alone (for example, read the
      shipped bundles once per file, not once per test), or carry an explicit
      timeout sized from a measurement, with the measurement cited.
- [ ] Ten parallel gates in a row on a loaded machine show no timeout from this
      file.

## Related Documents

- [Release ready: Spellbook 6.0.0](../cycles/2026-10-release-6.md)
