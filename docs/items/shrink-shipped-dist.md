---
type: item
title: "Ship smaller bundles: no inline source maps, then minify"
description:
  Spell bundles embed their full TypeScript as inline source maps (about 45% of
  the 21 MB shipped); the source is in the repo, so drop the maps, then minify
  once the text-reading wards are calibrated.
status: stable
lifecycle: ready
id: 01a13cb1-9bd5-7559-a38a-288c1a47de8e
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-14 }
tags: [build, dist]
from: architecture/house-conformance-register.md
priority: high
cycle: 2026-10-release-6
---

# Ship smaller bundles: no inline source maps, then minify

Cole, 2026-10-14: we are at the point where the distributed code should be
minimised. The source is in the repo, so it doesn't need to ship inside the
skills.

## Where it stands (measured 2026-10-14)

- `src/build.ts` builds every backend entry with `sourcemap: "inline"`. That
  embeds the complete original TypeScript in each artifact.
- The JavaScript in `plugins/spellbook/skills/*/dist/` comes to **21.9 MB**, of
  which **9.9 MB (45%)** is inline source maps.
- Scriptorium after the workspace-daemon cycle:
  - `server.js` is 4.6 MB, 3.6 MB of it map;
  - `cli.js` is 1.6 MB, 1.2 MB of it map.
- Because maps embed source text, a comment-only edit under `src/` dirties the
  committed bundles. The archive sweep's path-only comment edits rebuilt 17
  bundles across nine spells (`a93e5cc4`), and the `land` skill warns about the
  same thing.

## Earlier rulings this revisits

- **`sourcemap: "inline"` is Cole's ruling.** It was made knowing it embeds the
  source, and it redefined Contract 4's "source-free by construction" as "no
  source files" (see the comment above `buildBackendEntry` in `src/build.ts`).
  This item reverses that ruling for shipped artifacts.
- **Minify is deferred under register D7**
  (`docs/architecture/house-conformance-register.md`). Its precondition still
  stands: first calibrate the instruments that read emitted artifacts as text
  against a minified bundle. Those are the spawn-path ward's anchor spellings,
  the launcher-pairing ward's import specifiers, and `exit-site-inventory`.
  Surfaces already pin `NODE_ENV` through `define`. D7's measurements predate
  Scriptorium and the kit, so re-measure before quoting them.

## Suggested order

1. **Drop inline source maps from backend artifacts.** This is the larger and
   safer lever, because it doesn't change the bundles' text shape. Decide
   whether a non-shipped `.map` (gitignored) is worth keeping for local
   debugging, and say what a stack trace from an installed skill points at
   afterwards.
2. **Then minify,** after calibrating the text-reading wards against a minified
   bundle. That calibration may be its own item.

## Definition of done

- [x] No shipped bundle under `plugins/spellbook/skills/*/dist/` carries an
      inline source map. A ward fails if one does.
- [x] `src/build.ts`'s ruling comment, Contract 4's wording, and register D7 are
      updated to the new ruling.
- [x] A comment-only edit under `src/` no longer changes any committed bundle.
- [x] Every spell still runs from its built `dist/`. The gate and acc pass.
- [x] Size before and after is measured and recorded here: raw, and gzipped as
      git stores it.
- [x] Minify is either done, with the text-reading wards calibrated, or filed as
      a follow-up item that names the calibration it needs.

## Measured (2026-10-26, step 1)

All nine deployed `dist/` folders (`plugins/spellbook/skills/*/dist/` and
`plugins/unreleased/skills/mind-mapper/dist/`), 45 files, 27 of them JS:

|                               | Before   | After    |
| ----------------------------- | -------- | -------- |
| JS, raw                       | 23.19 MB | 12.81 MB |
| JS, gzipped (level 9)         | 5.74 MB  | 2.66 MB  |
| Inline maps, raw (18 bundles) | 10.39 MB | 0        |
| Inline maps, gzipped          | 3.07 MB  | 0        |
| All dist files, raw           | 23.95 MB | 13.56 MB |
| All dist files, gzipped       | 5.85 MB  | 2.77 MB  |
| Dist blobs as git stores them | 5.92 MB  | 2.80 MB  |

