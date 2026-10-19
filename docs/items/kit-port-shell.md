---
type: item
title:
  Port Story Studio's shell into the kit, without its single-workspace paradigm
description:
  Port packages/kit/src/shell from Story Studio's develop at 7832083 into
  src/kit/shell, cutting the plugin host, copy-in and the single-workspace UX,
  on Spellbook's names.
status: stable
lifecycle: ready
id: 01a15621-4526-739e-9a62-6a499cfa8561
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-19 }
tags: [kit, story-studio, shell]
parent: feature/workspace-kit
cycle: 2026-10-shell
---

# Port Story Studio's shell into the kit, without its single-workspace paradigm

The last workspace-stack port. Story Studio's `packages/kit/src/shell` lays out
the three columns: resizable, with rails and a floating composer when chat is
closed. It also brings search across the context, undo and redo, the Trash, End
session, link check, settings and task toasts. Our flagged Scriptorium has none
of that today; its interim frame is fixed-width and was always meant to be
thrown away.

**The port base is pinned at `develop` `7832083`** (read on 2026-10-19 with
`git show` and `git log` only). Story Studio is moving its idea of a project and
of the file tree away from what the two apps used to share, so every commit
since `027d7a3` was judged against Scriptorium's model, not only against
"copy-in or plugin host":

- **Wanted:** `5db9315` (the floating composer's shell half), `85a319e` (a note
  with the agent, shell half), `ae08f10` (a chosen note paints its passage),
  `bbc54fd` (via and refs, shell half), and the shell and dock half of `79cddf4`
  (the float docks above the status strip).
- **Left out, copy-in and plugin host:** `6b3d943`, `7afe5d9`, `3d029f0`.
- **Left out, Story Studio's diverging paradigm:** `a8776ab` (a session blocks
  until a workspace is chosen; the agent's workspace change waits for the
  human), `cda944e` (the workspace heads the context panel, with a pencil to
  change it), `fa7db2c` (drops onto Atlas stages), `94b024d` (entering a folder
  as the tree's root; context work, watched, not ported).

Picking forward from `027d7a3` doesn't apply, so the port takes `7832083` and
cuts back: five commits reverse cleanly, and `a8776ab` and `6b3d943` are cut by
hand (about 130 lines of `WorkspaceShell.tsx`). About 3.75k lines and 5.5k of
tests.

The single-workspace behaviour to cut, each one named in the port-back notes:
the blocking `WorkspacePrompt` (our state leaves `workspace` undefined, so the
check would pass by accident: cut it, don't rely on that), the workspace ask,
`WorkspaceTitle`, `copyIn`/`picked`/`onDropAct`, and the sidebar's `workspace`
prop.

## Definition of done

- [ ] `src/kit/shell` is Story Studio's at `7832083`, minus the commits and code
      listed above, on Spellbook's names (no `story-studio` storage key). No
      `plugins.tsx`, `WorkspacePrompt`, `workspaceChange`, `WorkspaceTitle` or
      copy-in. Its tests pass; every test cut is listed with its reason.
- [ ] `context/centreDock.tsx` and `lib/testLayout.ts` come with it, and our
      `DocumentPane` renders the dock.
- [ ] A test holds that an app declaring `homeWorkspace: false` never sees a
      workspace prompt or heading, so a later pick can't bring them back.
- [ ] `shell` is in `base.css`'s scan list, and every other spell's `dist` is
      byte-identical.
- [ ] The port-back notes name every change to Story Studio's code, and the
      later Story Studio shell commits seen at landing.
