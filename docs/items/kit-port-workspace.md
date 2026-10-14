---
type: item
title: Port the workspace daemon into the kit
description:
  Bring Story Studio's workspace module at 027d7a3 plus its generic follow-up
  fixes into src/kit/workspace, with the lib and wire pieces it imports.
status: draft
lifecycle: triage
id: 01a1393e-aab6-7627-8b3c-f7785e244373
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-14 }
tags: [kit, story-studio]
cycle: 2026-10-workspace-daemon
parent: feature/workspace-kit
from: items/workspace-stack-port-shape/write-up.md
---

# Port the workspace daemon into the kit

Part of [Workspace Kit](../features/workspace-kit/feature.md)'s workspace-stack
port, as shaped in
[the port-shape write-up](./workspace-stack-port-shape/write-up.md). Bring Story
Studio's `workspace` module into `src/kit/workspace`, along with the parts of
`lib` it imports and `wire/stdinPeek`. The base is `027d7a3` (Cole, 2026-10-13),
plus the workspace halves of `55df89e`, `d7ef948` and `a538a2e`, and the kit
half of `5b87ad0`. Story Studio's later workspace model is not ported. The other
items in this cycle build on this one.

## Definition of done

- [ ] Its tests pass under Spellbook's gate, with a scratch `HOME` enforced for
      every test. Story Studio's stand-in home only arrived later, in `a8776ab`.
- [ ] `cues`, `pushLoop` and the `generated` image provenance are not ported.
- [ ] No `STORY_STUDIO_*` or `story-studio` name remains.
- [ ] Calls into `wire` use Spellbook's names (`spell`, `server`,
      `SPELLBOOK_*`).
- [ ] The import-boundary, strict-parse, origin and spawn-path wards pass
      without being loosened.
- [ ] Tailwind does not scan the kit's test files.
- [ ] E71's tests (`structure.test.ts`'s overlap block, and `defaultWorkspace`)
      pass.

## Related Documents

- [How to port the workspace stack](./workspace-stack-port-shape/write-up.md)
