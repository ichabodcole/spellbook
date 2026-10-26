// While a modal is open, everything outside it is `inert`, and Tab cycles
// inside it.
//
// Base UI 1.6.0's modal focus trap lets Tab out: from a dialog's last button,
// focus went to one of its focus guards (invisible tab stops beside the popup)
// and on into the page behind (the search box, the top bar), and Shift+Tab
// reached the composer. The page root was never `inert`, and the guards did
// not send focus back. So the kit's modals do both themselves while their
// popup is open:
//
// - every other child of `<body>` is inert, so the browser keeps focus, clicks
//   and the accessibility tree inside the dialog. A portal that opens later (a
//   menu inside the dialog) is not touched, so it still works;
// - focus that lands beside the popup in its own portal (a guard) is sent to
//   the popup's first control when it came past the end, or its last when it
//   came back past the start: Tab and Shift+Tab go round.
//
// Undone when the popup starts closing (`data-closed`), before focus goes back
// to whatever opened it, and in any case when the popup goes.

/** What Tab stops on inside a popup, in order. */
const TABBABLE =
  'a[href], button, input, select, textarea, summary, [contenteditable="true"], [tabindex]';

/** `Node.DOCUMENT_POSITION_FOLLOWING`, without the global. */
const FOLLOWING = 4;

function tabbables(popup: HTMLElement): HTMLElement[] {
  return Array.from(popup.querySelectorAll<HTMLElement>(TABBABLE)).filter(
    (el) =>
      el.tabIndex >= 0 &&
      !(el as HTMLButtonElement).disabled &&
      !el.hidden &&
      !el.closest("[inert]"),
  );
}

/**
 * Make every child of `<body>` but the one holding `popup` inert, and keep Tab
 * inside the popup; returns the undo, which touches only what this call did.
 */
export function inertOutside(popup: HTMLElement): () => void {
  const body = popup.ownerDocument.body;
  let holder: HTMLElement | null = popup;
  while (holder && holder.parentElement !== body) holder = holder.parentElement;
  if (!holder) return () => {};
  const portal = holder;
  const made: HTMLElement[] = [];
  for (const child of Array.from(body.children)) {
    if (child === portal || !(child instanceof HTMLElement) || child.inert) continue;
    child.inert = true;
    made.push(child);
  }
  // Focus beside the popup, in its portal: round to the other end.
  const onFocusIn = (e: FocusEvent) => {
    const at = e.target;
    const El = popup.ownerDocument.defaultView?.HTMLElement;
    if (!El || !(at instanceof El)) return;
    if (popup.contains(at) || !portal.contains(at)) return;
    const stops = tabbables(popup);
    const pastEnd = (popup.compareDocumentPosition(at) & FOLLOWING) !== 0;
    const to = pastEnd ? stops[0] : stops[stops.length - 1];
    (to ?? popup).focus();
  };
  portal.addEventListener("focusin", onFocusIn);
  let undone = false;
  const undo = () => {
    if (undone) return;
    undone = true;
    observer?.disconnect();
    portal.removeEventListener("focusin", onFocusIn);
    for (const child of made) child.inert = false;
  };
  // Closing starts before the popup goes (an exit animation): let the page
  // back in then, so focus can return to the control that opened it.
  const View = popup.ownerDocument.defaultView;
  const observer = View?.MutationObserver
    ? new View.MutationObserver(() => {
        if (popup.hasAttribute("data-closed")) undo();
      })
    : null;
  observer?.observe(popup, { attributes: true, attributeFilter: ["data-closed"] });
  return undo;
}

/**
 * A callback ref for a modal's popup that keeps the rest of the page inert
 * while it is mounted and open (`inertOutside`). React 19 runs the returned
 * cleanup when the popup unmounts.
 */
export function inertOutsideRef(node: HTMLElement | null): (() => void) | undefined {
  if (!node) return undefined;
  return inertOutside(node);
}
