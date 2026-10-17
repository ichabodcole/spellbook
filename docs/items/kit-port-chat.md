---
type: item
title: Port Story Studio's chat pane into the kit
description:
  Port packages/kit/src/chat from Story Studio's develop whole (floating
  composer, notes with the agent, via/refs in the composer) into src/kit/chat,
  with lib/oneLine.ts, on Spellbook's wire names.
status: draft
lifecycle: triage
id: 01a14bca-13a0-72e6-91f1-2e1653184ea9
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-17 }
tags: [kit, story-studio, chat]
parent: feature/workspace-kit
cycle: 2026-10-panes
---

# Port Story Studio's chat pane into the kit

The third workspace-stack cycle ports the kit's panes
([port shape, §2b](workspace-stack-port-shape/write-up.md#2b-the-cycles), row
3). Chat comes from Story Studio's `develop` as it stands, not from `027d7a3`
like the rest of the stack. All four commits since then are ones we want, and
our daemon already carries their workspace halves (`kit-port-via-refs`):

- `5db9315`: the composer floats while the chat column is collapsed (E64);
- `85a319e`: a note shows that it is with the agent (E65's surface half);
- `ae08f10`: a note chosen in the Notes tab marks its passage;
- `bbc54fd`: via/refs (the composer's `via`, ref chips, message view).

Chat imports only the kit's `workspace/protocol`, `workspace/events` and `lib`,
plus `@headless-tree` and `@base-ui`. Story Studio's plugin host and its new
workspace model don't touch it. It needs `lib/oneLine.ts` (38 lines), which we
don't have yet.

The floating composer's other half lives in Story Studio's shell
(`WorkspaceShell.tsx`, `columns.ts`), so it is finished in the shell cycle.

## Definition of done

- [ ] `src/kit/chat` matches Story Studio's `packages/kit/src/chat` at a named
      `develop` sha, with Spellbook's names (`SPELLBOOK_*`, storage keys and
      MIME types). Its tests come with it and pass. `lib/oneLine.ts` is ported.
- [ ] The kit's layer rules and the disk-write ward pass with chat in the tree.
- [ ] Nothing in chat refers to Story Studio's plugin host or copy-in model.
- [ ] The port-back note lists any change made on our side, for kit-parity.
