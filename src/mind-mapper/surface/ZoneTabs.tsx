// Round 3 (Claim Z3, circe's ratified layout ruling) — the zone tab strip:
// a SECOND header row rendered only when zones exist (the header proper
// stays lean), shaped `main | tabs | + zone`. A tab is a view switch, never
// a mutation; delete lives behind the tab's context menu (App owns the
// two-stage AlertDialog — the raw click never fires the DELETE, mirroring
// the doc-delete flow). Create is an inline name input, ProjectPicker's
// idiom — the id is a slug the daemon derives from this same name.

import { Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Zone } from "./types";
import { Button } from "./ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuTrigger,
} from "./ui/context-menu";

export function ZoneTabs({
  zones,
  active,
  onSwitch,
  onCreate,
  onDelete,
}: {
  zones: Zone[];
  // null = the main board.
  active: string | null;
  onSwitch: (zoneId: string | null) => void;
  onCreate: (name: string) => void;
  // Starts the confirm flow only — App escalates via the zone-not-empty 409.
  onDelete: (zone: Zone) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  const submit = () => {
    const n = name.trim();
    if (!n) return;
    onCreate(n);
    setName("");
    setCreating(false);
  };

  const tabClass = (isActive: boolean) =>
    `rounded-none border-b-2 px-2 py-1 text-xs ${
      isActive ? "border-ink text-ink" : "border-transparent text-ink-dim hover:text-ink"
    }`;

  return (
    <div className="flex items-center gap-1 border-b border-edge bg-surface px-4">
      <Button
        variant="ghost"
        size="auto"
        className={tabClass(active === null)}
        onClick={() => onSwitch(null)}
      >
        main
      </Button>
      {zones.map((z) => (
        <ContextMenu key={z.id}>
          <ContextMenuTrigger>
            <Button
              variant="ghost"
              size="auto"
              className={`${tabClass(active === z.id)} text-pending ${
                active === z.id ? "border-pending" : ""
              }`}
              onClick={() => onSwitch(z.id)}
            >
              {z.name}
            </Button>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuLabel>{z.name}</ContextMenuLabel>
            <ContextMenuItem onClick={() => onDelete(z)} className="text-attention">
              Delete zone…
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ))}
      {creating ? (
        <span className="ml-1 flex items-center gap-1.5">
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              if (e.key === "Escape") setCreating(false);
            }}
            placeholder="zone name…"
            aria-label="New zone name"
            className="w-32 rounded border border-edge bg-bg px-1.5 py-0.5 text-xs text-ink placeholder:text-ink-faint focus:outline-none"
          />
          <Button
            size="auto"
            className="px-2 py-0.5 text-xs"
            onClick={submit}
            disabled={!name.trim()}
          >
            create
          </Button>
        </span>
      ) : (
        <Button
          variant="ghost"
          size="auto"
          className="ml-1 gap-1 px-1.5 py-1 text-xs text-ink-faint hover:text-ink"
          onClick={() => setCreating(true)}
        >
          <Plus size={11} aria-hidden /> zone
        </Button>
      )}
    </div>
  );
}
