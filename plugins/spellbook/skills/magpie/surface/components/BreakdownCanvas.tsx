// surface/components/BreakdownCanvas.tsx
// The central stage: the source composite with the discovered element bboxes
// overlaid as an EDITABLE, co-presence layer. Boxes live in fraction space
// (0..1 of the image box, the imago model) and convert to/from canonical source
// pixels at the edges via geometry.ts. Pointer-only (no onClick/onDoubleClick on
// static elements) so biome's noStaticElementInteractions stays quiet — double-
// press is detected via e.detail, exactly like imago's SelectionOverlay.
//
// Gestures: select (press a box), move (drag a selected box), resize (drag one of
// 8 handles), draw (arm "mark a missed region" → drag on empty), rename (double-
// press the name), retype (press the type chip → cycle), delete (✕). Move/resize
// preview live and COMMIT ON RELEASE (element.update); draw commits element.add;
// rename/retype/delete fire immediately.
import { Plus, X } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import type { ClientToServer, Element, Source } from "../state/types";
import {
  bboxToFrac,
  clampFrac,
  drawBoxFromCorners,
  type FracBox,
  fracToBbox,
  isDrawable,
  resizeFracBox,
} from "./breakdown/geometry";
import { TypeMenu } from "./breakdown/TypeMenu";
import { typeColor } from "./breakdown/typeColor";

// commit gate for a move/resize — a sub-threshold drag is a select, not an edit.
const MOVE_THRESHOLD = 0.004;

// the 8 resize handles for a box, positioned in fraction space (corners + edges).
const HANDLES: { id: string; fx: number; fy: number; cursor: string }[] = [
  { id: "nw", fx: 0, fy: 0, cursor: "nwse-resize" },
  { id: "ne", fx: 1, fy: 0, cursor: "nesw-resize" },
  { id: "se", fx: 1, fy: 1, cursor: "nwse-resize" },
  { id: "sw", fx: 0, fy: 1, cursor: "nesw-resize" },
  { id: "n", fx: 0.5, fy: 0, cursor: "ns-resize" },
  { id: "e", fx: 1, fy: 0.5, cursor: "ew-resize" },
  { id: "s", fx: 0.5, fy: 1, cursor: "ns-resize" },
  { id: "w", fx: 0, fy: 0.5, cursor: "ew-resize" },
];

// pointer position as a 0..1 fraction of the event's currentTarget, clamped so a
// drag that leaves the box still yields in-bounds coords (adapted from imago's frac).
function frac(e: React.PointerEvent<HTMLElement>): { x: number; y: number } {
  const r = e.currentTarget.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
    y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
  };
}

function basename(p: string): string {
  return p.split("/").pop() ?? p;
}

// a transient drag over the selected box: a move ("") or a resize (handle id).
type Gesture = {
  handle: string; // "" = move, else a resize handle id
  start: { x: number; y: number };
  cur: { x: number; y: number };
};

