// The centre's dock: where a pane with a status strip asks the shell to draw
// the floating composer, between its content and the strip.
// A pane draws `CentreDock` just above its strip; the shell, given
// the place, draws the float (and the toasts' anchor above it) there, in the
// flow. With no dock on screen (a board, a stage's dashboard, the map) the
// float stays at the foot of the centre.

import { createContext, useContext } from "react";

/** The shell's setter for the dock's element: `null` when none is on screen. */
export const CentreDockContext = createContext<((el: HTMLElement | null) => void) | null>(null);

/** The place for the float, drawn by a pane just above its status strip. Empty without a float. */
export function CentreDock() {
  const claim = useContext(CentreDockContext);
  if (!claim) return null;
  return <div data-slot="centre-dock" ref={claim} className="flex shrink-0 flex-col" />;
}
