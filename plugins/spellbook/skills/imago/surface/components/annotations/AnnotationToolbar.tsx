// surface/components/annotations/AnnotationToolbar.tsx
// The tool strip, built from the registry: a `select` pseudo-tool (hands the
// pointer to the viewport pan), each registered tool, a clear/eraser when there
// are marks, and color/width TRIGGERS that open right-flyout popovers (so the
// strip never grows wider than the 9×9 tool buttons). The style row sets the
// active draw style for NEW marks — or restyles the SELECTED mark when one is
// selected (Canvas routes onPick* accordingly).
import { ChevronRight, MousePointer, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { COLORS, TEXT_SIZES, WIDTHS } from "./style";
import { TOOL_ORDER, TOOL_REGISTRY } from "./tools/registry";

export function AnnotationToolbar({
  tool,
  setTool,
  hasMarks,
  onClear,
  activeColor,
  activeWidth,
  activeFontSize,
  pinSelected,
  onPickColor,
  onPickWidth,
  onPickFontSize,
}: {
  tool: string;
  setTool: (t: string) => void;
  hasMarks: boolean;
  onClear: () => void;
  activeColor?: string;
  activeWidth?: number;
  activeFontSize?: number;
  pinSelected?: boolean; // a pin is selected in select mode → size flyout restyles it
  onPickColor: (color: string) => void;
  onPickWidth: (width: number) => void;
  onPickFontSize: (px: number) => void;
}) {
  const [open, setOpen] = useState<"color" | "width" | "pinsize" | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // close the open popover on Esc or a press outside the toolbar (popovers are
  // children of rootRef, so clicks inside them don't count as "outside").
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const tools = [
    { id: "select", icon: MousePointer, title: "Select / pan" },
    ...TOOL_ORDER.map((id) => {
      const p = TOOL_REGISTRY[id];
      return { id: p.id, icon: p.icon, title: p.title };
    }),
  ];

  const lineWidth = activeWidth ?? 2;

  return (
    <div ref={rootRef} className="absolute top-4 left-4 flex flex-col gap-1.5 p-1.5 card">
      {tools.map(({ id, icon: Icon, title }) => {
        // The pin tool folds in a text-size flyout: clicking it when inactive
        // selects it; clicking it when already active toggles the size flyout.
        if (id === "pin") {
          const pinActive = tool === "pin";
          // the size flyout is reachable both in pin-draw mode AND when a pin is
          // selected in select mode (where it restyles that pin's size).
          const canSize = pinActive || pinSelected === true;
          const highlight = pinActive || open === "pinsize";
          return (
            <div key={id} className="relative">
              <button
                type="button"
                title={
                  pinActive ? "Pin — click again for text size" : pinSelected ? "Text size" : title
                }
                onClick={() => {
                  if (canSize) setOpen((o) => (o === "pinsize" ? null : "pinsize"));
                  else {
                    setTool("pin");
                    setOpen(null);
                  }
                }}
                className={`relative w-9 h-9 rounded-md flex items-center justify-center border transition-colors ${
                  highlight
                    ? "bg-accent/25 border-accent/60 text-accent-ink"
                    : "border-edge text-muted hover:text-white hover:border-edge-hover"
                }`}
              >
                <Icon className="w-4 h-4" />
                {canSize && (
                  <ChevronRight className="absolute bottom-0.5 right-0.5 w-2.5 h-2.5 text-accent-ink" />
                )}
              </button>
              {open === "pinsize" && canSize && (
                <div className="absolute left-full ml-2 top-0 z-30 card p-1.5 flex flex-col gap-1">
                  {TEXT_SIZES.map((s) => (
                    <button
                      type="button"
                      key={s.name}
                      title={s.name}
                      aria-label={`${s.name} text size`}
                      onClick={() => {
                        onPickFontSize(s.value);
                        setOpen(null);
                      }}
                      className={`flex items-center justify-center min-w-[2.25rem] px-2 py-1 rounded border transition-colors ${
                        activeFontSize === s.value
                          ? "bg-accent/25 border-accent/60 text-accent-ink"
                          : "border-edge text-ink hover:border-edge-hover"
                      }`}
                    >
                      <span style={{ fontSize: `${s.value}px`, lineHeight: 1 }}>A</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        }
        return (
          <button
            type="button"
            key={id}
            title={title}
            onClick={() => {
              setTool(id);
              setOpen(null);
            }}
            className={`w-9 h-9 rounded-md flex items-center justify-center border transition-colors ${
              tool === id
                ? "bg-accent/25 border-accent/60 text-accent-ink"
                : "border-edge text-muted hover:text-white hover:border-edge-hover"
            }`}
          >
            <Icon className="w-4 h-4" />
          </button>
        );
      })}
      {hasMarks && (
        <button
          type="button"
          title="Clear all annotations"
          onClick={onClear}
          className="w-9 h-9 rounded-md flex items-center justify-center border border-edge text-muted hover:text-white hover:border-edge-hover"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      )}

      {/* style triggers — color + width, each opening a right-flyout popover */}
      <div className="border-t border-divider pt-1.5 flex flex-col gap-1.5">
        {/* COLOR */}
        <div className="relative">
          <button
            type="button"
            title="Color"
            aria-label="Color"
            onClick={() => setOpen((o) => (o === "color" ? null : "color"))}
            className={`w-9 h-9 rounded-md flex items-center justify-center border transition-colors ${
              open === "color"
                ? "bg-accent/25 border-accent/60"
                : "border-edge hover:border-edge-hover"
            }`}
          >
            <span
              className="w-5 h-5 rounded-full border border-black/30"
              style={{ backgroundColor: activeColor }}
            />
          </button>
          {open === "color" && (
            <div className="absolute left-full ml-2 top-0 z-30 card p-1.5 grid grid-cols-[repeat(3,1.5rem)] gap-1.5">
              {COLORS.map((c) => (
                <button
                  type="button"
                  key={c.name}
                  title={c.name}
                  aria-label={c.name}
                  onClick={() => {
                    onPickColor(c.value);
                    setOpen(null);
                  }}
                  style={{ backgroundColor: c.value }}
                  className={`w-6 h-6 rounded-full ${
                    activeColor === c.value
                      ? "ring-2 ring-white ring-offset-1 ring-offset-surface"
                      : "border border-edge"
                  }`}
                />
              ))}
            </div>
          )}
        </div>

        {/* WIDTH — preview each option as a line at its actual thickness */}
        <div className="relative">
          <button
            type="button"
            title="Thickness"
            aria-label="Thickness"
            onClick={() => setOpen((o) => (o === "width" ? null : "width"))}
            className={`w-9 h-9 rounded-md flex items-center justify-center border transition-colors ${
              open === "width"
                ? "bg-accent/25 border-accent/60"
                : "border-edge hover:border-edge-hover"
            }`}
          >
            <span
              className="w-5 rounded-full bg-ink"
              style={{ height: `${lineWidth}px`, backgroundColor: activeColor }}
            />
          </button>
          {open === "width" && (
            <div className="absolute left-full ml-2 top-0 z-30 card p-1.5 flex flex-col gap-1">
              {WIDTHS.map((w) => (
                <button
                  type="button"
                  key={w.name}
                  title={w.name}
                  aria-label={`${w.name} thickness`}
                  onClick={() => {
                    onPickWidth(w.value);
                    setOpen(null);
                  }}
                  className={`flex items-center justify-center w-12 h-6 rounded border transition-colors ${
                    activeWidth === w.value
                      ? "bg-accent/25 border-accent/60"
                      : "border-edge hover:border-edge-hover"
                  }`}
                >
                  <span className="w-8 rounded-full bg-ink" style={{ height: `${w.value}px` }} />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
