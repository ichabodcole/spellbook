// Per-viewer conveniences (pane sizes, theme) live in localStorage — and every
// access is wrapped, because a private window or a browser that blocks site
// data THROWS from the accessor itself. The surface must render correctly with
// nothing stored.

export const safeStorage = {
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
      /* storage denied — the session still works, it just won't remember */
    }
  },
};
