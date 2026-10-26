// Where the shell keeps what a viewer chose: the column layout, the widths the
// columns reopen to, the closed float, the chosen tab and the theme. The panes
// keep theirs in the same store (the workspace's `storage`): the document pane's
// view mode and line numbers.
//
// By default that is the browser's localStorage, under the app's `storageKey`.
// That is enough for an app on one origin. An app whose port changes per session
// is a new origin every session, so localStorage forgets everything; such an app
// passes its own `ShellStorage`, as an app whose daemon keeps prefs does.
//
// THE SHELL READS ONCE, WHEN IT MOUNTS. `react-resizable-panels` takes its saved
// layout only when the group mounts, and the reopen widths, the float and the tab
// are read the same way. So an adapter backed by something asynchronous is
// HYDRATED BEFORE THE SHELL MOUNTS: the app mounts the shell once the values
// have arrived (a daemon's first state snapshot). Mounted before, the shell
// starts from the default layout AND WRITES IT OVER THE SAVED ONE, because
// `useDefaultLayout` persists every layout commit, its first included.
// Writes are fire-and-forget.
//
// The theme is the one exception: it is followed for as long as the shell is
// mounted (`keptTheme`), so a choice made in another session arrives with this
// session's next snapshot (whenever the app's daemon next sends one: nothing
// watches the store for changes made elsewhere).
//
// DOM-free.

import { type KeptStorage, safeStorage } from "../lib/storage.ts";
import type { Theme } from "../theme/mode.ts";

/**
 * A key-value store of strings, as `localStorage` is. The shell hands it bare
 * keys (`panes:open`, `panes:float`, `tab`, `theme`, and the layout library's
 * `react-resizable-panels:panes:context:centre:chat`); a store of the app's own
 * needs no prefix of its own.
 */
export type ShellStorage = KeptStorage;

/**
 * The default: localStorage, each key under `${storageKey}:`, every access
 * wrapped (`safeStorage`). The theme does not go through it: without an adapter
 * the theme stays where `theme/mode.ts` keeps it, which the pre-paint script reads.
 */
export function localShellStorage(storageKey: string): ShellStorage {
  return {
    getItem: (key) => safeStorage.getItem(`${storageKey}:${key}`),
    setItem: (key, value) => safeStorage.setItem(`${storageKey}:${key}`, value),
  };
}

/**
 * The theme's key in an app's own storage. The same key an app whose daemon keeps
 * prefs may already use, with the same two values, so a kept choice carries over.
 */
export const THEME_KEY = "theme";

/** A kept theme, or null for none (absent, or anything but the two values). */
export function keptTheme(raw: string | null | undefined): Theme | null {
  return raw === "light" || raw === "dark" ? raw : null;
}
