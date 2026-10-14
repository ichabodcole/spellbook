---
type: item
title: Port the workspace daemon into the kit
description:
  Bring Story Studio's workspace module at 027d7a3 plus its generic follow-up
  fixes into src/kit/workspace, with the lib and wire pieces it imports.
status: stable
lifecycle: active
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

**Ported and verified (2026-10-14).** About 22k source lines came across,
faithful to the base plus the picks; a verifier rebuilt the reference tree and
every difference is a declared rename or cut. Verification hardened test
isolation over three rounds:

- every test run gets a scratch `HOME` and `TMPDIR` from a preload, in the root
  and in every spell's `bunfig.toml`;
- the preload cleans up after itself;
- `homeDir()` refuses the real home inside a test run with no preload;
- a ward reads the syntax tree for any other way of reaching the home.

`0ff5698` turned out to have no workspace half, so it waits for the document and
context ports.

## Definition of done

- [x] Its tests pass under Spellbook's gate, with a scratch `HOME` enforced for
      every test. Story Studio's stand-in home only arrived later, in `a8776ab`.
- [x] `cues`, `pushLoop` and the `generated` image provenance are not ported.
- [x] No `STORY_STUDIO_*` or `story-studio` name remains.
- [x] Calls into `wire` use Spellbook's names (`spell`, `server`,
      `SPELLBOOK_*`).
- [x] The import-boundary, strict-parse, origin and spawn-path wards pass
      without being loosened.
- [x] Tailwind does not scan the kit's test files.
- [x] E71's tests (`structure.test.ts`'s overlap block, and `defaultWorkspace`)
      pass.

## Related Documents

- [How to port the workspace stack](./workspace-stack-port-shape/write-up.md)
