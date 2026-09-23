// E66: which document text a held selection is about — shared by the daemon
// (what `say` may attach) and the surface (what the chip may show), so the two
// halves cannot disagree about when a selection stops being true.

/** The document text on screen: the open document, at its active version. */
export type Screen = { doc: string; version: number };

/**
 * The held selection if it is still about the text on screen, else null.
 *
 * ⛔ A SELECTION BELONGS TO THE TEXT IT WAS MADE IN, and cannot outlive that
 * text leaving the screen. Opening another document — by the context list, a
 * search result, a note's "open", the agent — or making another version active
 * used to leave it held, and the surface re-sent it stamped with the NEW
 * document: the chip read `beta.md · v1 · line 5` over alpha's words, and a
 * `say` attached them to beta's path. Dropped, never re-labelled — the same
 * clear as the chip's X (Cole, 2026-09-22: one state, one meaning).
 *
 * Returns the SAME value when it is kept, so a caller can tell "no change" by
 * identity.
 */
export function selectionOnScreen<T extends Screen>(
  sel: T | null,
  screen: Screen | null,
): T | null {
  if (!sel || !screen) return null;
  return sel.doc === screen.doc && sel.version === screen.version ? sel : null;
}
