// R5 IC-c — the group-selected-into-a-zone modal. The multi-select scope is
// PENDING synthetics (zones hold proposals only); this modal moves them into an
// existing zone (a click) or a fresh one (name → create → move). App owns the
// two fetch paths (commitGroupInto / commitGroupNewZone) and the two-stage
// zone-not-empty machinery lives elsewhere — this is pure choice + naming.

import { Plus } from "lucide-react";
import { useState } from "react";
import type { Zone } from "./types";
import { Button } from "./ui/button";

export function ZoneGroupModal({
  count,
  zones,
  onPickExisting,
  onCreateNew,
  onCancel,
}: {
  // How many pending proposals are being grouped (the label's honesty).
  count: number;
  zones: Zone[];
  onPickExisting: (zoneId: string) => void;
  onCreateNew: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const submitNew = () => {
    if (name.trim()) onCreateNew(name);
  };
  return (
    <div className="absolute left-1/2 top-1/3 z-30 w-72 -translate-x-1/2 rounded-lg border border-edge bg-surface/95 p-3 shadow-xl backdrop-blur">
      <p className="mb-2 text-[10px] uppercase tracking-widest text-ink-faint">
        group {count} proposal{count === 1 ? "" : "s"} into a zone
      </p>
      {zones.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {zones.map((z) => (
            <Button
              key={z.id}
              variant="outline"
              size="auto"
              className="px-2 py-0.5 text-xs text-pending"
              onClick={() => onPickExisting(z.id)}
            >
              {z.name}
            </Button>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <input
          // biome-ignore lint/a11y/noAutofocus: the modal only exists because the user just summoned it
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitNew();
            if (e.key === "Escape") onCancel();
          }}
          placeholder="new zone name…"
          aria-label="New zone name"
          className="w-full rounded border border-edge bg-bg px-1.5 py-1 text-xs text-ink placeholder:text-ink-faint focus:outline-none"
        />
        <Button
          size="auto"
          className="flex items-center gap-0.5 px-2 py-1 text-xs"
          onClick={submitNew}
          disabled={!name.trim()}
        >
          <Plus size={11} aria-hidden /> new
        </Button>
      </div>
      <div className="mt-2 flex justify-end">
        <Button variant="ghost" size="auto" className="px-2 py-1 text-xs" onClick={onCancel}>
          cancel
        </Button>
      </div>
    </div>
  );
}
