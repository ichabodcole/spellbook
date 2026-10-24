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

- [ ] The failure reproduced on Linux (a container, or a CI debug run), and its
      cause named from evidence, not inferred.
- [ ] The cause fixed: no skips, no retries, no Linux-only timeouts.
- [ ] CI green on develop on two pushes in a row, with the full suite.
- [ ] If the cause is in the DOM harness, `kit-dom-harness-gaps` updated to say
      what this item closed.
