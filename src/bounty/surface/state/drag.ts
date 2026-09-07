// Where a drop lands, and where the insertion line is drawn.
//
// This is the one part of the board that is pure GEOMETRY rather than state,
// and it is the part a single synthetic `dragTo()` cannot exercise: the marker
// only exists between `dragstart` and `drop`, and the index is a midpoint
// comparison against the live card rects. Extracted so it is unit-tested
// without a browser; the hook feeds it `getBoundingClientRect()` results.
//
// Both functions take the cards EXCLUDING the one being dragged, which is what
// makes a within-column reorder index against its neighbours.

/** One card's live geometry, tagged with the id it belongs to. The id is what
 *  makes the marker survive a re-render: an INDEX into the reduced list is
 *  meaningless once React re-keys the column. */
export type CardBox = { id: string; top: number; height: number };

/**
 * The insertion index for a drop at `clientY`: the first card whose vertical
 * midpoint is below the pointer, else the end of the column (append).
 */
export function dropIndex(boxes: CardBox[], clientY: number): number {
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i] as CardBox;
    if (clientY < b.top + b.height / 2) return i;
  }
  return boxes.length;
}

/**
 * Where to draw the insertion line while hovering, named by CARD ID. `before`
 * on the card the drop would push down; `after` on the LAST card when the drop
 * would append and the column is not empty; `null` when the column has no other
 * cards (the empty drop zone's dashed border is the whole cue there).
 */
export function dropMarker(
  boxes: CardBox[],
  clientY: number,
): { id: string; edge: "before" | "after" } | null {
  const i = dropIndex(boxes, clientY);
  const before = boxes[i];
  if (before) return { id: before.id, edge: "before" };
  const last = boxes[boxes.length - 1];
  if (last) return { id: last.id, edge: "after" };
  return null;
}
