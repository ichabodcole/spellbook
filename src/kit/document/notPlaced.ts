// The words a refused note says, kept apart from the check that refuses it.
// ⛔ NO IMPORTS HERE. The workspace daemon and every CLI spawn load the session,
// which needs these words on every start; the check (`showsSelection` in
// `projection.ts`) pulls in the markdown parser, 31 modules, and is loaded only
// when a note to check arrives (`loadNoteGuard` in `workspace/session.ts`).

/**
 * Why a note cannot be added over a selection `showsSelection` refuses, with the
 * one act that answers it. Selecting again in the rendered view gives the same
 * range and the same refusal, so it is not offered; the raw view places exactly.
 */
export const NOT_PLACED =
  "The rendered view could not place this passage exactly where you selected it. Select it in the raw view and add the note there.";
