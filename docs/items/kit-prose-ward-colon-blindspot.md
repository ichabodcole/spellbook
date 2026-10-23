---
type: item
title: The kit prose ward misses a utility name followed by a colon
description:
  The kit prose ward's BARE cell catches a Tailwind utility name in kit comments
  (blur, columns) but not one written with a trailing colon (blur:); make the
  match ignore trailing punctuation.
status: stable
lifecycle: ready
id: 01a14cb0-b547-778d-978a-72411d231258
kind: chore
generated: { by: claude-opus-5-5, at: 2026-10-17 }
parent: feature/workspace-kit-follow-ups
from: features/workspace-kit/sessions/2026-10-17-panes.md
cycle: 2026-10-polish
---

# The kit prose ward misses a utility name followed by a colon

Found by the panes cycle's `kit-port-context` implementer (2026-10-17). The kit
prose ward's BARE cell catches a Tailwind utility name in a kit comment (`blur`,
`columns`). It does not catch the same word written with a trailing colon
(`blur:`).

## Definition of done

- [x] The BARE cell catches a utility name followed by a colon or other trailing
      punctuation, and a planted `blur:` turns it red.

## Done and verified

`62c48ec9` on `impl/ward-gaps` (2026-10-22). Read as prose, a bare utility now
counts with any trailing punctuation its span keeps (`blur:`, `grow!`,
`truncate-`) and, beyond the item, in its `.word` selector spelling, which the
BOUNDARY table measured as live. The code half keeps the plain reading on
purpose: widening it would add to the words prose may use (`arr.filter(` would
admit "filter"). Planted `// blur: …` in `src/kit/ui/Dot.tsx`: red; the tree
stays green and no `dist` changed. Whether Tailwind emits `.blur` from `blur:`
was not measured; the stricter reading follows the ward's own rule. Still
unseen: any utility missing from `BARE_UTILITIES`.

Round 2 (`b5ed4ab7`): the verifier found the selector reading flagged
`// field.blur() hands focus back`, which Tailwind's extractor (oxide) does not
emit as `blur`. A word followed by `(` is a call and no longer counts, whether
reached by a `.` or not. Calibrated: `field.blur()`, `field.current?.blur();`
and `blur()` stay green, and `.blur` in a sentence stays red. Planted both in
`Dot.tsx`: the call green, the selector red.
