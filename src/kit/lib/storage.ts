// Per-viewer conveniences (pane sizes, theme) live in localStorage, and every
// access is wrapped, because a private window or a browser that blocks site
// data THROWS from the accessor itself. A surface must render correctly with
// nothing stored.

/**
 * A key-value store of strings, as `localStorage` is: what an app passes when the
 * browser's storage is the wrong place (an app whose daemon keeps prefs, on a new
 * origin every session). `safeStorage` is one.
 */
export type KeptStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export const safeStorage: KeptStorage = {
  getItem(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* storage denied: the session still works, it just will not remember */
    }
  },
};
