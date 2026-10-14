---
type: item
title: One link extractor, held to Scriptorium's links tests
description:
  Run Scriptorium's links tests against the kit's extractor and resolver; each
  difference is matched or put to Cole.
status: stable
lifecycle: active
id: 01a1393e-ac37-7191-a323-1a6a647acd73
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-14 }
tags: [kit, links]
cycle: 2026-10-workspace-daemon
parent: feature/workspace-kit
blocked_by: [01a1393e-aab6-7627-8b3c-f7785e244373]
from: items/workspace-stack-port-shape/write-up.md
---

# One link extractor, held to Scriptorium's links tests

Part of [Workspace Kit](../features/workspace-kit/feature.md)'s workspace-stack
port ([the port-shape write-up](./workspace-stack-port-shape/write-up.md)). The
links layer is the feature's riskiest seam. Run Scriptorium's
`src/scriptorium/backend/links.test.ts` cases against the kit's `extractLinks`
and `resolveTarget` equivalents, so the kit has one extractor held to
Scriptorium's behaviour.

**Ruled (Cole, 2026-10-14):** links inside raw HTML follow the kit's rule: all
raw HTML is masked, not only comments.

**Done and verified (2026-10-14).**
`src/scriptorium/backend/links.differential.test.ts` holds the kit's extractor
and resolver to Scriptorium's link cases: 139 tests, a seeded random comparison
of full link shapes, and a comparison of every disk question each resolver asks.
The kit needed no change for Scriptorium's links-cycle fixes.

Verification found the kit's extractor was quadratic on any dense line, so
`place()` was fixed: 50k characters now take 6–19 ms instead of up to 4.8 s.
Output is unchanged across more than 2.8 million links. Scriptorium's own
quadratic case is filed as
[scriptorium-mixed-link-line-quadratic](./scriptorium-mixed-link-line-quadratic.md).

**Ruled (Cole, 2026-10-14): every declared difference takes the kit's behaviour,
as Story Studio implements it.** If one causes a UX problem in use, it is fixed
then, possibly by going back to Scriptorium's behaviour, and in that case both
apps change together. So the kit keeps its root fallback and keeps rels as
written (no case folding).

**Declared differences.** What each one became is given after the dash:

- `html` (ruled): links in raw HTML follow the kit's rule.
- `embeds`: `![x](y)` is returned as an embed — kit rule.
- `lines`: lines counted from the top of the file — kit rule; update the SKILL
  line when Scriptorium switches.
- `schemes` and `colonResolve`: `Chapter2:intro.md` and `Note:Thing` read as a
  scheme — kit rule.
- `wikiTrim`: `[[ x ]]`'s raw is trimmed — kit rule.
- `notADoc`: `not-a-doc` in place of `outside` — kit rule, mapped to `outside`
  on Scriptorium's wire.
- `imageLookups`: a missing image never tries `<name>.md` — kit rule.
- `emptyTarget`: `""`, `?rel=` and `#top` are `missing`, not the folder — kit
  rule.
- `rootFallback`: a `/` target is also tried as a filesystem path — kit rule
  (ruled).
- `wikiForms`: `type/slug` keys, bare names and the repo root — Scriptorium's
  behaviour, added as a resolver slot in the wiki-layer cycle.
- `relCase`: Scriptorium lowercases rels — kit rule (ruled): rels keep their
  case, with the kit's placeholder filter and its reading of every pair.

## Definition of done

- [x] A differential test exists.
- [x] Each known difference is matched or listed for Cole with a recommendation.
      All are ruled: each takes the kit's rule.
- [x] The quadratic image-in-label case is filed, if it isn't already tracked.

## Related Documents

- [How to port the workspace stack](./workspace-stack-port-shape/write-up.md)
