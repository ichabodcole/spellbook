---
type: item
title:
  Port Story Studio's shell into the kit, without its single-workspace paradigm
description:
  Port packages/kit/src/shell from Story Studio's develop at 7832083 into
  src/kit/shell, cutting the plugin host, copy-in and the single-workspace UX,
  on Spellbook's names.
status: stable
lifecycle: done
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

- [x] `src/kit/shell` is Story Studio's at `7832083`, minus the commits and code
      listed above, on Spellbook's names (no `story-studio` storage key). No
      `plugins.tsx`, `WorkspacePrompt`, `workspaceChange`, `WorkspaceTitle` or
      copy-in. Its tests pass; every test cut is listed with its reason.
- [x] `context/centreDock.tsx` and `lib/testLayout.ts` come with it, and our
      `DocumentPane` renders the dock.
- [x] A test holds that an app declaring `homeWorkspace: false` never sees a
      workspace prompt or heading, so a later pick can't bring them back.
- [x] The shell's styles are in their own sheet, `theme/shell.css`, as
      `document.css` is, and every other spell's `dist` is byte-identical. The
      lead ruled this (2026-10-19); the box first asked for `shell` in
      `base.css`'s scan list, which cannot hold beside byte-identical spells
      (measured, below).
- [x] The port-back notes name every change to Story Studio's code, and the
      later Story Studio shell commits seen at landing.

## Done and verified

Ported on `impl/kit-port-shell` (2026-10-19) from Story Studio `develop` at
`7832083`, in seven commits: the mechanical cut-back (the shell halves of
`94b024d`, `cda944e`, `fa7db2c`, `3d029f0` and `7afe5d9` reverse-applied); the
image viewer the shell draws (`ImageViewer`, `ImageDescription`, `usePaneSize`
and `lib/viewport.ts`, left out of the theme and ui port as shell-only);
`testDom`'s late `react-dom/client` load; the dock in `DocumentPane`; the hand
cut of `a8776ab` and `6b3d943`, on our names; the guard test
(`WorkspaceShell.noHome.test.tsx`); and the stylesheet. The shell's tests and
the kit's five wards pass.

**The stylesheet, a deliberate deviation.** With `"../shell"` in `base.css`,
bounty, digestify, grapevine, imago, mind-mapper and both Scriptorium pages
rebuilt with new CSS; the image viewer alone, scanned through `"../ui"`, did the
same. So, as the document pane has `document.css`, the shell has `shell.css`. It
scans `src/kit/shell` and carries Story Studio's scrollbar rules, and a page
that adopts the shell imports it after `base.css` (`SHELL_CSS_SPECIFIER`). The
image viewer moved into `shell/`, because `base.css` scans `ui/` and
`@source not` is global to a build. With that, every spell's built CSS is
byte-identical; only the Scriptorium kit page's script changes (the dock).

**Tests cut**, each with its feature: `WorkspacePrompt.test.tsx` and
`workspaceChange.test.ts` (`a8776ab`), and `plugins.test.tsx` (`3d029f0`).

**Story Studio shell commits after `7832083`:** none.
`git log 7832083..develop -- packages/kit/src/shell` was empty on 2026-10-19,
with `develop` at `a4752a72`.

## Port-back notes

- **Cut, not ported:**
  - `WorkspacePrompt`, `workspaceChange`, and the blocking prompt keyed on
    `state.workspace === null`, with its refusal state;
  - the human's confirm before a workspace change, and the agent's workspace ask
    (`workspaceAsk`, `workspace.choosing`, `workspace.answer`);
  - `copyIn`, `picked` and its frame listener;
  - `plugins.tsx`;
  - `WorkspaceTitle`, with the `PaneHeading` change that let it head the panel.

  The sidebar gets `onAddPath` (`context.add`) back.

- **The sidebar's `workspace` and `onSetWorkspace` props are not passed**, so
  the context panel has no workspace row at all.
- **Shell tests at `6b3d943^`:** `LinkCheck`, `SearchBox`, headings, images,
  links, panes and the shell test run without the copy-in workspace. The links
  test expects "Add its folder … to open it here".
- **`storageKey`** defaults to `"spellbook"`, and the tests read it so. Do not
  take it back as it is. `columns.ts`'s `LEGACY_KEY_PREFIX` (`"story-studio:"`)
  stays as Story Studio's; it only ever reads a key we never wrote.
- **The image viewer lives in `shell/`, not `ui/`.**
  - `ui`'s barrel does not export it, and `WorkspaceShell` imports it from `./`.
  - `ImageDescription` imports `../ui/popover.tsx`.
  - Our `lib/sidecar.ts` has no `generated` origin. So the origin mark has no
    spark, and an unknown origin reads "not one of user or web" (from
    `IMAGE_SOURCES`), with a new test cell for it.
- **`theme/shell.css`** holds the shell's scan and the scrollbar rules that
  Story Studio keeps in `base.css`. Story Studio's `base.css` scans the shell
  itself, so none of this goes back unless its other apps need the split.
- **`lib/testDom.ts`:** only the late `react-dom/client` load is taken (from
  `85a319e`), not `waitFor`'s look-count diagnostics.
- **`DocumentPane`:** only the `<CentreDock/>` lines of `79cddf4`. Its Mermaid
  `theme` prop and `base.css` rules are not taken, nor its trashed-name change
  in `workspace/session.ts`.
- **Test adaptations:**
  - `refs.test` takes `pngBytes` from `lib/testImages.ts`.
  - `floatDock.test` adds `solo.md` to the context before opening it.
  - `images.test` settles once before clicking "Linked from". It missed about
    one run in two on our `@base-ui/react` 1.6.0.
- **Prose only, for the kit prose ward:** in a comment in `WorkspaceShell.tsx`,
  "grow" is now "turn into".
- **`WorkspaceShell.refs.test.tsx` still builds a single workspace**
  (`testWorkspace(root, "ws")`), unchanged from Story Studio. That is fine here.
  `testWorkspace` only makes a folder, and the daemon's `workspace` option is
  the kit's home-workspace default, which our kit keeps for apps that want one.
  The test is about the tree's multi-select and references; it asserts nothing
  about a prompt, a heading or copying in. The guard test covers those.
- **New:** `WorkspaceShell.noHome.test.tsx`, the guard against a workspace
  prompt, heading, dialog, pencil or sidebar row. It covers an app with no home
  workspace, a `workspace: null` snapshot, and a daemon that keeps one. Each is
  looked at again after an agent message and after a file dropped on the context
  pane. It can go back as is.
