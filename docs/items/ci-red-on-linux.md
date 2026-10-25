---
type: item
title: "CI is red on develop: happy-dom component tests fail on Linux"
description:
  Since the 2026-10-17 push, CI on develop fails happy-dom component tests whose
  menus and dialogs never appear (15 failures, then 169 on 2026-10-24) while the
  suite passes locally; the release PR runs the same CI.
status: stable
lifecycle: ready
id: 01a17017-0595-77fb-8306-cf552a20d9f6
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-24 }
cycle: 2026-10-release-6
priority: urgent
from: cycle/2026-10-release-6
---

# CI is red on develop: happy-dom component tests fail on Linux

Found 2026-10-24 while checking develop for release readiness. CI on develop
went red with the 2026-10-17 push (run 39067261536, 15 failures) and worse on
2026-10-24 (run 40071398052, 169 failures out of 6,234). Every earlier run was
green. Every failure is a happy-dom component test whose menu, dialog or popup
never appears ("timed out waiting for the menu", `dialog-content` is null):
`ui smoke renders`, `Combobox`, the right-click menus, End session, the map, and
the settings dialog among them. The suite passes locally, and
`src/kit/ui/ui.test.tsx` passes in a clean macOS clone with `--frozen-lockfile`.

The suspicion, unconfirmed: something Linux-only, or the order files run in on
Linux. On CI, `Frame.map.test.tsx` is the first `.tsx` file (92 of 462), which
fits the "at load time" gap in [kit-dom-harness-gaps](kit-dom-harness-gaps.md).
If that is the cause, the matching part of that item joins this one. The release
PR to `main` runs this same CI, so the release can't go out until it is green.

## Definition of done

- [x] The failure reproduced on Linux (a container, or a CI debug run), and its
      cause named from evidence, not inferred.
- [x] The cause fixed: no skips, no retries, no Linux-only timeouts.
- [ ] CI green on develop on two pushes in a row, with the full suite.
- [x] If the cause is in the DOM harness, `kit-dom-harness-gaps` updated to say
      what this item closed.

## Done and verified

Two causes of CI's red, and one flake the parallel gate met in the same
container, each reproduced and fixed (2026-10-25, `852e1d16`, `509ac1a0`,
`b4b13563`):

- **The 169 (serial `bun test`, as develop's CI ran it).** A test file with no
  DOM loaded Base UI first: mind-mapper's `GraphCanvas.test.ts` imports
  `GraphCanvas.tsx` for its layout functions, which reaches Base UI through the
  node context menu. Base UI decides at load whether there is a DOM (its layout
  effect becomes a no-op without one) and keeps that for the process, so no
  later component test's dialog or menu opened. The order is the filesystem's:
  in the container it ran 49th, before every component file, as on CI (48th on
  10-17, 49th on 10-24); the Mac runs the same pair the other way round. Minimal
  reproduction, red on Linux and on the Mac: one no-DOM file importing
  `@base-ui/react/context-menu`, then `movePlan.test.tsx` (5 pass, 6 fail);
  `react-dom` or `@xyflow/react` alone in its place stays green. The serial run
  of develop (`cef0343a`) in the container failed 177, every CI failure among
  them. Fixed in the preload (`domGuard.ts`): any `@base-ui/` module loads with
  a DOM registered, which the guard removes before that file's next test.
  `registerDom.loadOrder.test.ts` runs a one-file fixture with and without the
  preload; the control fails as CI did. Nothing changed between the green run
  (10-12) and the red one but the DOM harness and the component tests arriving
  (`82bdc971` on); happy-dom 20.14.5 and Bun 1.4.0 (`34cbb9a40`) are the same in
  the lockfile, on CI and in the container.
- **Three right-click menu cells, on any non-Mac.** The test helper that strips
  a shortcut hint missed "Ctrl Shift K". They were in CI's red too, and were the
  only DOM failures left in the container's run of the cycle's parallel gate.

- **Grapevine's `stop` returned before the daemon had gone** (not part of CI's
  red; met in the container's second parallel gate). `start` straight after
  `stop --hold 3` found the dying daemon still answering instead of the hold,
  and 13 cells of `cli.daemon.test.ts` failed behind it. With the daemon's
  shutdown delayed to 400 ms the cell fails the same way on a Mac; `stop` now
  waits for the daemon to go, as `restart` and `roll` already did.

The cycle's parallel gate runs each file in a fresh module registry
(`--parallel=1` on the same pair is green), so the first cause cannot reach it;
the fix still holds for a serial `bun test`.

**Container recipe** (kept out of the repo: it is arm64 on Docker Desktop's 6.12
kernel, not the runner's amd64 6.17, and it would restate the Bun pin):
`ubuntu:24.04`,
`ca-certificates curl unzip git procps xz-utils python3 nodejs lsof`, a non-root
`runner` user, Bun installed at `.bun-version`, the tree from `git archive`
committed once into a fresh repo (the wards read `git ls-files`),
`bun install --frozen-lockfile`, then `bun run gate` and
`bun scripts/dist-check.ts`, run with `--cpus=4 --memory=7g` and fresh `HOME`,
`SCRIPTORIUM_HOME` and `TMPDIR`. Without `lsof` five process cells fail; without
`node`, the type-check ward.

**Container gate** (`bun run gate`, then `bun scripts/dist-check.ts`): on
`096c8116`, twice, dist-check clean and 6,235 tests pass, 2 fail and 3 are
skipped (cells for a case-insensitive or normalising disk), in about 190 s of
tests each. The two that fail are
[stat-stamp-coarse-ctime](./stat-stamp-coarse-ctime.md): they need a ctime finer
than 1 ms, which the container's kernel lacks and CI's (6.17) has; both passed
in both red CI runs. Filed, not fixed here. Before the fixes, the cycle's
parallel gate (`cdf8412e`) failed 10 in the container: the three menu cells,
five for want of `lsof` and the same two. A serial `bun test` of `096c8116`,
with `GraphCanvas.test.ts` again ahead of every component file, failed only
those two, against 177 on develop.

**For Cole (box 3):** on the next push of develop with this branch merged, the
gate job should go green; the test step runs in parallel and takes a few minutes
on the runner's 4 cores (about 190 s in the 4-CPU container).

## Port-back notes

- `src/kit/lib/domGuard.ts`: a load hook (`build.onLoad`, filtered to
  `node_modules/@base-ui/**.{js,mjs}`) registers the DOM while Base UI loads,
  requiring `registerDom.ts` if nothing has yet, and hands the file back as
  read. Unclaimed, so the existing stale-DOM `beforeEach` removes it. A resolve
  hook would not do: Bun 1.4.0 does not run a preload's resolve hook for a bare
  package specifier. Story Studio's harness has the same exposure whenever a
  no-DOM test imports a component module.
- `src/kit/lib/registerDom.loadOrder.test.ts` and
  `fixtures/domLoadOrder/baseUiFirst.tsx`: the regression, one file so the order
  holds on every filesystem.
- `src/kit/document/DocumentPane.contextMenu.test.tsx`: `items()` strips a
  multi-word "Ctrl …" hint. Test-only.