The maps were 44.8% of the shipped JS raw and 53% of it gzipped, because base64
compresses worse than code. The last row is each blob deflated the way git
writes a loose object; packed, git delta-compresses further. Scriptorium's
`server.js` went from 5.11 MB to 1.08 MB and its `cli.js` from 1.61 MB to 0.36
MB. Each of the 18 backend bundles lost exactly its three-line map tail and
nothing else, so no text-reading instrument saw a different bundle.

## Done and verified

Step 1 only, as the cycle scopes it. Minify is filed as
[calibrate-wards-for-minified-bundles](./calibrate-wards-for-minified-bundles.md),
which names the calibration it needs.

- `68bba2ee` — `src/build.ts` builds both the backend entries and the surfaces
  with `sourcemap: "none"`. `grimoire/no-shipped-sourcemap-ward.test.ts` fails
  on any `sourceMappingURL` directive (inline or linked, JS or CSS) or any
  `.map` file in a deployed `dist/`. Planted twice: `sourcemap: "inline"` (red
  on astrolabe's `cli.js` and `server.js`) and `sourcemap: "linked"` (red on
  both directives and both `.map` files); restored byte-equal, green.
- `d7a7c279` — `chore(dist)`: every bundle rebuilt.
- **No external `.map`, deliberately.** One beside the bundle would sit in the
  served `dist/` and one `.gitignore` line from shipping, for a need running the
  entry from `src/<spell>/backend/X.ts` already meets. A stack trace from an
  installed skill now points at `dist/X.js` line:column of the unminified
  bundle; its `// src/<path>.ts` module-boundary comments name the source file.
- **Comment-only edits.** A line comment and a JSDoc block added to
  `src/kit/wire/serveDist.ts` (bundled into most daemons) and to
  `src/astrolabe/backend/cli.ts`, then a full build: `git status` showed only
  the two source files. Bun's bundler drops ordinary comments; the map was what
  carried them. Reverted.
- **Tests that read the bundles as text.** Six release-serve tests used the
  inline map as proof that a bundle on disk was the real artifact; they now use
  the bundled backend module's `// src/<spell>/backend/` boundary comment
  (planted: a stub `cli.js` turns astrolabe's cell red). The grapevine and
  digestify size floors dropped from 50,000 to 20,000 bytes. The spawn-path
  ward, launcher-pairing ward and `exit-site-inventory` read nothing from the
  map and are unchanged.
- **Running from `dist/`.** Every launcher answered `--help`, `--version` and
  `schema` (valid JSON) at exit 0, on scratch homes. Round trips through the
  launchers: grapevine open/send/pull/stop, bounty open/add/state/close and
  scriptorium open/state/close, all in release mode. acc: all nine spells
  conformant, nothing excused. In headless Chromium (`NODE_ENV=test`), the
  surfaces of astrolabe, bounty, imago, magpie, scriptorium and mind-mapper
  loaded from `dist/` with their hashed chunk. Two oddities, both identical on
  the pre-change bundles at `79724ce9`, so not caused by this change: glamour's
  daemon is gone by the time the page loads after `open --no-open`, and
  mind-mapper's page logs one 409 and has no stop verb. The release-serve tests,
  which spawn every daemon from `dist/`, pass.
- **Gate:** exit 1 under parallel load, with 6 timeouts in four files
  (`src/scriptorium/backend/kit/hide`, `nohome` and `security` integration
  tests, and `src/bounty/backend/tail-handoff.integration.test.ts`). Run alone,
  all four pass (37 of 37). `bun scripts/dist-check.ts`: exit 0, and a rebuild
  is a git no-op.
