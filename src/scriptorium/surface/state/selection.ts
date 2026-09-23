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

import { selectionOnScreen } from "../../backend/selection";

/**
 * A selection in SOURCE coordinates — the same five values from either pane —
 * and the document text it was made in (E66), which App stamps on a report.
 */
export type HeldSelection = {
  doc: string;
  version: number;
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
  | { type: "drop" }
  /**
   * The document text on screen, whenever it may have changed (E66). Another
   * document or version is a clear: the selection was about text that is gone.
   */
  | { type: "shown"; doc: string | null; version: number | null };

/**
 * What is held after `event`. A report of the range already held returns the
 * held value itself, so React bails out of the render and the daemon is not
 * re-told — which is why the rendered pane no longer dedupes on its own (its
 * private memory went stale the moment the X or a note cleared the selection,
 * and then re-selecting the same passage reported nothing).
 */
export function heldAfter(held: HeldSelection | null, event: SelectionEvent): HeldSelection | null {
  if (event.type === "drop") return null;
  if (event.type === "shown")
    return selectionOnScreen(
      held,
      event.doc !== null && event.version !== null
        ? { doc: event.doc, version: event.version }
        : null,
    );
  const s = event.selection;
  if (s.from === s.to) return null;
  if (
    held &&
    held.doc === s.doc &&
    held.version === s.version &&
    held.from === s.from &&
    held.to === s.to &&
    held.text === s.text
  )
    return held;
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
 *
 * ⛔ AND A SELECTION THE BROWSER EMPTIED IS A COLLAPSE BY ANOTHER NAME. Chrome
 * does not always collapse: a click landing INSIDE the selected text removes
 * the range entirely, so `rangeCount` is 0 and there is no range to ask whose
 * it was. The handler used to give up there, and the result was Cole's rule
 * broken in the case nobody tested — the paint went, the chip stayed on a
 * passage nothing was holding, and it survived every later selection. **Both
 * readings of the DOM have to reach the same act**, so an emptied selection is
 * a clear exactly when a collapsed one would have been.
 *
 * ⚠ WHICH NEEDS THE PRESS, because an emptied selection carries no node to
 * attribute it with. `pressedHere` is that attribution and nothing more — a
 * transient fact about the last INPUT, like `contextClick` beside it, not a
 * second copy of the selection. It is what keeps clicking into the chat
 * composer from clearing the passage you are about to write about, which is the
 * whole point of the chip.
 */
export function renderedSelectionAct(s: {
  /** The selection is inside this pane. */
  ours: boolean;
  collapsed: boolean;
  /** The document has NO selection at all — `rangeCount === 0`. */
  gone: boolean;
  /** What it resolved to in source, when it is not collapsed. */
  resolved: { from: number; to: number } | null;
  /** The last pointer press in this pane was a context press over the selection. */
  contextClick: boolean;
  /** The last pointer press in the document landed inside this pane. */
  pressedHere: boolean;
}): "report" | "clear" | "keep" | "ignore" {
  if (s.gone) {
    if (!s.pressedHere) return "ignore";
    return s.contextClick ? "keep" : "clear";
  }
  if (!s.ours) return "ignore";
  if (s.collapsed) return s.contextClick ? "keep" : "clear";
  return s.resolved ? "report" : "ignore";
}

/**
 * The whole answer to one selection event: what is held, and whether the panes
 * must unpaint.
 *
 * ⛔ A CLEAR IS A CLEAR WHEREVER IT CAME FROM (Cole, 2026-09-22: "clicking in
 * either clears the selection, it's the simpler ux pattern"). In split view a
 * click in the RENDERED half clears a selection the RAW half is holding — and
 * CodeMirror reports only its own selection changes, so it went on holding the
 * range and painting the blurred grey highlight over a passage nothing had.
 * The same is true of the chip's X. Both are one thing: the held selection
 * went to null, so both panes drop the paint they own.
 *
 * ⚠ AND IT MUST NOT ECHO. The pane that unpaints collapses its own selection,
 * which it reports as an empty range — a second clear. It finds nothing held,
 * so it asks for no paint, and the round stops there.
 */
export function applySelectionEvent(
  held: HeldSelection | null,
  event: SelectionEvent,
): { held: HeldSelection | null; clearPaint: boolean } {
  const next = heldAfter(held, event);
  return { held: next, clearPaint: held !== null && next === null };
}

/**
 * Whether, after `event`, a context press is the reason for the next collapse.
 *
 * ⛔ A CONTEXT PRESS IS SPENT BY THE NEXT INPUT, whatever it is. Held until the
 * next POINTER press instead, one right-click made every later keyboard
 * collapse — a caret key, shift-arrow, Escape — look like a menu about to
 * open, and the chip sat on the old passage until the human happened to click
 * something. The menu it excuses opens on the press it came with.
 */
export function contextPressAfter(
  event: { kind: "pointerdown"; context: boolean } | { kind: "keydown" },
): boolean {
  return event.kind === "pointerdown" ? event.context : false;
}
