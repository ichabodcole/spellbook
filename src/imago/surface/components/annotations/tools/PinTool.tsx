// surface/components/annotations/tools/PinTool.tsx
// Pin: a click places a pin and opens an inline note field at that spot; Enter or
// blur commits the typed label, Shift+Enter adds a line, empty/Esc cancels. The
// editor is positioned in % of the image box, so it rides pan/zoom with the pin.
import { Pin } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { DEFAULT_TEXT_SIZE, PIN_MAX_W_FRACTION } from "../style";
import type { ToolPlugin, ToolUpResult } from "./types";

type PinDraft = { x: number; y: number; label: string };

function markId(): string {
  return crypto.randomUUID();
}

// The inline note editor — shared by draw mode (placing a new pin) and select
// mode (re-editing a committed pin's label). Presentational: it owns the input +
// focus dance and reports back through onSubmit/onCancel; the caller decides what
// a submit means (mark.add vs mark.update). Positioned at (x,y) in % of the image
// box and sized at fontSize px so it's WYSIWYG against the rendered pin.
//
// A real component so it can focus on the NEXT frame: autoFocus grabs focus
// synchronously on mount, then the placing click settles focus on the canvas and
// fires a spurious blur→cancel that flashes the editor away. We instead focus
// after the click resolves, and only honor a blur once the editor has held focus.
export function PinEditor({
  x,
  y,
  initialLabel,
  fontSize,
  onSubmit,
  onCancel,
}: {
  x: number;
  y: number;
  initialLabel: string;
  fontSize: number; // already × scale (px) — weld to the image like committed pins
  onSubmit: (label: string) => void;
  onCancel: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const armed = useRef(false);
  const [value, setValue] = useState(initialLabel);
  const [maxW, setMaxW] = useState<number | null>(null);

  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const el = textRef.current;
      el?.focus();
      // Cursor at END (not select-all): editing AMENDS, so Shift+Enter / typing
      // doesn't replace the whole note (which ate existing text + line breaks).
      // Empty draft → end == 0, no-op. (Cmd/Ctrl+A still selects-all to retype.)
      if (el) el.setSelectionRange(el.value.length, el.value.length);
      armed.current = true;
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  // Max width = a fraction of the image box (the editor's positioned ancestor),
  // in px so it matches the rendered note's CSS %. Tracks zoom via ResizeObserver.
  useLayoutEffect(() => {
    const box = wrapRef.current?.offsetParent as HTMLElement | null;
    if (!box) return;
    const apply = () => setMaxW(box.clientWidth * PIN_MAX_W_FRACTION);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(box);
    return () => ro.disconnect();
  }, []);

  // Auto-grow the height to fit the content (reset, then snap to scrollHeight) so
  // wrapped + multi-line notes aren't scrolled inside a fixed box.
  // biome-ignore lint/correctness/useExhaustiveDependencies: value/fontSize/maxW are the relayout signals — they change scrollHeight without being read here
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value, fontSize, maxW]);

  const submit = () => {
    const label = value.trim();
    if (!label)
      onCancel(); // empty → cancel (keep original); ✕ is for deletion
    else onSubmit(label);
  };

  return (
    <div
      ref={wrapRef}
      className="absolute -translate-x-1/2 -translate-y-1/2 z-10"
      style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <textarea
        ref={textRef}
        rows={1}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault(); // Enter commits; Shift+Enter falls through → newline
            submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        // ignore the blur the placing click triggers before the editor has focus
        onBlur={() => armed.current && submit()}
        placeholder="note… (⇧↵ line)"
        style={{
          fontSize: `${fontSize}px`,
          // w-max sizes to content up to maxWidth (the 45% cap) so editing wraps at
          // the same constant point as the render, independent of drag position; a
          // min floor keeps the empty/new-pin box usable instead of a sliver.
          minWidth: `${Math.round(Math.max(96, fontSize * 5))}px`,
          maxWidth: maxW ? `${maxW}px` : "280px",
        }}
        className="block w-max resize-none overflow-hidden bg-accent text-white placeholder-white/60 px-1.5 py-0.5 rounded shadow outline-none ring-1 ring-accent-fg/40 leading-tight whitespace-pre-wrap [overflow-wrap:anywhere]"
      />
    </div>
  );
}

export const PinTool: ToolPlugin = {
  id: "pin",
  icon: Pin,
  title: "Pin — label a spot",
  cursor: "cursor-crosshair",
  capturePointer: false, // a pin is a click, not a drag
  // ignore a new placement while an editor is already open
  onDown: (p, draft) => draft ?? { x: p.x, y: p.y, label: "" },
  onMove: (_p, draft) => draft,
  // a pin doesn't commit on pointerUp — keep the editor open until Enter/blur
  onUp: (_p, draft): ToolUpResult => ({ draft }),
  renderDraft: (draft, ctx) => {
    const d = draft as PinDraft | null;
    if (!d) return null;
    // WYSIWYG: type at the size you'll get, welded to the image
    const fontSize = (ctx.style.fontSize ?? DEFAULT_TEXT_SIZE) * ctx.scale;
    return (
      <PinEditor
        x={d.x}
        y={d.y}
        initialLabel={d.label}
        fontSize={fontSize}
        onSubmit={(label) => ctx.commit({ id: markId(), tool: "pin", label, x: d.x, y: d.y })}
        onCancel={ctx.cancel}
      />
    );
  },
};
