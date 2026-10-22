---
type: item
title: Ward blind spots the deletion's verifier found
description:
  After the shipped Scriptorium's deletion, the terminator ward sweeps none of
  Scriptorium's own CLI rows, sinks.test misses a raw innerHTML, origin-guard is
  a text scan, and the kit server swallows a failed dev-page import.
status: draft
lifecycle: triage
id: 01a165d9-ee76-7551-9678-1fb5230e8475
kind: chore
generated: { by: claude-opus-5-5, at: 2026-10-22 }
tags: [scriptorium, grimoire]
parent: feature/workspace-kit-follow-ups
from: cycle/2026-10-cutover
---

# Ward blind spots the deletion's verifier found

Found by the no-stake verifier of
[scriptorium-delete-shipped](scriptorium-delete-shipped.md) (2026-10-22). None
is a regression. Each is a ward that guards less than it seems to:

- **Terminator ward.** `scriptoriumKitCli(deps)` exports a builder, so the ward
  skips it, and none of Scriptorium's own rows (`hide`, `unhide`, `meta-set`,
  `make-set`, …) is swept. An extra positional planted on `unhide` survived. The
  shipped CLI's 29 rows were the only Scriptorium coverage. Fix: build it once
  in the ward with stub deps.
- **`sinks.test.ts`** catches `dangerouslySetInnerHTML` and `__html` but not a
  raw `el.innerHTML =` in Scriptorium's surface.
- **origin-guard** is a text scan: a guard call neutralised while its name stays
  passes. The behaviour tests (`security.integration`, `server.test`) do catch
  it.
- **The kit server's dev-page import** is wrapped in
  `try … catch { return undefined }`, unlike every other spell, whose
  release-serve tests assert that a failed import names the path. Scriptorium
  serves no page silently.
- **A stale comment:** `src/kit/wire/tailHandoff.ts:116` names the deleted
  `src/scriptorium/backend/tail-handoff.integration.test.ts`. Fixing it rebuilds
  every spell's `dist`, through the inline sourcemaps.

## Definition of done

- [ ] The terminator ward sweeps Scriptorium's own CLI rows, and a planted extra
      positional fails it.
- [ ] `sinks.test` also fails on a raw `innerHTML =`.
- [ ] Scriptorium's dev-page import fails loudly as the other spells' do, with a
      release-serve cell.
- [ ] The stale comment is fixed, with every `dist` rebuilt in one commit.
- [ ] origin-guard: a behaviour cell is named as its backstop, or the scan is
      tightened.
