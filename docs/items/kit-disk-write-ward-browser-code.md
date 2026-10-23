---
type: item
title: The disk-write ward does not scan the kit's browser code
description:
  grimoire/kit-disk-write-ward.test.ts covers src/kit/workspace and the flagged
  Scriptorium's backend only; a raw node:fs write planted in src/kit/chat or
  src/kit/context stays green. Widen its scope, or add a ward that browser-side
  kit code imports no node:fs at all.
status: stable
lifecycle: ready
id: 01a14cb0-b41d-7721-9acb-193d48e34f40
kind: chore
generated: { by: claude-opus-5-5, at: 2026-10-17 }
parent: feature/workspace-kit-follow-ups
from: features/workspace-kit/sessions/2026-10-17-panes.md
cycle: 2026-10-polish
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

- [x] The kit's browser modules (`chat`, `context`, `ui`, `theme`, and
      `document` when it lands) are covered: either the disk-write ward's scope
      grows, or a ward fails when browser-side kit code imports `node:fs`.
- [x] A planted `node:fs` write in `src/kit/chat` turns a ward red.

## Done and verified

`501ea099` on `impl/ward-gaps` (2026-10-22). Both: the scope grows and the
import is refused. A new cell scans
`src/kit/{chat,context,document,shell, theme,ui}` with the same write matcher
and no allow-list, and refuses any import of `fs`, `fs/promises`,
`child_process` or `bun:sqlite` there (static, type, re-export, dynamic or
`require`). `.tsx` files are now parsed as TSX, or their JSX would derail the
tree. Planted `writeFileSync` from `node:fs` in `src/kit/chat/ChatComposer.tsx`:
red, naming the import and the write.

Round 2 (`3981b252`): `import.meta.require("node:fs")`, Bun's own require,
survived both checks. It is now a require to the write matcher and to the
browser import check, which also reads `process.getBuiltinModule`. Planted a
`writeFileSync` through it in `ChatComposer.tsx` (red: the write and the import)
and in `src/kit/workspace/doctor.ts` (red: the write).

Still unseen: `src/kit/lib` and `src/kit/wire` (shared by both sides), a
computed module name (`import("node:" + "fs")`, `require(m)`), and the writes
the ward's own header lists as out of reach (a computed key, `eval`).
