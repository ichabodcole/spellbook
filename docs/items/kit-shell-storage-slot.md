---
type: item
title: A storage slot on the shell, so layout survives a per-session port
description:
  WorkspaceShell keeps layout, the float, the tab and the theme in localStorage;
  give it a storage adapter, defaulting to localStorage, so an app whose port
  changes per session can keep them in daemon prefs.
status: stable
lifecycle: ready
id: 01a15621-491d-765f-9ca8-c8345997d7fa
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-19 }
tags: [kit, shell]
parent: feature/workspace-kit
blocked_by: [01a15621-4526-739e-9a62-6a499cfa8561]
cycle: 2026-10-shell
---

# A storage slot on the shell, so layout survives a per-session port

Story Studio's shell keeps the column layout, which columns are open, the closed
float, the chosen tab and the theme in `localStorage`, under one `storageKey`.
Story Studio runs on one origin, so that persists. Scriptorium gives each
session its own port, so every new session is a new origin and all of it would
reset. The shipped Scriptorium keeps these in daemon prefs
(`$SCRIPTORIUM_HOME/prefs.json`) for exactly that reason.

Story Studio has no such slot (survey, 2026-10-19), so this is new kit work,
offered back.

## Definition of done

- [x] `WorkspaceShell` takes an optional `storage` (`getItem`/`setItem`),
      defaulting to `localStorage`. Without it, nothing changes.
- [x] The layout, `panes:open`, `panes:float`, the tab and the theme all go
      through it, and a test drives a prefs-backed adapter across a remount.
- [x] The adapter's value formats match the shipped prefs where they exist, so
      `panes:open` and the theme carry over at the cutover.
- [ ] Offered on kit-parity.

## Done and verified

Built on `impl/kit-shell-storage-slot`, from the shell port at `4e3c90ba`. New
kit work: Story Studio has no such slot, so there is no Story Studio sha.

- **The slot.** `src/kit/shell/storage.ts` holds the `ShellStorage` type
  (`getItem`/`setItem`), `localShellStorage(storageKey)` (the default: wrapped
  localStorage, each key under `${storageKey}:`, exactly the keys the shell
  wrote before), `THEME_KEY` (`"theme"`) and `keptTheme`. `WorkspaceShell` takes
  one new prop, `storage`, and routes the layout (`useDefaultLayout`),
  `panes:open`, `panes:float` and the tab through it. An app's own store gets
  BARE keys: it owns its namespace, as Scriptorium's `prefs.json` does.
- **The theme goes through the same adapter, under `theme`.** It is the same
  kind of fact (a viewer's choice that must outlive the origin), the shipped
  prefs already keep it under the bare key `theme` with the values
  `"dark"`/`"light"`, and one store is one thing for the app to back. Without an
  adapter, nothing changes: the theme stays where `theme/mode.ts` keeps it. With
  one, the shell still writes the browser copy too, because the pre-paint script
  runs before any adapter exists and reads only that (no wrong-theme flash where
  the origin repeats).
- **Async backing: hydrate before mount.** `react-resizable-panels` takes its
  saved layout only when the group mounts, so a change notification would come
  too late for the one value that matters most. The app mounts the shell once
  its store has arrived, which is what the shipped Scriptorium already does
  (`Workspace` mounts after the first snapshot, whose `state.prefs` holds every
  pref). Mounted before, the shell writes the default layout over the saved one,
  because `useDefaultLayout` persists every commit, its first included; the prop
  says so. Writes are fire-and-forget. The theme alone is followed while
  mounted: the shell reads it on every render and applies a valid value that
  changed. So a late value arrives, and another session's choice arrives with
  this session's next snapshot (no daemon watches `prefs.json`), as the shipped
  `savedTheme` effect has it. No subscribe method was added.
- **The document pane uses the same store** (verifier, 2026-10-19). The shell
  hands its `storage` on as the workspace's new `storage` field, and
  `DocumentPane` keeps its view mode and line numbers there, under its own
  `viewModeKey` and `lineNumbersKey`, as given. A pane with no `storage` in its
  workspace (standing alone, or under a shell with no adapter) keeps them in
  localStorage as before. Scriptorium will pass `viewModeKey="doc:view"`, whose
  values (`raw`/`rendered`/`split`) are the shipped pref's, so the view mode
  carries over. The type both use is `KeptStorage` in `lib/storage.ts`;
  `ShellStorage` is that type.
- **Formats.** `panes:open` (JSON of percentages by side), `panes:float`
  (`"closed"`/`"open"`), `tab` (the panel id) and `theme` are carried as they
  are. A Scriptorium adapter maps the library's key as the shipped `prefKey`
  does, giving `panes:panes:context:centre:chat` where the shipped layout is
  `panes:scriptorium:panes:…`; that the layout resets once was ruled (ruling 5).
  All the shell's keys pass the daemon's pref-key rule.
- **Tests.** `WorkspaceShell.storage.test.tsx` drives a fake of the shipped
  prefs (asynchronous sets and first snapshot, the key rule, the value cap, the
  shipped `prefKey`) across an unmount, a fresh localStorage and a page painted
  dark, and shows the collapsed chat, the closed float, the Tasks tab, the light
  theme and a shipped-format `panes:open` width (33%) all survive, with nothing
  but the pre-paint theme copy in localStorage. A second test follows a theme
  that arrives after mount, ignores a bad one and never writes it back; a third
  swaps in a new adapter and sees the next write land there; a fourth keeps the
  document pane's view mode and line numbers (under `doc:view` and
  `doc:line-numbers`) across a remount on a new origin. Twelve planted
  regressions each turned a test red: each shell read or write sent back to
  localStorage, the theme unwritten, unfollowed or unvalidated, the browser copy
  left unwritten with an adapter, the follow writing back, the adapter dropped
  from the memo's deps, the pane ignoring the workspace's store, and the shell
  not handing it on. A changed default prefix turned 17 of the existing shell
  tests red, so the default path is guarded byte for byte.

## Port-back notes

- **New prop `storage?: ShellStorage` on `WorkspaceShell`,** with a new module
  `shell/storage.ts`, exported from the shell barrel. Without the prop Story
  Studio's behaviour is unchanged: the default adapter is the old inline
  `safeStorage` wrapper under `storageKey`, moved into `localShellStorage`.
- **The adapter gets bare keys**, not `${storageKey}:` ones; `storageKey` still
  names the DOM ids.
- **The theme, with an adapter only:** `setTheme` also writes `theme` to it, and
  an effect follows the adapter's `theme` while mounted. `theme/mode.ts` is not
  changed.
- **The contract is "hydrate before mount"** for any asynchronous store; it is
  written in `storage.ts`'s header and the prop's doc comment.
- **`Workspace` gains an optional `storage: KeptStorage`** (the type is new in
  `lib/storage.ts`), and `DocumentPane` reads and writes the view mode and line
  numbers through `w.storage ?? safeStorage`. Without it, nothing changes.

Noted for a later item, not done here: the split divider's width is not kept;
the kit's pre-paint key (`spellbook:theme`) differs from the page's own; an
adapter-side debounce for keyboard resizing.
