import type { Theme, ThemeName } from "./types";

/** ⚠ THE ASSET FOLDERS DO NOT MATCH THE THEME NAMES, AND TWO OF THE THREE ARE
 *  WIRED WRONG BY ANYONE WHO ASSUMES THEY DO.
 *
 *  The theme called `digestify` loads from `/assets/classic/…` (the artwork was
 *  commissioned under that name and the theme was renamed around it), and the
 *  theme called `classic` loads NOTHING AT ALL — every asset field is the empty
 *  string, and the empty-string branches are behaviour: an empty `logoSrc`
 *  swaps the wordmark image for a text wordmark, an empty `mascotSrc` leaves
 *  the ambient mascot invisible, and an empty `sentMascotSrc` sends the sent
 *  screen down its headline branch. Carried across verbatim from
 *  template.html 905–936.
 *
 *  These paths are RUNTIME URLs served by the daemon's own `/assets/` route
 *  (review.ts 337–356). They are not build inputs and must never appear in the
 *  stylesheet or the HTML head — an `url()` in either makes the bundler try to
 *  resolve them off disk and the build fails (playbook R4, learned on bounty). */
export const THEMES: Record<ThemeName, Theme> = {
  digestify: {
    logoSrc: "/assets/classic/digestify-wordmark-classic.webp",
    brand: "Digestify",
    submit: "Digest it",
    submitting: "Digesting...",
    mascotSrc: "/assets/classic/digestify-mascot-classic.webp",
    sentMascotSrc: "/assets/classic/digested-classic.webp",
    stampLines: [{ text: "nom nom" }],
  },
  cthulhu: {
    logoSrc: "/assets/cthulhu/digestify-wordmark-cthulhu.webp",
    brand: "Digestify",
    submit: "Digest it",
    submitting: "Summoning...",
    mascotSrc: "/assets/cthulhu/digestify-mascot-cthulhu.webp",
    sentMascotSrc: "/assets/cthulhu/digested-cthulhu.webp",
    stampLines: [{ text: "Eldritch" }, { text: "knowledge", small: true }],
  },
  classic: {
    logoSrc: "",
    brand: "Digestify",
    submit: "Submit",
    submitting: "Submitting...",
    mascotSrc: "",
    sentMascotSrc: "",
    stampLines: [],
  },
};

export const DEFAULT_THEME: ThemeName = "digestify";

/** `themes[payload.theme] ? payload.theme : "digestify"` (template.html 937).
 *  An unrecognised name falls back SILENTLY — `review.ts` validates `--theme`
 *  before it ever reaches here, so this only fires on a hand-edited payload.
 *
 *  ⚠ ONE DELIBERATE DEVIATION, on an input nothing can reach. The old page's
 *  test is a truthiness check on a plain-object index, so `theme:"toString"`
 *  finds `Object.prototype.toString`, passes, and the page then renders a
 *  wordmark reading "undefined" under `data-theme="toString"`. `Object.hasOwn`
 *  is the same check without the prototype chain. Recorded rather than carried
 *  because faithfulness to a prototype lookup is not a contract worth keeping;
 *  see the decision log and inventory row T4. */
export function resolveThemeName(name: string | undefined): ThemeName {
  return name !== undefined && Object.hasOwn(THEMES, name) ? (name as ThemeName) : DEFAULT_THEME;
}

export function themeFor(name: string | undefined): Theme {
  return THEMES[resolveThemeName(name)];
}
