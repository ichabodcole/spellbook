---
type: item
title: Calibrate the text-reading wards against a minified bundle, then minify
description:
  Minify the shipped bundles (register D7, lever 1) once the three instruments
  that read emitted artifacts as text are calibrated against a minified build.
status: draft
lifecycle: triage
id: 01a1777e-d8f4-7046-aff7-a73af24af96e
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-26 }
tags: [build, dist]
from: items/shrink-shipped-dist.md
---

# Calibrate the text-reading wards against a minified bundle, then minify

Step 2 of [shrink-shipped-dist](./shrink-shipped-dist.md). Step 1 removed the
inline source maps (shipped JS 23.19 → 12.81 MB raw, 5.74 → 2.66 MB gzipped).
Minify is register D7's lever 1 and stays deferred behind D7's precondition: the
instruments that read emitted bundles as text have never seen renamed
identifiers or stripped comments, so switching `minify` on in `src/build.ts`
first could leave them green and blind.

The calibration it needs, per D7 and the shrink-shipped-dist item:

- **The spawn-path ward's anchor spellings**
  (`grimoire/spawn-path-ward.test.ts`): the path anchors it looks for in a
  backend bundle (`import.meta.dir`, `join(…)`, the `DIST_DIR` family) must
  still be found, or still red, in a minified bundle.
- **The launcher-pairing ward's import specifiers**
  (`grimoire/launcher-pairing-ward.test.ts`): the `../dist/X.js` pairing and its
  census must hold against minified artifacts.
- **`exit-site-inventory`** (`grimoire/exit-site-inventory.test.ts`): confirm
  what, if anything, it reads from emitted text, and that its population does
  not shrink silently.
- **New since step 1:** the release-serve tests' `BUNDLED_BACKEND_MODULE` marker
  (`src/<spell>/backend/release-serve.test.ts`, six spells) proves a bundle is
  the real artifact by its `// src/<spell>/backend/…` module-boundary comment.
  Minify removes those comments, so that marker needs a replacement that
  survives minification.

Re-measure before quoting any size: D7's minify figures predate Scriptorium, the
kit and step 1.

## Definition of done

- [ ] Each instrument above is driven against a minified build of the whole
      roster, with a planted regression showing it still goes red.
- [ ] `src/build.ts` minifies the shipped bundles (or this item records why a
      bundle is left unminified), and the gate, acc and dist-check pass.
- [ ] Size before and after is measured and recorded here: raw, and gzipped as
      git stores it.
- [ ] The ruling comment in `src/build.ts` and register D7 are updated.

## Related Documents

- [Ship smaller bundles: no inline source maps, then minify](./shrink-shipped-dist.md)
