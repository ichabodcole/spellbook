---
type: item
title: "Ship smaller bundles: no inline source maps, then minify"
description:
  Spell bundles embed their full TypeScript as inline source maps (about 45% of
  the 21 MB shipped); the source is in the repo, so drop the maps, then minify
  once the text-reading wards are calibrated.
status: stable
lifecycle: triage
id: 01a13cb1-9bd5-7559-a38a-288c1a47de8e
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-14 }
tags: [build, dist]
from: architecture/house-conformance-register.md
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

- [ ] No shipped bundle under `plugins/spellbook/skills/*/dist/` carries an
      inline source map. A ward fails if one does.
- [ ] `src/build.ts`'s ruling comment, Contract 4's wording, and register D7 are
      updated to the new ruling.
- [ ] A comment-only edit under `src/` no longer changes any committed bundle.
- [ ] Every spell still runs from its built `dist/`. The gate and acc pass.
- [ ] Size before and after is measured and recorded here: raw, and gzipped as
      git stores it.
- [ ] Minify is either done, with the text-reading wards calibrated, or filed as
      a follow-up item that names the calibration it needs.
