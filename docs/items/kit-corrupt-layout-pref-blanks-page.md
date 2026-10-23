---
type: item
title: A corrupt saved pane layout blanks the whole page
description:
  "react-resizable-panels' useDefaultLayout parses a stored layout with
  JSON.parse during render and no guard, so one corrupt panes: pref (the shell's
  columns, or the split's width) leaves the kit page empty with a SyntaxError."
status: stable
lifecycle: ready
id: 01a15b70-ecd3-71b1-9013-4d168783af30
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-20 }
tags: [kit, shell]
parent: feature/workspace-kit-follow-ups
from: cycle/2026-10-cutover
cycle: 2026-10-polish
---

# A corrupt saved pane layout blanks the whole page

Found by the `kit-split-divider` verifier (2026-10-20). Writing `"{not json"`
into a `panes:` key in the kit's `prefs.json` and opening a new session leaves
the page empty, with `SyntaxError: Expected property name…` in the console.
`useDefaultLayout` (`react-resizable-panels` 4.12.4) calls `JSON.parse` on the
stored value during render, with no guard. The shell's own column layout key
does the same on `cycle/cutover`, so the bug is older than the split divider;
the divider adds a second key that can trigger it. Story Studio's shell uses the
same hook.

## Definition of done

- [x] A corrupt or wrongly shaped stored layout is ignored (the default layout
      is used) for every `useDefaultLayout` the kit calls, for example through a
      guarded storage wrapper.
- [x] A test plants a corrupt value for the shell's columns and the split, and
      the page renders.
- [ ] Offered on kit-parity. _(The offer is the lead's, with the port-back notes
      below.)_

## Done and verified

`009e4e85` (on `impl/kit-shell-robustness`). Both `useDefaultLayout` calls in
the kit (the shell's columns and the document pane's split) read through
`guardedLayoutStorage` (`src/kit/lib/layoutStorage.ts`). Under the hook's own
key, a value is read only when it is a JSON object with one size from 0 to 100
for each of the group's panels and nothing else, the sizes summing to 100
(within half a point); anything else reads as absent, so the hook opens its
default layout. Writes and every other key pass through. The library's older
single-key format (`react-resizable-panels:<id>`) is not guarded, since the
library already reads it inside a `try`.

Tested: `layoutStorage.test.ts`, and the shell (`WorkspaceShell.test.tsx`) and
the split (`DocumentPane.test.tsx`) each mounted over eight planted bad values
(`BAD_LAYOUTS` in `lib/testLayout.ts`: not JSON, `null`, a number, a string, an
array, `{}`, sizes that are not numbers, sizes for other panels), plus a
one-half and an out-of-range split. In a real browser, `"{not json"` written
into a scratch home's `prefs.json` under `panes:panes:context:centre:chat`,
under `panes:doc-split:doc-raw:doc-rendered`, and under both: before the fix
each left the page blank with `SyntaxError: Expected property name or '}'`;
after it, each renders with both columns open and the split at half and half,
with no console error. A corrupt value stays in `prefs.json` until the layout
next changes, which is harmless now that every read is guarded.

## Port-back notes

- New `lib/layoutStorage.ts`: `layoutKey`, `isStoredLayout` and
  `guardedLayoutStorage(storage, id, panelIds)`. Generic and DOM-free.
- `shell/WorkspaceShell.tsx` and `document/DocumentPane.tsx` wrap the storage
  they hand `useDefaultLayout` (memoized on the store). Story Studio's shell
  uses the same hook and can take the wrapper.
- `layoutStorage.ts` imports `type KeptStorage` from `lib/storage.ts`, which
  Story Studio's `lib/storage.ts` does not export. Port it with that type (a
  `getItem`/`setItem` pair of strings, as `localStorage` is), or type the
  parameter with the storage type Story Studio's shell already uses.
- Review added a sum check: a stored layout counts only if its sizes sum to 100
  within `LAYOUT_SUM_SLACK` (0.5), so one summing to 300 or 60 (opened as equal
  thirds) or all zero (every side shut) opens the default instead.
