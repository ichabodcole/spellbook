---
type: item
title: The kit path stops borrowing from the shipped Scriptorium
description:
  Move what the flagged path imports from the shipped backend and surface
  (frontmatter, types, forceLayout, the palette and more) under the kit path, so
  the cutover can delete the shipped code.
status: stable
lifecycle: done
id: 01a15621-5424-749c-9c04-eb67f886b279
kind: chore
generated: { by: claude-opus-5-5, at: 2026-10-19 }
tags: [kit, scriptorium]
parent: feature/workspace-kit
cycle: 2026-10-shell
---

# The kit path stops borrowing from the shipped Scriptorium

The cutover deletes the shipped `src/scriptorium/backend` and `surface`, but the
flagged path still imports from them in nine places (survey, 2026-10-19):

- `backend/kit/wiki.ts`, `links.ts` and `map.ts`: `quoteLabel`, frontmatter,
  protocol types, `gitRootOf`, `META_SCAN_CAP`, `fieldRefs`;
- `surface/kit`: `Frame.tsx`, `suggestMeta.ts`, `useMapView.tsx`, `mapGraph.ts`
  and `MapView.tsx` (`forceLayout`, `statusMark`);
- the frame's stylesheet, which `@import`s the shipped sheet for its palette and
  theme. That also means every class the shell adds grows the shipped CSS;
- tests that build fixtures with the shipped `Session` or `protocol`.

This item moves what is kept under the kit path, with no change in behaviour.
`meta-set-byte-safety` is fixed on the way, since its helper lives in the
shipped `frontmatter.ts` that moves here.

## Definition of done

- [x] No module on the kit path imports from the shipped backend or from
      `surface/{components,state,styles.css}`. A ward holds it.
- [x] The kit page has its own stylesheet, with the palette and theme, scanning
      only `surface/kit/` and the kit, so the shell port can't grow the shipped
      CSS.
- [x] The converter's and wiki tests use captured fixtures, not the shipped
      `Session`.
- [x] `meta-set-byte-safety`'s definition of done is met on the kit path.
- [x] The shipped Scriptorium's behaviour and `dist` are byte-identical.

## Done and verified

Commits on `impl/scriptorium-kit-keepers`, from `cycle/shell` at `401beb8d`:

