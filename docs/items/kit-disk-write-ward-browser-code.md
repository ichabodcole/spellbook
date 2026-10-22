---
type: item
title: The disk-write ward does not scan the kit's browser code
description:
  grimoire/kit-disk-write-ward.test.ts covers src/kit/workspace and the flagged
  Scriptorium's backend only; a raw node:fs write planted in src/kit/chat or
  src/kit/context stays green. Widen its scope, or add a ward that browser-side
  kit code imports no node:fs at all.
status: draft
lifecycle: triage
id: 01a14cb0-b41d-7721-9acb-193d48e34f40
kind: chore
generated: { by: claude-opus-5-5, at: 2026-10-17 }
parent: feature/workspace-kit-follow-ups
from: features/workspace-kit/sessions/2026-10-17-panes.md
---

# The disk-write ward does not scan the kit's browser code

Found by the panes cycle's no-stake verifier of `kit-port-chat` (2026-10-17): a
raw `writeFileSync` from `node:fs` planted in `src/kit/chat/` left the
disk-write ward, the adoption ward, the layer rules and the chat tests all
green. The ward (`grimoire/kit-disk-write-ward.test.ts`) scopes itself to
`src/kit/workspace` and `src/scriptorium/backend/kit`. Chat and context are
browser code, so this is not exploitable today. But "the disk-write ward passes
with chat in the tree" checks nothing about chat.

## Definition of done

- [ ] The kit's browser modules (`chat`, `context`, `ui`, `theme`, and
      `document` when it lands) are covered: either the disk-write ward's scope
      grows, or a ward fails when browser-side kit code imports `node:fs`.
- [ ] A planted `node:fs` write in `src/kit/chat` turns a ward red.
