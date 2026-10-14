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

## Definition of done

- [ ] A differential test exists.
- [ ] Each known difference is matched or listed for Cole with a recommendation.
      The HTML case is settled: it takes the kit's rule.
- [ ] The quadratic image-in-label case is filed, if it isn't already tracked.

## Related Documents

- [How to port the workspace stack](./workspace-stack-port-shape/write-up.md)
