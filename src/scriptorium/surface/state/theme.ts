// Theme resolution: an explicit stored choice beats the OS preference beats
// dark. The SAME rule runs as the pre-paint script in index.html (before the
// bundle, so no wrong-theme flash) — keep the two in sync by hand.
import { safeStorage } from "./storage";

export const THEME_STORAGE_KEY = "scriptorium:theme";

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
