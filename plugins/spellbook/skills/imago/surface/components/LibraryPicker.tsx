import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { entriesByKind } from "../state/contextLibrary";
import type { ContextEntry, ContextKind } from "../state/types";

// A small popover for picking a single entry from the context library, filtered
// by `kind`. Used by the active-context tray (Task 7) and the composer
// quick-prompt linker (Task 8) — not yet mounted anywhere; Tasks 7/8 wire it in.
//
// Outside-click uses the document pointerdown pattern (same as QuickPrompts in
// Conversation.tsx) so there are no bare non-interactive divs tripping the
// noStaticElementInteractions biome rule.
export function LibraryPicker({
  library,
  kind,
  excludeIds,
  onPick,
  onClose,
}: {
  library: ContextEntry[];
  kind: ContextKind;
  excludeIds: string[];
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the search input on mount for immediate keyboard use.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Outside-click + Escape close — mirrors QuickPrompts pattern exactly.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const byKind = entriesByKind(library, kind);
  const excludeSet = new Set(excludeIds);

  const filtered = byKind.filter((e) => {
    if (excludeSet.has(e.id)) return false;
    if (!query.trim()) return true;
    return e.name.toLowerCase().includes(query.toLowerCase());
  });

  // Greyed-out entries that are already-linked (excluded) — shown dimmed so the
  // user can see what's already active without being able to pick them again.
  const excluded = byKind.filter((e) => excludeSet.has(e.id));

  function pick(id: string) {
    onPick(id);
    onClose();
  }

  return (
    // Popover panel — positioned by the caller (absolute / relative wrapper).
    // Mirrors QuickPrompts: card, z-30, w-72, bottom-full pattern.
    <div
      ref={rootRef}
      className="absolute bottom-full mb-1 left-0 z-30 w-72 card flex flex-col gap-0.5 max-h-72 overflow-hidden"
    >
      {/* Search row */}
      <div className="flex items-center gap-1.5 px-2 pt-2 pb-1">
        <Search className="w-3 h-3 text-faint shrink-0" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${kind}s…`}
          className="flex-1 bg-transparent text-[12px] text-ink placeholder:text-faint focus:outline-none"
        />
      </div>

      <div className="overflow-y-auto flex flex-col gap-0.5 pb-1.5 px-1.5">
        {filtered.length === 0 && excluded.length === 0 && (
          <p className="text-[11px] text-faint italic px-2 py-2 text-center">no {kind}s to link</p>
        )}

        {filtered.length === 0 && query.trim() !== "" && excluded.length > 0 && (
          <p className="text-[11px] text-faint italic px-2 py-1.5 text-center">no matches</p>
        )}

        {/* Pickable entries */}
        {filtered.map((e) => (
          <button
            key={e.id}
            type="button"
            onClick={() => pick(e.id)}
            title={e.content || e.name}
            className="w-full text-left flex flex-col gap-0.5 rounded px-2 py-1 hover:bg-accent/10"
          >
            <span className="text-[12px] text-ink truncate font-medium">{e.name}</span>
            {e.content && <span className="text-[11px] text-faint truncate">{e.content}</span>}
          </button>
        ))}

        {/* Already-linked entries — greyed out, not clickable */}
        {excluded.length > 0 && filtered.length > 0 && (
          <div className="border-t border-divider my-0.5" />
        )}
        {excluded.map((e) => (
          <div
            key={e.id}
            className="flex flex-col gap-0.5 rounded px-2 py-1 opacity-40 cursor-default"
            title="Already linked"
          >
            <span className="text-[12px] text-ink truncate font-medium">{e.name}</span>
            {e.content && <span className="text-[11px] text-faint truncate">{e.content}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
