---
type: item
title: The kit path stops borrowing from the shipped Scriptorium
description:
  Move what the flagged path imports from the shipped backend and surface
  (frontmatter, types, forceLayout, the palette and more) under the kit path, so
  the cutover can delete the shipped code.
status: stable
lifecycle: ready
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

- [ ] No module on the kit path imports from the shipped backend or from
      `surface/{components,state,styles.css}`. A ward holds it.
- [ ] The kit page has its own stylesheet, with the palette and theme, scanning
      only `surface/kit/` and the kit, so the shell port can't grow the shipped
      CSS.
- [ ] The converter's and wiki tests use captured fixtures, not the shipped
      `Session`.
- [ ] `meta-set-byte-safety`'s definition of done is met on the kit path.
- [ ] The shipped Scriptorium's behaviour and `dist` are byte-identical.