export function BreakdownCanvas({
  source,
  elements,
  send,
}: {
  source: Source;
  elements: Element[];
  send: (m: ClientToServer) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [armed, setArmed] = useState(false); // "mark a missed region" mode
  const [draft, setDraft] = useState<{ start: { x: number; y: number }; box: FracBox } | null>(
    null,
  );
  const [editingId, setEditingId] = useState<string | null>(null); // inline rename target

  const size = source.size;
  const selected = elements.find((e) => e.id === selectedId) ?? null;

  // Escape disarms draw mode / cancels an in-flight draft (mirrors the toolbar copy).
  useEffect(() => {
    if (!armed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setArmed(false);
        setDraft(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [armed]);

  // the live fraction box for an element — the selected one rides the in-flight
  // gesture (move = translate + clamp; resize = anchor the opposite edge).
  function liveFrac(el: Element): FracBox {
    const base = bboxToFrac(el.bbox, size);
    if (!gesture || el.id !== selectedId) return base;
    const dx = gesture.cur.x - gesture.start.x;
    const dy = gesture.cur.y - gesture.start.y;
    if (gesture.handle === "") return clampFrac({ ...base, x: base.x + dx, y: base.y + dy });
    return resizeFracBox(base, gesture.handle, dx, dy);
  }

  // topmost non-dropped element under p (later in the array paints on top).
  function topHit(p: { x: number; y: number }): Element | null {
    for (let i = elements.length - 1; i >= 0; i--) {
      const el = elements[i];
      if (!el || el.status === "dropped") continue;
      const f = bboxToFrac(el.bbox, size);
      if (p.x >= f.x && p.x <= f.x + f.w && p.y >= f.y && p.y <= f.y + f.h) return el;
    }
    return null;
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (editingId) setEditingId(null); // a press elsewhere ends an open rename (blur commits)
    const handle = (e.target as HTMLElement).dataset.handle;
    const p = frac(e);
    if (handle !== undefined && selected) {
      // grabbing a resize handle of the selected box
      e.stopPropagation();
      setGesture({ handle, start: p, cur: p });
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    if (armed) {
      // draw mode: start a region draft from this corner
      setDraft({ start: p, box: drawBoxFromCorners(p.x, p.y, p.x, p.y) });
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    const hit = topHit(p);
    if (!hit) {
      setSelectedId(null);
      return;
    }
    setSelectedId(hit.id);
    if (e.detail >= 2) {
      // double-press a box → rename it inline (no move). Detected via e.detail so
      // the surface stays pointer-only (biome flags onDoubleClick on a div).
      setEditingId(hit.id);
      return;
    }
    setGesture({ handle: "", start: p, cur: p });
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const p = frac(e);
    if (draft) {
      setDraft({
        start: draft.start,
        box: drawBoxFromCorners(draft.start.x, draft.start.y, p.x, p.y),
      });
      return;
    }
    if (gesture) setGesture({ ...gesture, cur: p });
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (draft) {
      if (isDrawable(draft.box)) {
        send({
          type: "element.add",
          element: { bbox: fracToBbox(draft.box, size), type: "other" },
        });
      }
      setDraft(null);
      setArmed(false); // explicit toggle → disarm after one region
      return;
    }
    if (gesture && selected) {
      const moved =
        Math.hypot(gesture.cur.x - gesture.start.x, gesture.cur.y - gesture.start.y) >=
        MOVE_THRESHOLD;
      if (moved) {
        send({
          type: "element.update",
          id: selected.id,
          patch: { bbox: fracToBbox(liveFrac(selected), size) },
        });
      }
    }
    setGesture(null);
  }

  return (
    <section className="card workspace relative min-h-0 h-full overflow-hidden flex items-center justify-center">
      {/* the toolbar — arm/disarm the draw gesture */}
      <div className="absolute top-2 left-2 z-20 flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            setArmed((a) => !a);
            setSelectedId(null);
          }}
          className={armed ? "btn-primary !px-3 !py-1.5 text-xs" : "btn-ghost"}
          title="Draw a box around a region magpie missed"
        >
          <Plus className="w-3.5 h-3.5" />{" "}
          {armed ? "Marking… (esc to stop)" : "Mark a missed region"}
        </button>
      </div>

      {/* image + overlay — the overlay is the single pointer surface */}
      <div className="relative max-w-full max-h-full">
        <img
          src={`/assets/${basename(source.path)}`}
          alt="composite under review"
          className="block max-w-full max-h-full object-contain select-none"
          draggable={false}
        />
        <div
          className="absolute inset-0"
          style={{ cursor: armed ? "crosshair" : "default", touchAction: "none" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          {elements.map((el, i) => (
            <Box
              key={el.id}
              el={el}
              index={i + 1}
              box={liveFrac(el)}
              color={typeColor(el.type)}
              selected={el.id === selectedId}
              editing={el.id === editingId}
              send={send}
              onRenameDone={() => setEditingId(null)}
            />
          ))}
          {draft && (
            <div
              className="absolute border-2 border-dashed pointer-events-none"
              style={{
                left: `${draft.box.x * 100}%`,
                top: `${draft.box.y * 100}%`,
                width: `${draft.box.w * 100}%`,
                height: `${draft.box.h * 100}%`,
                borderColor: "var(--color-type-pictorial)",
                background: "color-mix(in srgb, var(--color-type-pictorial) 12%, transparent)",
              }}
            />
          )}
        </div>
      </div>
    </section>
  );
}

function Box({
  el,
  index,
  box,
  color,
  selected,
  editing,
  send,
  onRenameDone,
}: {
  el: Element;
  index: number;
  box: FracBox;
  color: string;
  selected: boolean;
  editing: boolean;
  send: (m: ClientToServer) => void;
  onRenameDone: () => void;
}) {
  const dropped = el.status === "dropped";
  return (
    <div
      className="absolute"
      style={{
        left: `${box.x * 100}%`,
        top: `${box.y * 100}%`,
        width: `${box.w * 100}%`,
        height: `${box.h * 100}%`,
        opacity: dropped ? 0.3 : 1,
      }}
    >
      {/* the box outline — pointer-events none so the overlay hit-tests it */}
      <div
        className="absolute inset-0 rounded-[2px] pointer-events-none"
        style={{
          border: `2px solid ${color}`,
          boxShadow: selected
            ? `0 0 0 1px ${color}, 0 0 0 4px color-mix(in srgb, var(--color-accent) 35%, transparent)`
            : undefined,
        }}
      />

      {/* numbered tag + name (sits just above the box's top-left) */}
      <div
        className="absolute -top-6 left-0 flex items-center gap-1 max-w-[260px]"
        style={{ pointerEvents: "none" }}
      >
        <span
          className="text-[10px] font-bold px-1 rounded-sm leading-tight"
          style={{ background: color, color: "var(--color-bg)" }}
        >
          {index}
        </span>
        {editing ? (
          <RenameInput
            initial={el.name}
            onCommit={(name) => {
              if (name && name !== el.name)
                send({ type: "element.update", id: el.id, patch: { name } });
              onRenameDone();
            }}
          />
        ) : (
          <span
            className="text-[11px] px-1 rounded-sm truncate"
            style={{
              background: "color-mix(in srgb, var(--color-bg) 88%, transparent)",
              color: "var(--color-ink)",
            }}
          >
            {el.name}
          </span>
        )}
      </div>

      {/* selected chrome: type chip (cycle), delete, resize handles */}
      {selected && !editing && (
        <>
          <div
            className="absolute -bottom-7 left-0 flex items-center gap-1"
            style={{ pointerEvents: "auto" }}
          >
            <TypeMenu
              value={el.type}
              color={color}
              solid
              onChange={(t) => send({ type: "element.update", id: el.id, patch: { type: t } })}
            />
            <Chip
              title="Delete this box"
              onClick={() => send({ type: "element.remove", id: el.id })}
            >
              <X className="w-3 h-3" />
            </Chip>
          </div>
          {HANDLES.map((h) => (
            <div
              key={h.id}
              data-handle={h.id}
              className="absolute w-2.5 h-2.5 -translate-x-1/2 -translate-y-1/2 rounded-sm bg-accent border border-edge"
              style={{
                left: `${h.fx * 100}%`,
                top: `${h.fy * 100}%`,
                cursor: h.cursor,
                pointerEvents: "auto",
              }}
            />
          ))}
        </>
      )}
    </div>
  );
}

function RenameInput({ initial, onCommit }: { initial: string; onCommit: (name: string) => void }) {
  const [val, setVal] = useState(initial);
  return (
    <input
      // biome-ignore lint/a11y/noAutofocus: inline rename should grab focus immediately
      autoFocus
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit(val.trim());
        else if (e.key === "Escape") onCommit("");
      }}
      onBlur={() => onCommit(val.trim())}
      className="text-[11px] px-1 rounded-sm bg-surface-2 border border-accent text-ink outline-none"
      style={{ pointerEvents: "auto", width: "12ch" }}
    />
  );
}

function Chip({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onClick}
      className="text-[10px] px-1.5 py-0.5 rounded-sm bg-surface border border-edge text-muted hover:text-accent-ink hover:border-accent flex items-center gap-1"
    >
      {children}
    </button>
  );
}
