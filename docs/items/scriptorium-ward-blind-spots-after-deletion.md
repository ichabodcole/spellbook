---
type: item
title: Ward blind spots the deletion's verifier found
description:
  After the shipped Scriptorium's deletion, the terminator ward sweeps none of
  Scriptorium's own CLI rows, sinks.test misses a raw innerHTML, origin-guard is
  a text scan, and the kit server swallows a failed dev-page import.
status: stable
lifecycle: ready
id: 01a165d9-ee76-7551-9678-1fb5230e8475
kind: chore
generated: { by: claude-opus-5-5, at: 2026-10-22 }
tags: [scriptorium, grimoire]
parent: feature/workspace-kit-follow-ups
from: cycle/2026-10-cutover
cycle: 2026-10-polish
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

- [x] The terminator ward sweeps Scriptorium's own CLI rows, and a planted extra
      positional fails it.
- [x] `sinks.test` also fails on a raw `innerHTML =`.
- [x] Scriptorium's dev-page import fails loudly as the other spells' do, with a
      release-serve cell.
- [x] The stale comment is fixed, with every `dist` rebuilt in one commit.
- [x] origin-guard: a behaviour cell is named as its backstop, or the scan is
      tightened.

## Done and verified

On `impl/ward-gaps` (2026-10-22): `ebca3733` (the four wards and the dev page),
the verifier's round 2 (`97c18fec` origin-guard parsed, `0a442468` sinks,
`98452c5e` the pin comment), and, last and alone,
`docs(kit): tailHandoff names the real-daemon cells that still exist` (the stale
comment, with every `dist` it touches). The origin ward's same-server check is
[origin-ward-same-server](origin-ward-same-server.md)'s, in `9ba3a9fd`. Each
ward was shown red on a planted regression and green on the tree, each plant
restored byte-equal.

- **Terminator ward.** A factory's follower may now export a BUILDER: a function
  that returns the factory's call. It is built once with stub deps
  (`BUILDER_ARGS` in `grimoire/terminator-invariant.test.ts`) and swept as its
  own adopter, `scriptorium/backend/kit/cli.ts#scriptoriumKitCli`: 32 rows with
  positionals (22 of the kit's, without the fixture's `workspace` and `demo`,
  plus Scriptorium's own 10: `add-folder`, `make-set`, `move-plan`,
  `note-remove`, `task-remove`, `meta`, `meta-init`, `meta-set`, `hide`,
  `unhide`), 167 more cases. A builder with no stub deps, or one that throws or
  returns no `Cli`, is red. Planted: an extra positional on `unhide` reds the
  pin (one more after-text case). Still unseen: what the ward never saw (a row's
  `check`, short aliases, `allowPositionals: false`), and a builder that returns
  its CLI through a nested function or a variable.
- **`sinks.test`** now also refuses, in Scriptorium's surface: an
  `innerHTML`/`outerHTML` write by any assignment (`=`, `+=`, `||=`, `??=`,
  `&&=`; never a read or a comparison), by `.name` or a string key
  (`el["innerHTML"]`); a `srcdoc` write or React's `srcDoc=`;
  `insertAdjacentHTML`; `document.write(ln)`; `createContextualFragment`;
  `setHTMLUnsafe`/`parseHTMLUnsafe`; and an `Object.assign` naming innerHTML,
  outerHTML or srcdoc. Calibrated. Planted `el.innerHTML = s` and, in round 2,
  each of `||=`, `??=`, `&&=`, `Object.assign(el, { innerHTML: s })`, a
  `.srcdoc` write and `setHTMLUnsafe(s)` in `MapView.tsx`: each red. Still
  unseen: a computed key (`el["inner" + "HTML"]`, `el[k] = s`), `Reflect.set` or
  `Object.defineProperty`, an `Object.assign` whose source object is built
  elsewhere, and sinks inside the kit's modules (the kit's own sink cells hold
  those).
- **origin-guard.** Both halves of the DoD: the scan is tightened and a
  behaviour cell is named. Since round 2 it reads the syntax tree, not text.
  Every call must be the kit's guard, imported by its own name or called through
  a namespace import of the kit's `wire/origin.ts`
  (`origin.refuseForeignOrigin(…)`, accepted; astrolabe converted to that form
  stays green). Its answer must be bound and returned by the next statement
  (`const r = …; if (r) return r;`). Nothing else may bind the name: an aliased
  import, a variable, a destructured binding, a parameter (plain or
  destructured), a function, a class, or any assignment. A renamed import of the
  kit's guard (`{ refuseForeignOrigin as g }`) is refused, since the scan cannot
  follow it. Planted in the kit workspace server: `if (refused && false)`, a
  destructured shadow (`const { refuseForeignOrigin } = …`) and a parameter
  shadow, each red. A BACKSTOP cell requires the kit daemon's two foreign-Origin
  socket tests (`src/kit/workspace/server.test.ts`) to exist, and the dead-`if`
  plant reds both of them. Still unseen by the scan: control flow and scope (a
  guard in a branch that never runs, a `req` that is not the handler's, a
  namespace name shadowed in an inner scope).
- **Dev-page import.** From the bundle, a dev page that does not import stops
  the daemon: the handshake is `{"ok":false,…}` naming
  `src/scriptorium/surface/index.html`, exit 1, before any session folder or
  pointer. Run from source (`FROM_SOURCE`: the module's own folder), nothing is
  imported, as before, and no longer by catching. New
  `src/scriptorium/backend/release-serve.test.ts`: the release boot (mode, `/`),
  and the forced-dev cell, which was red on the old build (the daemon booted in
  dev and served no page). Deliberate: the failure rides the kit's JSON
  handshake on stdout, as every kit daemon refusal does, not stderr as glamour's
  uncaught import does.
- **The stale comment** names the kit's own D1 and D2 cells
  (`src/kit/workspace/tail-handoff.{closed,restart}.integration.test.ts`), not
  Scriptorium's, so the kit names no app. Its commit rebuilds eight
  `dist/cli.js` and Scriptorium's `dist/server.js`; every earlier commit on the
  branch left the other spells' `dist` byte-identical (checked by hash).

## Port-back notes

- `src/kit/wire/tailHandoff.ts`: a comment only. It now points D1 and D2 at
  `src/kit/workspace/tail-handoff.closed.integration.test.ts` and
  `tail-handoff.restart.integration.test.ts`. Story Studio's copy can take the
  same pointer if it has those files, or drop it.
- The rest is Spellbook's wards and Scriptorium's app code, not the kit.
