// Theme resolution: an explicit stored choice beats the OS preference beats
// dark. The same rule should run as a pre-paint script in a spell's index.html
// (before the bundle, so there is no wrong-theme flash); `THEME_PREPAINT` is
// that script's source, so the page and this file cannot drift.

import { safeStorage } from "../lib/storage.ts";

export const THEME_STORAGE_KEY = "spellbook:theme";

export type Theme = "dark" | "light";

export function resolveInitialTheme(stored: string | null, prefersLight: boolean): Theme {
  if (stored === "light" || stored === "dark") return stored;
  return prefersLight ? "light" : "dark";
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  safeStorage.setItem(THEME_STORAGE_KEY, theme);
}

export function readAppliedTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

/** The script a spell's index.html runs in its head before the bundle loads. */
export const THEME_PREPAINT = `(() => {
  let t = null;
  try { t = localStorage.getItem("${THEME_STORAGE_KEY}"); } catch {}
  if (t !== "light" && t !== "dark") {
    t = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  document.documentElement.dataset.theme = t;
})();`;
