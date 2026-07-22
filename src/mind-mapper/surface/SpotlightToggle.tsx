// R5 SL — the spotlight control, perched in the canvas Panel top-right beside
// ViewToggle (so it's map-view only by construction — panelTopRight renders
// only in map view, and the spotlight is a shared-CONNECTIONS view the edgeless
// grid can't show). Enabled only at ≥2 selected nodes (the intersection needs
// two); a press dims everything except the selection and its shared neighbors,
// a second press restores. The button IS the clickable affordance — no
// keyboard summon, so no orphan-key twin to keep.

import { Flashlight } from "lucide-react";
import { Button } from "./ui/button";

export function SpotlightToggle({
  active,
  enabled,
  onToggle,
}: {
  active: boolean;
  enabled: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      variant="outline"
      size="auto"
      aria-pressed={active}
      aria-label="Highlight shared connections"
      title={
        enabled
          ? "Highlight the connections these nodes share"
          : "Select 2+ nodes to highlight shared connections"
      }
      disabled={!enabled}
      onClick={onToggle}
      className={`px-2 py-1 text-[10px] uppercase tracking-wide ${
        active ? "bg-secondary text-foreground" : ""
      }`}
    >
      <Flashlight size={11} aria-hidden /> shared
    </Button>
  );
}
