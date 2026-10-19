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

- [ ] `WorkspaceShell` takes an optional `storage` (`getItem`/`setItem`),
      defaulting to `localStorage`. Without it, nothing changes.
- [ ] The layout, `panes:open`, `panes:float`, the tab and the theme all go
      through it, and a test drives a prefs-backed adapter across a remount.
- [ ] The adapter's value formats match the shipped prefs where they exist, so
      `panes:open` and the theme carry over at the cutover.
- [ ] Offered on kit-parity.
