---
type: item
title: Test stub servers can reach the user's real daemons
description:
  Test stubs called Bun.serve with no hostname, which listens on the IPv6
  wildcard, so a real daemon holding 127.0.0.1 on the same port answered the
  test, including a write.
status: draft
lifecycle: triage
id: 01a156d6-5358-7479-89d3-0df6ad1f9c1e
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-19 }
parent: feature/workspace-kit
from: cycle/2026-10-shell
---

# Test stub servers can reach the user's real daemons

A verifier ran `src/kit/workspace/verbs.test.ts` ("a daemon refusal with HTTP
500 maps to internal / exit 1") and it printed a **real** Story Studio daemon's
state (`"app":"story-studio"`, about 14 KB) where it expected the stub's reply.
That test also sends `version-new --doc x`, so under load the suite could send
**writes** to the user's running apps.

**Cause, measured.** The stub called `Bun.serve({ port: 0, … })` with no
`hostname` and the test dialled `http://127.0.0.1:<port>`. On Bun 1.4.0 (macOS),
a `Bun.serve` with no `hostname` listens on the IPv6 wildcard (`lsof`:
`TCP *:<port>`, dual-stack). The OS picks that port without checking IPv4
listeners, and a socket bound to the more specific `127.0.0.1:<port>` wins every
IPv4 connection to that address. Reproduced with listeners of our own only, no
real daemon touched:

- a `node:net` listener on `127.0.0.1:<p>`, then `Bun.serve({ port: <p> })` with
  no hostname: **both bound**;
- a dial of `http://127.0.0.1:<p>` reached the first listener; `[::1]` and
  `localhost` reached the stub;
- `Bun.serve({ port: <p>, hostname: "127.0.0.1" })` on the same taken port was
  **refused** ("Is port <p> in use?"), so with the hostname named a collision
  fails loudly instead of silently.

**Population.** Every `Bun.serve(` in the repo (`src/**`, `grimoire/**`,
`scripts/**`, the plugin's skills, fixtures and harnesses): 33 calls. Five test
calls had no hostname, all single-line:

- the daemon-refusal stubs in `src/kit/workspace/verbs.test.ts`,
  `src/scriptorium/backend/cli-contract.test.ts` and
  `src/glamour/backend/cli-contract.test.ts`;
- the port probes in `src/kit/workspace/daemon.integration.test.ts` and
  `src/mind-mapper/backend/cli.test.ts` (bind, read the port, stop, reuse it).

The listed suspect `grimoire/cli-golden.test.ts:181` already named
`hostname: "127.0.0.1"` on its next lines. No test uses `node:net` or another
listener to probe a port.

**Production daemons (report only, unchanged).** All ten name their hostname and
default to loopback: kit workspace, Scriptorium and grapevine hard-code
`127.0.0.1`; glamour uses `opts.host ?? "127.0.0.1"`; astrolabe, bounty,
digestify, imago, magpie and mind-mapper take a `--host` flag defaulting to
`127.0.0.1`, so a caller can still widen them by passing `--host`.

## Definition of done

- [x] Every test stub server binds the address the test dials: the five calls
      above name `hostname: "127.0.0.1"`, and the five suites pass (250 tests).
- [x] A ward, `grimoire/serve-hostname-ward.test.ts`, fails on any `Bun.serve`
      in the repo without a visible, non-wildcard `hostname`. It reads the
      syntax tree (multi-line calls, comments, `Bun["serve"]`, aliases), and it
      goes red on a planted violation.
- [x] The production daemons' binding is checked and reported above.
- [ ] The full gate is green. _(Not run here: the shell cycle's common brief
      forbids a full gate until the lead lifts the hold this item exists to
      lift. Targeted runs: the five suites plus the ward, and all of
      `grimoire/`, 326 tests, all pass.)_

## Done and verified

`32fda1a6` binds the five stubs and probes to `127.0.0.1`. `6362c8d9` adds the
ward. Mutation checks: removing the hostname from `verbs.test.ts`'s stub turned
the ward red at `src/kit/workspace/verbs.test.ts:441`; planting a multi-line
`Bun.serve` with a commented-out hostname in `scripts/` turned it red at that
file's line 1. Both were restored. The ward covers production daemons as well as
tests, since all ten already comply.

**Not closed: the port-probe race.** A probe that binds, reads the port, stops
and later reuses the number can still lose it to another process in between.
Binding the probe to `127.0.0.1` only proves the number was free on the address
the test dials at that moment. The `dead`-port cells in `tailEvents.test.ts` and
astrolabe's `cli.test.ts` already bind `127.0.0.1` and have the same small
window.

## Port-back notes

- Story Studio's `packages/kit/src/workspace/verbs.test.ts:432` (develop
  `6235e992`) has the same no-hostname stub. Our fix there adds
  `hostname: "127.0.0.1"`. Its other `Bun.serve` calls name a hostname.
- The ward is ours. Its rule is portable: Story Studio could take it as is.

## Related Documents

- [The shell](../cycles/2026-10-shell.md)
