// The selection the chat's context chip mirrors — the rules, without React or
// a DOM, so they are cells rather than something to eyeball.
//
// ⛔ ONE HELD SELECTION, AND THE CHIP IS IT. The surface used to keep a second
// piece of state in the composer (`dropped`) that hid the chip, and it
// outlived the passage it was about: after the X, every new selection was
// hidden too, in both modes. And the daemon never heard about the X at all —
// `say` attaches the selection the DAEMON holds (App.tsx), so a hidden chip
// was a surface-only answer to a daemon-side question. Now the X clears the
// held selection itself, which App reports to the daemon like any other change.

/** A selection in SOURCE coordinates — the same five values from either pane. */
export type HeldSelection = {
  from: number;
  to: number;
  fromLine: number;
  toLine: number;
  text: string;
};

export type SelectionEvent =
  /** A pane reported its selection; an empty range means it has none. */
  | { type: "report"; selection: HeldSelection }
  /** The chip's X: send without this passage. */
  | { type: "drop" };

/**
 * What is held after `event`. A report of the range already held returns the
 * held value itself, so React bails out of the render and the daemon is not
 * re-told — which is why the rendered pane no longer dedupes on its own (its
 * private memory went stale the moment the X or a note cleared the selection,
 * and then re-selecting the same passage reported nothing).
 */
export function heldAfter(held: HeldSelection | null, event: SelectionEvent): HeldSelection | null {
  if (event.type === "drop") return null;
  const s = event.selection;
  if (s.from === s.to) return null;
  if (held && held.from === s.from && held.to === s.to && held.text === s.text) return held;
  return s;
}

/**
 * What the rendered pane does with one `selectionchange`.
 *
 * - `report` — a selection in this pane that resolves to source.
 * - `clear` — the selection in this pane collapsed: a click in the text, or a
 *   caret key. The raw view already clears on this (CodeMirror reports the
 *   empty range); the rendered view used to say nothing, and the chip stayed.
 * - `keep` — collapsed by a RIGHT-click OVER the selection, which is about to
 *   open the note menu on the passage it just collapsed. The pane's remembered
 *   range is what that menu acts on, so neither it nor the chip may be cleared.
 *   A right-click anywhere else is an ordinary click and clears.
 * - `ignore` — the selection is somewhere else (the chat, the raw half), or it
 *   cannot be placed; saying nothing beats saying something wrong.
 */
export function renderedSelectionAct(s: {
  /** The selection is inside this pane. */
  ours: boolean;
  collapsed: boolean;
  /** What it resolved to in source, when it is not collapsed. */
  resolved: { from: number; to: number } | null;
  /** The last pointer press in this pane was a context press over the selection. */
  contextClick: boolean;
}): "report" | "clear" | "keep" | "ignore" {
  if (!s.ours) return "ignore";
  if (s.collapsed) return s.contextClick ? "keep" : "clear";
  return s.resolved ? "report" : "ignore";
}
