---
type: item
title: Delete the shipped Scriptorium
description:
  "After Cole has used the flipped build: delete the shipped backend and
  surface, move the kit surface into place, remove the escape hatch, and
  recalibrate every ward that named the shipped code, in one commit."
status: stable
lifecycle: backlog
id: 01a15b3a-286c-7796-a786-03b475f24240
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-20 }
tags: [kit, scriptorium]
cycle: 2026-10-cutover
parent: feature/workspace-kit
from: cycle/2026-10-cutover
blocked_by:
  [01a15b3a-2716-70a6-872a-d30f3aad2a2c, 01a15b3a-27c0-706a-8a19-5ca5ca424431]
---

# Delete the shipped Scriptorium

Once Cole has used the flipped build and said go, the shipped Scriptorium goes:
about 20.3k lines of source and 10.6k of tests under `src/scriptorium/backend/`
and `src/scriptorium/surface/` outside `kit/`.

- **The kit surface moves into `surface/`,** and `theme.css` folds into
  `styles.css` (`kit-styling-ward` reads `styles.css` directly, so the move
  alone would turn it red). The entries thin, and the escape hatch goes.
- **Dead seams go:** `subSurfaceNames`, `kitDaemonCwd`, `FRAME_DIST` and
  `FRAME_DEV_ENTRY`, and the npm `cn` dependency.
- **Tests retire or move:** `links.differential`, `bomReaders`, `metaSetBytes`,
  `cli-contract`, `dev-styled` and `scriptorium-kit-path-ward` retire, since
  each compared the two paths or guarded their separation.
  `tail-handoff.integration` moves under `backend/kit/`, and `sinks` is
  re-aimed.
- **Every ward row that named the shipped code** is recalibrated, each with its
  reason in the commit.

It lands as one commit with a named merge, so git can bring the shipped app back
if it is ever needed. Nothing may be built on the shipped code between the flip
and this commit.

## Definition of done

- [x] No shipped Scriptorium source or test remains, the hatch is gone, and
      every recalibrated ward row says why.
- [x] `dist` is rebuilt, `dist-check` is clean, and every other spell's `dist`
      is byte-identical.
- [x] The paths the SKILL names in `dist` still exist.
- [x] In a real browser, a converted session opens on the new `dist`, and in dev
      mode from the repo root.
- [ ] The gate is green, and the change lands as one commit with a named merge.
      (The gate is green on the branch tip; the named merge is the lead's.)

## Done and verified

The deletion is `f80b1c80` (source, tests, wards, `bun.lock`), with the rebuilt
`dist` in `74f33a28`, on `impl/scriptorium-delete-shipped` off `cycle/cutover`
at `451d4aa2`. `git revert f80b1c80 74f33a28` gives a tree identical to
`451d4aa2` (checked on a scratch branch).

- **Deleted:** about 20.4k lines of shipped source (backend 9,465, surface
  10,905) and 10.8k of tests, the hatch, `kitFixtures.capture.ts` (its fixtures
  stay), `dev-styled`, `grimoire/scriptorium-kit-path-ward` and the `cn`
  dependency. **Moved:** the kit page (2,169 lines of source, 3,334 of tests)
  from `surface/kit/` into `surface/`, and `tail-handoff.integration` into
  `backend/kit/`. The two entries are 79 and 36 lines.
- **The fold:** `theme.css` is folded into `styles.css`, with `document.css` and
  `shell.css` still imported last, so the cascade is unchanged: the built sheet
  is byte-identical to the two-file form's but for its path comment.
- **The frame:** the house's literal dev import, and
  `DIST_DIR = join(HERE, "..", "dist")` in place of `FRAME_DIST`, so the
  spawn-path ward reads the folder as a pin.
- **Tests:** retired and re-aimed as the commit lists. `migrate.integration` now
  plants the captured shipped session instead of writing one through the hatch,
  and `sinks.test` holds that the page adds no HTML sink beside the kit's two.
- **Wards:** each recalibrated row carries its reason in the ward and in the
  commit. The kit's workspace daemon joined the origin-guard and
  daemon-lifecycle populations, since it is the daemon Scriptorium now runs.
- **Unchanged output:** the CLI golden and the acc census replay are green with
  no re-capture.
- **The browser:** headless Chromium (own Playwright), on scratch homes with
  `NODE_ENV=test`. The session was a copy of a real shipped-shape session, with
  its roots re-pointed at a scratch copy of the docs. It was driven on the new
  `dist` and in dev mode from the repo root. Both times it converted, and the
  page rendered with no console errors. The theme flipped, a document opened
  from the context list, and the split showed the editor and the rendered view.
  A message typed and sent with ⌘↩ reached the daemon.
- **Left as is, on purpose:** `backend/kit/` keeps its name.
  `src/kit/wire/tailHandoff.ts` still names the moved test's old path in a
  comment. That module is bundled, with an inline sourcemap, into every spell's
  CLI, so fixing the comment would change all eight other spells' `dist`.
  Scriptorium's own CLI rows are no longer in the terminator ward's population,
  because `scriptoriumKitCli(deps)` exports a function rather than a built
  `Cli`. The kit factory is still read through its fixture.

## Port-back notes

- `AppDeclaration.refuseScriptorium` is removed from
  `src/kit/workspace/session.ts`, along with its one use in
  `refuseForeignManifest`. It was a Spellbook-only field named for an app, and
  Story Studio never had it. The generic refusal of a Scriptorium-shaped
  manifest stays, and nothing changes for an app that never set the field.
- `tailRig` (`src/kit/workspace/fixtures/tailRig.ts`) takes an optional
  `RigLauncher` (`{ cli, homeVar, app }`), so an app can drive the kit's tail
  cells through its own launcher. The default is the fixture app, as before.
  This is test code only.
