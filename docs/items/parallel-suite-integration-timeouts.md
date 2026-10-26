---
type: item
title:
  Integration tests time out at bun's 5 s default under a loaded parallel suite
description:
  Since the suite runs with --parallel, daemon-spawning integration tests and
  slow wards time out at bun's 5 s default whenever the machine is loaded, so
  most full gates this cycle needed a judgement call; each failing file passes
  alone.
status: draft
lifecycle: triage
id: 01a17693-23fe-73cb-8d68-448ababeabff
kind: chore
generated: { by: claude-opus-5-5, at: 2026-10-25 }
from: cycles/2026-10-release-6.md
---

# Integration tests time out at bun's 5 s default under a loaded parallel suite

Seen through the release-6 cycle (2026-10-25). Since
[spellbook-parallel-tests](./spellbook-parallel-tests.md) the gate runs
`bun test --parallel`, about 55–100 s. Most full gates on `cycle/release-6`
failed on one to six tests, every time a timeout at bun's 5 s default in a file
that passes alone:

- `src/bounty/backend/tail-handoff.integration.test.ts` (a hook timeout with
  "killed 1 dangling process", in nearly every gate);
- `grimoire/import-boundary-wards.test.ts` R6 1b (filed on its own as
  [import-boundary-r6-ward-timeout](./import-boundary-r6-ward-timeout.md));
- `grimoire/kit-adoption-ward.test.ts`, `serve-hostname-ward`,
  `spell-css-scope-ward`, `grimoire/cli-golden.test.ts`;
- `src/scriptorium/backend/kit/nohome.integration.test.ts` and
  `security.integration.test.ts`;
- `src/grapevine/backend/cli.daemon.test.ts` "reap kills an orphan daemon".

A timeout in a test that spawns CLIs kills the CLI mid-call, so the next
assertion reads empty output and one timeout often reads as several failures.
Each red gate cost a re-run and a judgement about load, which is the trust the
parallel-tests item was meant to buy. `daemon.integration` was hardened with a
measured 20 s timeout in `kit-note-guard-lazy`; the rest were not.

## Definition of done

- [ ] Each test above that spawns processes or reads every shipped bundle has a
      timeout sized from a measurement under load (cite it), or is made faster.
- [ ] A timeout in a spawn-heavy test doesn't cascade into the tests after it.
- [ ] Five full gates in a row at a load average near 15 pass with no timeout.

## Seen since filing

- 2026-10-26: `src/scriptorium/backend/kit/hide.integration.test.ts` timed out
  in three gate runs in a row on `cycle/release-6` (the nits landing, the
  shrink-dist implementer's run, and the shrink-dist landing). Also seen in the
  implementer's run: `nohome`, `security` (kit) and bounty's
  `tail-handoff.integration.test.ts`. Each passes alone. It is now the most
  regular of the timeouts.

## Related Documents

- [Run the test suite in parallel, as Story Studio does](./spellbook-parallel-tests.md)
- [Release ready: Spellbook 6.0.0](../cycles/2026-10-release-6.md)
