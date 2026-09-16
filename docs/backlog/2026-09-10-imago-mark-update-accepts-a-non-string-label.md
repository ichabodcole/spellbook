---
type: backlog
title:
  "imago `mark.update` accepts a non-string `label`, and the surface crashes on
  it"
status: stable
lifecycle: open
generated: { by: unknown, at: 2026-09-10 }
---

# imago `mark.update` accepts a non-string `label`, and the surface crashes on it

**Filed:** 2026-09-10 · **Found by:** the type-debt Phase 4a verify pass ·
**Area:** `src/imago/backend/server.ts` (`mark.update`), surface `PinEditor` and
`svgMark.ts`

`mark.update` merges patch keys whose values pass a loose check — any number is
accepted — so `{ type: "mark.update", id, patch: { label: 5 } }` over the
WebSocket stores a numeric `label`. Two surface consumers assume a string:

- `PinEditor` (`tools/PinTool.tsx`) runs `value.trim()` on submit — the same
  crash Phase 4a fixed for an ABSENT label (type-debt T30); `?? ""` does not
  help, because `5` is not nullish.
- `svgMark.ts:65` calls `.split` on the label when flattening.

**Reachability:** the same as T30 — a non-surface WebSocket client or a
hand-made/restored snapshot; the shipped surface only ever sends strings. Not a
type error (the merge is untyped at that point), so the type-debt ratchet cannot
see it.

**Likely fix:** validate `label` as a string in `mark.update` (and `mark.add`),
refusing or dropping a non-string — at the boundary, like magpie's `box_2d`
(type-debt T28).
