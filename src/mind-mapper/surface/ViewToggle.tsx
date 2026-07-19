// V1 — the map|grid segmented control. One component, two perches: the
// canvas Panel top-right (map view) and CardGrid's own top-right (grid
// view) — the toggle sits at the same spot in both, so switching never
// moves the control out from under the pointer. View state is App-local
// (a rendering choice, not board state — finding 6).

import { LayoutGrid, Map as MapIcon } from "lucide-react";
import { Button } from "./ui/button";

export type BoardView = "map" | "grid";

export function ViewToggle({
  view,
  onView,
}: {
  view: BoardView;
  onView: (view: BoardView) => void;
}) {
  return (
    <fieldset
      className="m-0 flex overflow-hidden rounded-md border border-border p-0"
      aria-label="Board view"
    >
      <Button
        variant="ghost"
        size="auto"
        aria-pressed={view === "map"}
        aria-label="Map view"
        title="Map view"
        onClick={() => onView("map")}
        className={`rounded-none px-2 py-1 text-[10px] uppercase tracking-wide ${
          view === "map" ? "bg-secondary text-foreground" : ""
        }`}
      >
        <MapIcon size={11} aria-hidden /> map
      </Button>
      <Button
        variant="ghost"
        size="auto"
        aria-pressed={view === "grid"}
        aria-label="Grid view"
        title="Grid view"
        onClick={() => onView("grid")}
        className={`rounded-none border-l border-border px-2 py-1 text-[10px] uppercase tracking-wide ${
          view === "grid" ? "bg-secondary text-foreground" : ""
        }`}
      >
        <LayoutGrid size={11} aria-hidden /> grid
      </Button>
    </fieldset>
  );
}
