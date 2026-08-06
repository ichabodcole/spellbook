// T1 — theme resolution (Claim T1). The precedence is structural: an explicit
// stored choice beats the OS preference beats dark (the surface's native
// palette). The SAME rule runs twice on purpose: once as the pre-paint inline
// script in index.html (must execute before the bundle to avoid a wrong-theme
// flash — keep the two in sync by hand) and once here for the React half.

export const THEME_STORAGE_KEY = "mind-mapper:theme";

export type Theme = "dark" | "light";

export function resolveInitialTheme(stored: string | null, prefersLight: boolean): Theme {
  if (stored === "light" || stored === "dark") return stored;
  return prefersLight ? "light" : "dark";
}

// The DOM half — attribute on <html> (the light palette is a
// [data-theme=light] custom-property override in styles.css; the body's own
// data-theme carries the spell name and is deliberately not touched).
export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage denied (private mode) — the session still themes, it just
    // won't be remembered.
  }
}

export function readAppliedTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}
