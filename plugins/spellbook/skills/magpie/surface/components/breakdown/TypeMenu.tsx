// surface/components/breakdown/TypeMenu.tsx
// A custom type picker: a pill that opens a menu of the element taxonomy and lets
// you pick directly — replacing the click-to-cycle chip (a slog as the list grows,
// and one stray click overshoots). The menu renders through a PORTAL so it escapes
// the canvas/list `overflow-hidden` clipping. onChange fires ONLY on an actual
// change, so picking the current type is a no-op (no redundant element.update →
// no spurious conversation message).
import { Check, ChevronsUpDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ElementType } from "../../state/types";
import { ELEMENT_TYPES } from "../../state/types";

export function TypeMenu({
  value,
  color,
  onChange,
  solid,
}: {
  value: ElementType;
  color?: string;
  onChange: (t: ElementType) => void;
  // solid: give the pill an opaque backdrop — required on the canvas, where it
  // floats over arbitrary image content (a transparent chip vanishes on a
  // light board). Omit on the dark rail, where the chip reads fine.
  solid?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (btnRef.current?.contains(t) || t.closest("[data-typemenu]")) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDocDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDocDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function toggle() {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ left: r.left, top: r.bottom + 4 });
    }
    setOpen((o) => !o);
  }

  function pick(t: ElementType) {
    if (t !== value) onChange(t);
    setOpen(false);
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        title="Set element type"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={toggle}
        className={`chip !px-2 !py-0.5 shrink-0 inline-flex items-center gap-1 ${
          solid ? "!bg-surface-2 border-edge-strong shadow-md" : ""
        }`}
      >
        {color && <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />}
        {value}
        <ChevronsUpDown className="w-3 h-3 opacity-60" />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            data-typemenu
            className="fixed z-50 min-w-[150px] max-h-[60vh] overflow-auto rounded-md border border-edge bg-surface-2 shadow-lg py-1"
            style={{ left: pos.left, top: pos.top }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {ELEMENT_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => pick(t)}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-left text-ink hover:bg-surface-3"
              >
                <Check
                  className={`w-3 h-3 shrink-0 ${t === value ? "opacity-100" : "opacity-0"}`}
                />
                {t}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
