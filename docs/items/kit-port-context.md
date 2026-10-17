---
type: item
title: Port Story Studio's context pane into the kit, without copy-in
description:
  Port packages/kit/src/context from 027d7a3 plus d7ef948, a538a2e, 0ff5698 and
  the context halves of bbc54fd, ae08f10 and 4e6d4d4, leaving out the copy-in
  commits, so sets are still added from where they live.
status: stable
lifecycle: triage
id: 01a14bca-14ab-7119-bc8a-05b2b7dcd676
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-17 }
tags: [kit, story-studio, context]
parent: feature/workspace-kit
cycle: 2026-10-panes
---

# Port Story Studio's context pane into the kit, without copy-in

Context comes from `027d7a3`, the same base as the workspace stack, plus the
commits we want since then, in this order:

1. `d7ef948`: "New set" at the root, "New folder" inside a set;
2. `a538a2e`: two CI races in `daemonClient.test` made to hold;
3. `0ff5698`: a pending edit is sent before a version switch;
4. the context halves of `bbc54fd` (`selected`, `onSelect`, `onAddRef`,
   `AddRefItem`, the tree multi-select), `ae08f10` and `4e6d4d4`.

A trial in a scratch repo applied all of them cleanly except `bbc54fd` in
`ContextSidebar.tsx`. That hunk only adds props, so it needs a small merge by
hand.

**Left out on purpose:** Story Studio's copy-in model. Its files are brought
into one project workspace, while ours are edited where they live and sets are
added from anywhere. That means leaving out:

- `6b3d943` (`copyIn`, `CopyInAnswer`, the `picked` prop);
- `7afe5d9` (`folderDrop.ts`, a dropped folder becomes a set at the root);
- `83ea109`'s comment in `model.ts`;
- the "copy it in" wording.

We keep `onAddPath` and `027d7a3`'s rule that dropping a folder is refused, with
a pointer to the picker that links it. Where "New set at the root" assumes a
single root, the wording is ours to fix.

## Definition of done

- [x] `src/kit/context` is `027d7a3`'s, with the six commits above applied and
      the copy-in commits left out, on Spellbook's names. Its tests pass.
- [ ] Adding a path adds a set where the path lives. No context code copies a
      file anywhere. _(First half verified. Second half not true as written: see
      "Done and verified".)_
- [x] The tree multi-select and "Add as reference" send refs the daemon accepts,
      as `kit-port-via-refs` stored them.
- [x] The port-back note names what we left out and why, for kit-parity.

## Done and verified

Ported from Story Studio's `027d7a3`, with `d7ef948`, `a538a2e`, `0ff5698`,
`ae08f10`, `4e6d4d4` and the context half of `bbc54fd` applied in order (read
from `develop`). No later `develop` commit touches the context folder. The
result matches Story Studio's `develop` context folder except for the files and
hunks that the three copy-in commits add. `daemonClient.ts` lives in context at
every sha, so `0ff5698`'s and `4e6d4d4`'s client halves are in the port.

Commits on `impl/kit-port-context`:

- `2dc5254e`: the verbatim port, plus `@headless-tree/*` `^1.7.0` at the root
  (resolved 1.7.0, as Story Studio pins it);
- `60e13e81`: our names and test harness;
- `e46f971b`: the prose ward's rewording;
- `50b1d1bd`: a sidebar-level refs test over a real daemon;
- `6bbd2fc1`: the rebuilt dist (additive CSS only).

The context tests pass: 267 tests in 17 files. The kit wards pass, and so does
the gate.

**Adding a path.** `ContextSidebar.refs.test.tsx` holds that a path added from
outside the session's workspace folder becomes a set rooted where it lives, and
that the workspace folder stays empty. `onAddPath` is unchanged. Dropping a
folder is still refused with a pointer to the picker, as at `027d7a3`.

**Why the second box stays open.** Context code still takes a document or an
image dropped from Finder through `import`, which writes its contents into the
folder it was dropped on (or into the workspace folder, when dropped on the
list). That is `027d7a3`'s own drop path, not the copy-in model. A web page
never learns a dropped file's path, so it can only send the file's contents. In
an app with `homeWorkspace: false`, which Scriptorium is, a drop on the list is
refused for want of a folder. Whether that drop path stays is for the lead or
the interim-frame item; this item leaves it as Story Studio had it.

**"New set" (`d7ef948`).** The label is only on the workspace row, which renders
only when the session has a workspace folder. With no home workspace, the
Scriptorium surface shows no such row, so the wording never reads wrong here,
and it is left unchanged.

## Port-back notes

- **Left out: Story Studio's copy-in model.** That is `6b3d943` (`copyIn`,
  `copyInVia`, `CopyInAnswer`, `CopyInWhat`, the `picked` prop), `7afe5d9`
  (`folderDrop.ts`, `importFolder`, `lib/folderWire.ts`, `lib/copyInRules.ts`),
  and `83ea109`'s comment in `model.ts`. Spellbook edits files where they live
  and adds sets from anywhere, so nothing is brought into one project workspace.
  Without them, `daemonClient`'s refusals still say "Add its folder … to open it
  here", not "Copy it in (add)".
- **`bbc54fd` in `ContextSidebar.tsx`** was merged by hand. Its import hunk sat
  beside the copy-in types; ours adds `AddRefItem` to `027d7a3`'s import. The
  code is the same.
- **`rowDrag.ts`:** `ROW_DRAG_MIME` is `application/x-spellbook-rows+json`.
- **`daemonClient.agentSwitch.test.ts`** makes its workspace folder inline. Our
  harness has no `testWorkspace`, which came with Story Studio's
  explicit-workspace model (`a8776ab`).
- **Prose only, for the kit prose ward.** "blur" and "the side columns" are
  single-word Tailwind utilities, so they were reworded in `AddPath.tsx`,
  `ContextSidebar.tsx`, `daemonClient.ts`, `columns.ts` and `workspace.ts`.
  `menus.test.ts` and `trashDialog.test.ts` got header comments. Worth taking
  back if Story Studio's kit stylesheet scans its own prose.
- **New: `ContextSidebar.refs.test.tsx`.** It holds the tree multi-select and
  "Add as reference" at the sidebar, through a small host, over a real daemon.
  Story Studio holds the same through its shell; this can go back as a
  sidebar-level cell.
