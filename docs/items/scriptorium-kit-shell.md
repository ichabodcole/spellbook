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

- [x] On the flagged path the surface is `WorkspaceShell`; `Frame.tsx`'s layout
      and all of `frameWorkspace.ts` are gone.
- [x] Layout, open columns, the float, the tab, the theme, the view mode and
      line numbers survive closing a session and opening another.
- [x] End session warns about unsaved documents, and ⌘S saves in every view.
- [x] In a real browser, beside the shipped app, each of these works on the
      flagged path: resizable columns with rails, the floating composer, search
      across the context, undo and redo, Move to Trash, waiting marks on a
      closed chat, notes owed elsewhere, agent presence, End session and the
      ended state, and task toasts. _(Move to Trash was checked up to the
      daemon: the menu, the dialog, and the daemon refusing the real Trash under
      test, which it does by design. No run touches the real Trash. The trashing
      itself is the kit's, tested by its own guards. Ticked by the lead,
      2026-10-20.)_
- [x] Everything the flagged path did before still works: chat, sets, hide,
      make-set, the move plan, the document pane, the map and "Add a block".
- [x] The shipped Scriptorium is unchanged: its parity harnesses and acc match.

## Done and verified

On `impl/scriptorium-kit-shell`, from `cycle/shell` at `33e2188b`, in five
chapters: `17ca148d` (the kit's two slots), `5236eb63` (the prefs adapter),
`82053ef4` (the frame replaced by the shell), `e768ec0b` (the help text) and
`9d63c2f0` (dist). Deliberate choices:

- **`Frame.tsx` keeps its name** and Scriptorium's own pieces (chips, row
  marker, menu actions, the end warning); its `Frame` now renders
  `WorkspaceShell`. `frameWorkspace.ts` and its tests are deleted: the shell's
  ported tests cover the held selection and the chosen note.
- **The storage adapter** (`surface/kit/prefsStorage.ts`) debounces per key (250
  ms), reads its own write until the snapshot agrees (so another session's theme
  still arrives), fits keys to the daemon's rule (the shipped `prefKey`,
  rewritten), sends nothing after an end, and flushes on `pagehide`. The view
  mode lives under the shipped `doc:view`: it opens **rendered** when nothing is
  kept, as the shipped app does, and a shipped `compare` reads as rendered. Line
  numbers are `doc:line-numbers`.
- **Prefs the shipped app kept are not read yet, by design.** The kit path keeps
  its prefs at `$SCRIPTORIUM_HOME/kit/prefs.json`, so a home whose `prefs.json`
  the shipped app wrote opens the kit path with none of its choices while the
  flag is on. At the cutover the sessions root moves to
  `$SCRIPTORIUM_HOME/sessions`, the prefs land on the shipped `prefs.json`, and
  keys of the same name (`theme`, `doc:view`, `panes:open`) are read there. The
  cutover cycle owns checking that they are.
- **The launcher** is the daemon's (`kitLauncher` in `backend/kit/server.ts`):
  `SCRIPTORIUM_KIT=1 bun <skill>/scripts/cli.ts`, with `SCRIPTORIUM_HOME=` when
  the daemon was given one, and none when no launcher sits beside the bundle.
  Checked end to end: the command the ended dialog printed restored the session
  from another folder. A daemon started with no `SCRIPTORIUM_HOME` prints none,
  by design (the default home is implied), so that command, run from a shell
  that exports a different `SCRIPTORIUM_HOME`, looks there and does not find the
  session.
- **The fixes after the verifier's pass** (fixup commits): the two kit-page
  create tests waited only for the create to be sent, and raced the shell's open
  of the new document; each create is now let land first. The pane asked for a
  diff with the last document's side when another opened (below, in the
  port-back notes). Tests now pin the prefs flush on `pagehide` and unmount, and
  that Mod-Shift-S, or Mod-S after an end, saves nothing.
- **The pre-paint theme key** is now the kit's `spellbook:theme`, which
  `applyTheme` writes; the page read `scriptorium:theme`, which nothing wrote.
- **`notesAddUnavailable` is not set.** Scriptorium has a document to select in;
  the document-centre item stopped setting it, and the shell's form waits for a
  selection.
- **The split divider is a parity gap, not fixed here.** The kit pane's split is
  two fixed halves with no divider at all, so there is no width to save; the
  shipped app's split is resizable and saved (`SPLIT_LAYOUT_ID`). Adding a
  resizable split to the kit pane is a pane change of its own (the raw editor
  must stay mounted between raw and split), not a storage key.
- **Shipped unchanged:** the shipped surface's dist is byte-identical; a
  scripted `--help`, `--version`, `open --no-open`, `state` and `close` on
  scratch homes matched the `33e2188b` skill but for the random `epoch` and the
  extracted copy's missing version; the shipped parity harnesses and acc pass in
  the gate. (The gate's runs each had one 5 s timeout under load: the kit page's
  three-create test, given a longer timeout in `82053ef4`, then
  `setPromotion.server.test.ts`'s watcher test, a file this item does not touch,
  which passes alone.) After the verifier's fixups the full gate is green: 6960
  pass, 0 fail.

The browser check (Playwright, real mouse and keyboard, scratch homes,
`NODE_ENV=test`), the flagged app beside the shipped one: every line of the
checklist above worked. Move to Trash went as far as the daemon, which under
test refuses the real Trash by design; the menu entry, its dialog and the
refusal notice all showed. The fourth box is left for the lead on that one
point.

## Port-back notes

- `shell/SessionEnd.tsx`: `SessionEndDialog` takes an optional `warning` (string
  or null), drawn under the question in the confirm phase
  (`data-slot="end-warning"`).
- `shell/WorkspaceShell.tsx`: a new optional prop `endWarning(state)`, read
  while End session asks (confirm and ending) and passed to the dialog.
  Scriptorium names its unsaved documents.
- `document/DocumentPane.tsx`: the diff is no longer asked for with the last
  document's side. On the render another document arrived, the diff effect ran
  before the reset effect cleared `against` and the mode, and asked for the new
  document against the old side (`beta has no v3`). A ref names the document the
  comparison's state belongs to, and the diff waits until it is this one. A bug
  in Story Studio's pane too, which the shell made visible here.
- `document/DocumentPane.tsx`: Mod-S is claimed on the window, so the rendered
  view (and focus anywhere on the page) saves instead of opening the browser's
  Save Page. It always prevents the default; it saves only what the Save button
  would (a dirty document, session live), and it yields when the raw editor's
  own binding has already taken the key (`defaultPrevented`), so one press is
  one save.
