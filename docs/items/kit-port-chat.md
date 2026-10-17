---
type: item
title: Port Story Studio's chat pane into the kit
description:
  Port packages/kit/src/chat from Story Studio's develop whole (floating
  composer, notes with the agent, via/refs in the composer) into src/kit/chat,
  with lib/oneLine.ts, on Spellbook's wire names.
status: stable
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

- [x] `src/kit/chat` matches Story Studio's `packages/kit/src/chat` at a named
      `develop` sha, with Spellbook's names (`SPELLBOOK_*`, storage keys and
      MIME types). Its tests come with it and pass. `lib/oneLine.ts` is ported.
- [x] The kit's layer rules and the disk-write ward pass with chat in the tree.
- [x] Nothing in chat refers to Story Studio's plugin host or copy-in model.
- [x] The port-back note lists any change made on our side, for kit-parity.

## Done and verified

Ported from Story Studio's `develop` at `2c4b6c2` (its last chat commit is
`bbc54fd`; nothing under `chat/`, `lib/oneLine.ts` or `lib/platform.ts` changed
after it). `da2afc50` is the verbatim port of `packages/kit/src/chat` with
`lib/oneLine.ts`, its test and `lib/platform.ts`; `7edc811d` holds the two
adaptations below; `2d162452` rebuilds `dist`, whose stylesheets gain the chat
classes (additive only). `lib/platform.ts` (13 lines) is not named above:
`NoteAtSelection` imports its `linkShortcutLabel`. Chat names no Story Studio
env, storage key or MIME type, so there was nothing to rename, and its imports
already match our layout. It type-checks against our `src/kit/workspace`
unchanged, so the protocol lines up and nothing in the workspace was touched. No
dependency was added: chat reaches `@base-ui` only through `ui/`, and does not
import `@headless-tree`. The 135 chat and `oneLine` tests pass, as do the kit
wards and `layers.test.ts`, and the gate is green. Chat is not wired into any
surface.

## Port-back notes

- `ChatMessageView.tsx`: the comment
  `md-chat is the narrow-panel variant of md-prose` becomes
  `rendered in the kit's prose style`. The kit prose ward reads `md-chat` as a
  class no code uses, and Story Studio has no `md-chat` class either.
- `ChatComposer.tsx`: `12 px-text button` becomes `button with 12 px text`
  (prose ward: `px-text`).
- `NoteAtSelection.tsx`: `does not collapse into the composer` becomes
  `does not fold into the composer` (prose ward: `collapse` is a Tailwind
  utility).
- `chat.test.tsx`: the HTML-sink census requires `document/MarkdownView.tsx`
  only once `src/kit/document` exists, since our document pane comes later.
  Story Studio can drop this when it takes the other changes; the test is the
  same there.