- `2357d131`: the kept pieces. The survey's nine imports, checked by grep, plus
  a tenth it missed (`Frame.rowMarker.test.tsx` READ the shipped
  `EntryTree.tsx`): `backend/kit/frontmatter.ts` (moved whole, with `TrustTier`,
  `DocMeta`, `DocSummary` and `META_SCAN_CAP`; its tests moved too, except the
  one cell that holds the shipped surface's splitter equal to it),
  `backend/kit/fieldRefs.ts`, `backend/kit/gitRoot.ts`, `quoteLabel` from the
  kit's own identical `src/kit/workspace/anchors.ts`, and copies of
  `forceLayout.ts` and `statusMark` in `surface/kit/`;
- `ddaf8991`: captured fixtures (`backend/kit/fixtures/`) for `convert.test.ts`
  and `suggestMeta.test.ts`, written by the shipped code through
  `backend/kitFixtures.capture.ts` (on the shipped side, so it goes at the
  cutover; the fixtures stay), run once on scratch `HOME`, `SCRIPTORIUM_HOME`
  and `TMPDIR`. `wiki.test.ts` and `wiki.integration.test.ts` only needed their
  imports moved;
- `63e0cb02`: the kit page's own sheet. `surface/kit/theme.css` is the shipped
  sheet copied and re-rooted to scan `surface/kit/` only;
  `surface/kit/styles.css` imports it and the kit's `document.css`; the shipped
  sheet adds `@source not "./kit"`. With a probe class in `surface/kit/`, the
  class reached the SHIPPED dist sheet before and only the kit sheet after;
- `6a638a18`: `grimoire/scriptorium-kit-path-ward.test.ts`;
- `7d42b340`: [meta-set-byte-safety](meta-set-byte-safety.md).

**Move or copy, and why.** Backend pieces move, and the shipped
`frontmatter.ts`, `protocol.ts`, `session.ts` and `links.ts` re-export them, so
one helper runs on both paths (meta-set-byte-safety asks for that) and nothing
drifts before the cutover. The shipped behaviour is the same code. Surface
pieces are copied: the shipped surface bundle carries `forceLayout.ts` and
`model.ts`, and it is built unminified with inline sourcemaps, so a re-export
would rewrite its bytes. With a copy, the shipped `index.html`,
`index-w940m06p.js` and `index-x7h9dpmj.css` are byte-identical (sha1 compared).
`server.js` bundles both paths and changes; `cli.js` is byte-identical.

**Verified.** The parity harness (every verb's help, `--version`, `schema`,
`open --no-open`, `state`, `tail`, `say`, `diff`, `doctor`, `meta`, `close` and
a meta round, on the shipped default path, on a scratch home) printed 2,620
identical lines before and after the move; after the fix, the only differences
are in the meta round, each the fix or its read. The flagged page was compared
in Chromium before and after the stylesheet change, on a scratch home, in four
states (raw, rendered, dark, the map). Every element's computed style,
pseudo-elements included, is identical, and the screenshots are pixel-identical
apart from the header's session id. The kit sheet lost 31 rules, every one a
utility only the shipped components write. The ward reddens on a planted
`import { Session } from "../session"`, on a planted `@import "../styles.css"`,
and, with an empty root, on its zero-guard. `gate-honesty`'s blind set and the
import-boundary re-export pin name the new files.

**After the no-stake verification (fixups).** A verifier found that the BOM
change split the readers. The lead ruled one fact, one meaning: every reader on
both paths must agree on a BOM file's frontmatter. The fixups make that true;
they are listed in [meta-set-byte-safety](meta-set-byte-safety.md). They also
widen the ward:

- it now reads `@source` lines (a sheet that scans the shipped surface borrows
  its classes) and the kit page's `src` and `href` references;
- a build-level cell copies the shipped sheet and the kit page's sheet into a
  temp tree, builds both with the real Tailwind plugin over a probe class
  planted only in `kit/`, and checks that the shipped build does not carry the
  probe and the kit page's build does. Deleting `@source not "./kit"` from the
  shipped sheet turns it red.

The shipped surface's dist changes in the fixups (its frontmatter splitter
gained the BOM), as the lead accepted for that fix. Its stylesheet is still
byte-identical.

**Accepted debt until the cutover:** `surface/kit/theme.css` is a twin of the
shipped `surface/styles.css`, and nothing holds the two equal. A palette change
goes in both until the cutover deletes the shipped one.

## For the cutover

Six kit-path tests still drive the shipped CLI at run time, through the
launcher. The ward cannot see them, because they spawn a process; they import
nothing. The cutover must rewrite them:

- `backend/kit/kit.integration.test.ts`, "neither Scriptorium reads the other's
  sessions": its cells run the shipped Scriptorium against a kit manifest, and
  the kit against a shipped one;
- `backend/kit/migrate.integration.test.ts`, the dry-run conversion: "the
  conversion dry run is off for real use" and "the kit path, with the dry-run
  flag, restores a shipped session converted", whose cells make and read shipped
  sessions through the shipped CLI.

`backend/kitFixtures.capture.ts`, `backend/metaSetBytes.test.ts`,
`backend/bomReaders.test.ts` and the surface-splitter cell in
`backend/frontmatter.test.ts` are on the shipped side and go with it. The kit
path keeps its own cells.

## Port-back notes

- **`src/kit/lib/frontmatter.ts`** (Story Studio
  `packages/kit/src/lib/frontmatter.ts`, last changed at `42fcbd09`):
  `FRONTMATTER_BLOCK` allows a byte-order mark before the opening `---`
  (`/^\uFEFF?---…/`). `bodyStart` counts the mark, so body offsets stay
  whole-text offsets. Without it, a file saved with a BOM showed its block as
  prose in the rendered view, and the link graph, tree and session read no
  frontmatter from it, while an app's own reader might. There is a cell in
  `document/frontmatter.test.ts`. The key-line lookahead also takes a first key
  in matching quotes (`"status":`, `'status':`). Before, such a block was prose
  to the kit, but frontmatter to YAML and to an app's own reader. Scene-break
  prose and an unclosed quote stay prose; there are cells for both.
- Nothing else here changes Story Studio's kit code; the rest is in
  `src/scriptorium/` or `grimoire/`.
- A note for their agent: a spell sheet that `@import`s another page's sheet
  takes that sheet's `@source` too, and `@source not` is global to a build. So a
  second page needs its own sheet, not an import of the first page's.
