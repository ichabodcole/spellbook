import { Search } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { entriesByKind } from "../state/contextLibrary";
import type { ContextEntry, ContextKind } from "../state/types";

// A small picker for choosing a single entry from the context library, filtered
// by `kind`. Used by the active-context tray (drawer) and the composer
// quick-prompt linker.
//
// Two render modes:
//   - DEFAULT (portal): rendered to document.body with fixed positioning anchored
//     to `triggerRef`, so it escapes overflow-clip / stacking-context traps. Used
//     by the active-context tray (it sits inside a drawer whose stacking context
//     would otherwise trap an in-tree popover). Self-manages outside-click.
//   - INLINE (`inline`): rendered in-place as a plain block, no portal, no fixed
//     positioning, no own outside-click handling. Used by the composer
//     quick-prompts dropdown, where the picker replaces the prompt list INSIDE the
//     same dropdown panel: it shares the dropdown's scroll (so it isn't clipped)
//     and the dropdown's own outside-click dismissal (so there's no portal/anchor/
//     double-outside-click conflict — the trigger that opens it can unmount safely).
export function LibraryPicker({
  triggerRef,
  inline = false,
  library,
  kind,
  excludeIds,
  onPick,
  onClose,
}: {
  triggerRef?: React.RefObject<HTMLElement | null>;
  inline?: boolean;
  library: ContextEntry[];
  kind: ContextKind;
  excludeIds: string[];
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Fixed position anchored above the trigger button (portal mode only).
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);

  // Measure the trigger's position and anchor the popover above it (portal mode).
  // Re-runs on scroll/resize so it tracks if the trigger moves.
  useLayoutEffect(() => {
    if (inline) return;
    function measure() {
      const el = triggerRef?.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setPos({
        left: Math.max(8, Math.min(r.left, window.innerWidth - 296)),
        bottom: window.innerHeight - r.top + 4,
      });
    }
    measure();
    window.addEventListener("scroll", measure, { capture: true, passive: true });
    window.addEventListener("resize", measure, { passive: true });
    return () => {
      window.removeEventListener("scroll", measure, { capture: true });
      window.removeEventListener("resize", measure);
    };
  }, [triggerRef, inline]);

  // Focus the search input on mount for immediate keyboard use.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Outside-click + Escape close (portal mode only — inline relies on the parent
  // dropdown's own dismissal, since it renders inside that dropdown's root).
  // Bug 2 fix: also treat the trigger button as "inside" so clicking it to open
  // the picker doesn't simultaneously close it (the trigger is not inside the
  // portaled rootRef, so without this exclusion that click fires onClose).
  useEffect(() => {
    if (inline) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      const insidePanel = rootRef.current?.contains(target) ?? false;
      const insideTrigger = triggerRef?.current?.contains(target) ?? false;
      if (!insidePanel && !insideTrigger) onClose();
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
  }, [onClose, triggerRef, inline]);

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

  // The panel contents — identical in both modes.
  const body = (
    <>
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
    </>
  );

  // Inline mode: render in-place inside the parent dropdown (no portal, no fixed
  // positioning). The parent's outside-click dismissal covers it.
  if (inline) {
    return (
      <div ref={rootRef} className="flex flex-col gap-0.5 max-h-72 overflow-hidden">
        {body}
      </div>
    );
  }

  // Portal mode: don't render until we have a position (avoids a flash at 0,0).
  if (!pos) return null;

  return createPortal(
    // Popover panel — fixed-positioned above the trigger, escapes any
    // overflow-clip or stacking-context trap in the ancestor tree.
    <div
      ref={rootRef}
      style={{ position: "fixed", left: pos.left, bottom: pos.bottom, width: 288, zIndex: 9999 }}
      className="card flex flex-col gap-0.5 max-h-72 overflow-hidden shadow-xl"
    >
      {body}
    </div>,
    document.body,
  );
}
