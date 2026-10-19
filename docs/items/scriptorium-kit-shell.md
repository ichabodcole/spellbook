---
type: item
title: The flagged Scriptorium runs in the kit's shell
description:
  WorkspaceShell replaces the interim frame on the flagged path, with
  Scriptorium's chips, map, menu actions and prefs-backed storage, and closes
  the shipped app's parity gap the shell brings.
status: stable
lifecycle: ready
id: 01a15621-4f51-77a4-9731-794a964b465e
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-19 }
tags: [kit, scriptorium, shell]
parent: feature/workspace-kit
blocked_by:
  [
    01a15621-4526-739e-9a62-6a499cfa8561,
    01a15621-491d-765f-9ca8-c8345997d7fa,
    01a15621-4cbc-7631-993b-c7f56626f53c,
  ]
cycle: 2026-10-shell
---

# The flagged Scriptorium runs in the kit's shell

With `SCRIPTORIUM_KIT=1`, the surface is still the interim frame
(`src/scriptorium/surface/kit/Frame.tsx` and `frameWorkspace.ts`). Its own
header says the shell replaces it whole. This item does that, and fills the
shell with what is Scriptorium's own:

- the centre `DocumentPane` with its chips, the map as `appView`, `textOffer`
  and line numbers;
- `scriptoriumMenuActions`, the row marker, the move plan and `askLocation`;
- a prefs-backed storage adapter, which also carries the view mode and line
  numbers (in `localStorage` today, so they reset every session);
- a declared `launcher`, so the ended dialog prints a restore command that
  works.

Two shipped behaviours the shell doesn't bring are added here, each small and
offered back where it is kit code:

- **End session warns about unsaved documents**, as the shipped app does
  (`App.tsx:202-209`). The kit's `SessionEnd` has no warning.
- **⌘S saves in rendered view too.** The kit binds it only in the raw editor, so
  in rendered view the browser's Save Page opens.

## Definition of done

- [ ] On the flagged path the surface is `WorkspaceShell`; `Frame.tsx`'s layout
      and all of `frameWorkspace.ts` are gone.
- [ ] Layout, open columns, the float, the tab, the theme, the view mode and
      line numbers survive closing a session and opening another.
- [ ] End session warns about unsaved documents, and ⌘S saves in every view.
- [ ] In a real browser, beside the shipped app, each of these works on the
      flagged path: resizable columns with rails, the floating composer, search
      across the context, undo and redo, Move to Trash, waiting marks on a
      closed chat, notes owed elsewhere, agent presence, End session and the
      ended state, and task toasts.
- [ ] Everything the flagged path did before still works: chat, sets, hide,
      make-set, the move plan, the document pane, the map and "Add a block".
- [ ] The shipped Scriptorium is unchanged: its parity harnesses and acc match.
