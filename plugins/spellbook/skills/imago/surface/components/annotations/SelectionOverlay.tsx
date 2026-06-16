// surface/components/annotations/SelectionOverlay.tsx
// Active only in the "select" tool (AnnotationLayer renders it then, keyed on the
// focused variant so selection clears on image change). Selection is a SET, lifted
// to Canvas (controlled) and shared with the layers panel. One pointer surface over
// the image handles select / move / resize / delete:
//   press a mark        → single-select (replace the set; topmost via hitTest,
//                         effective-z DESCENDING), no pan
//   shift/⌘-press a mark → toggle it in the set (for grouping); no move
//   press empty         → clear the set + bubble to the stage's pan
//   drag a mark         → move (single only); commit on release via mark.update
//   drag a handle       → resize (single only), opposite anchor fixed; mark.update
//   ✕ / pencil          → mark.remove / re-edit a pin label (single only)
// Multi-select is for GROUPING (panel → group), not multi-transform: ≥2 selected
// just outline. Inter-layer z-order lives in the panel now (layer.reorder), so the
// old per-selection forward/back chevrons are retired.
import { Pencil, X } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import type { ClientToServer, Layer, Mark } from "../../state/types";
import {
  type Box,
  byEffectiveZ,
  frac,
  hitTest,
  isMarkSelectable,
  markBounds,
  type PinSize,
  type Point,
} from "./coords";
import { DEFAULT_TEXT_SIZE } from "./style";
import { PinEditor } from "./tools/PinTool";

const MOVE_THRESHOLD = 0.005; // sub-threshold gesture = select-only (no update)
const MIN_SIZE = 0.01; // min shape extent on resize (fractions)
const PAD = 0.012; // breathing room around the highlight
const MIN_HL = 0.04; // min highlight size so points/thin marks stay grabbable

// A mid-gesture transform of the selected mark. handle is "" for a move.
// shift carries the live modifier: on a corner resize it flips the aspect
// behavior ("Shift = the other aspect behavior" — see resize()).
type Gesture = {
  type: "move" | "resize";
  handle: string;
  start: Point;
  cur: Point;
  shift: boolean;
};

// the four corner handle ids — these carry aspect behavior; edge handles (n/e/s/w)
// stay free 1-axis stretches regardless of Shift.
const CORNERS = new Set(["nw", "ne", "se", "sw"]);

// ── geometry (pure) ──────────────────────────────────────────────────────────

function translate(m: Mark, dx: number, dy: number): Mark {
  switch (m.tool) {
    case "pin":
      return { ...m, x: m.x + dx, y: m.y + dy };
    case "arrow":
    case "line":
      return {
        ...m,
        x1: m.x1 + dx,
        y1: m.y1 + dy,
        x2: m.x2 + dx,
        y2: m.y2 + dy,
      };
    case "rect":
    case "image": // rect geometry
      return { ...m, x: m.x + dx, y: m.y + dy };
    case "ellipse":
      return { ...m, cx: m.cx + dx, cy: m.cy + dy };
    case "draw":
      return { ...m, points: m.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
  }
}

// resize a box by dragging the named handle; the opposite edge(s) stay fixed.
export function resizeBox(box: Box, handle: string, dx: number, dy: number): Box {
  let L = box.x;
  let R = box.x + box.w;
  let T = box.y;
  let B = box.y + box.h;
  if (handle.includes("w")) L = Math.min(R - MIN_SIZE, box.x + dx);
  if (handle.includes("e")) R = Math.max(L + MIN_SIZE, box.x + box.w + dx);
  if (handle.includes("n")) T = Math.min(B - MIN_SIZE, box.y + dy);
  if (handle.includes("s")) B = Math.max(T + MIN_SIZE, box.y + box.h + dy);
  return { x: L, y: T, w: R - L, h: B - T };
}

// Aspect-locked corner resize: the corner OPPOSITE the handle is the anchor and
// stays put; the box scales UNIFORMLY (keeps its w:h). We project the drag delta
// onto the anchor→corner diagonal to get one scale factor, so the dragged corner
// tracks the cursor along that diagonal instead of free-distorting.
export function resizeBoxAspect(box: Box, handle: string, dx: number, dy: number): Box {
  const { x, y, w, h } = box;
  if (w <= 0 || h <= 0) return resizeBox(box, handle, dx, dy); // degenerate → free
  const west = handle.includes("w");
  const north = handle.includes("n");
  // diagonal vector from the fixed anchor to the moving corner (|Dx|=w, |Dy|=h)
  const Dx = west ? -w : w;
  const Dy = north ? -h : h;
  const t = (dx * Dx + dy * Dy) / (Dx * Dx + Dy * Dy); // signed scale delta
  // clamp so neither side underflows MIN_SIZE (uniform → gate on the smaller side)
  const s = Math.max(1 + t, MIN_SIZE / Math.min(w, h));
  const nw = w * s;
  const nh = h * s;
  // hold the anchor edge fixed; the box grows from it toward the dragged corner
  const nx = west ? x + w - nw : x; // east edge fixed when dragging west
  const ny = north ? y + h - nh : y; // south edge fixed when dragging north
  return { x: nx, y: ny, w: nw, h: nh };
}

// pick the aspect-locked corner resize when `lock`, else the free per-edge resize.
// edge handles are never aspect-locked (they're explicit 1-axis stretches).
export function resizeBoxFor(box: Box, handle: string, dx: number, dy: number, lock: boolean): Box {
  return lock && CORNERS.has(handle)
    ? resizeBoxAspect(box, handle, dx, dy)
    : resizeBox(box, handle, dx, dy);
}

// shift flips the per-tool default aspect behavior on a CORNER drag:
//   IMAGE marks  → aspect-locked by default; Shift free-distorts.
//   everything else (rect/ellipse/draw) → free by default; Shift locks aspect.
function resize(m: Mark, handle: string, dx: number, dy: number, shift: boolean): Mark {
  switch (m.tool) {
    case "pin":
      return m; // no resize
    case "arrow":
    case "line":
      return handle === "p1"
        ? { ...m, x1: m.x1 + dx, y1: m.y1 + dy }
        : { ...m, x2: m.x2 + dx, y2: m.y2 + dy };
    case "rect":
    case "image": {
      const lock = m.tool === "image" ? !shift : shift;
      const b = resizeBoxFor({ x: m.x, y: m.y, w: m.w, h: m.h }, handle, dx, dy, lock);
      return { ...m, ...b };
    }
    case "ellipse": {
      const b = resizeBoxFor(
        { x: m.cx - m.rx, y: m.cy - m.ry, w: m.rx * 2, h: m.ry * 2 },
        handle,
        dx,
        dy,
        shift,
      );
      return {
        ...m,
        cx: b.x + b.w / 2,
        cy: b.y + b.h / 2,
        rx: b.w / 2,
        ry: b.h / 2,
      };
    }
    case "draw": {
      // scale every point proportionally into the resized bbox (degenerate axis
      // with zero extent stays put — avoids /0)
      const old = markBounds(m);
      const b = resizeBoxFor(old, handle, dx, dy, shift);
      const sx = old.w > 0 ? b.w / old.w : 1;
      const sy = old.h > 0 ? b.h / old.h : 1;
      return {
        ...m,
        points: m.points.map((p) => ({
          x: b.x + (p.x - old.x) * sx,
          y: b.y + (p.y - old.y) * sy,
        })),
      };
    }
  }
}

function applyGesture(m: Mark, g: Gesture): Mark {
  const dx = g.cur.x - g.start.x;
  const dy = g.cur.y - g.start.y;
  return g.type === "move" ? translate(m, dx, dy) : resize(m, g.handle, dx, dy, g.shift);
}

// Edge policy: keep a note FULLY inside the image. Clamp a pin's center by its
// measured half-box so the whole note stays within [0,1] — it bumps the edge
// instead of crossing/clipping. Pins only (arrows/shapes may point over an edge);
// no-op until measured (size 0). max-width ~45% guarantees w,h<1 → range valid.
function clampToImage(m: Mark, pinSize?: PinSize): Mark {
  if (m.tool !== "pin" || !pinSize || (pinSize.w === 0 && pinSize.h === 0)) return m;
  const hw = pinSize.w / 2;
  const hh = pinSize.h / 2;
  return {
    ...m,
    x: Math.min(1 - hw, Math.max(hw, m.x)),
    y: Math.min(1 - hh, Math.max(hh, m.y)),
  };
}

// the geometry keys to send on commit (server merges; never id/tool/zOrder)
function geometryPatch(m: Mark): Record<string, number | { x: number; y: number }[]> {
  switch (m.tool) {
    case "pin":
      return { x: m.x, y: m.y };
    case "arrow":
    case "line":
      return { x1: m.x1, y1: m.y1, x2: m.x2, y2: m.y2 };
    case "rect":
    case "image": // rect geometry
      return { x: m.x, y: m.y, w: m.w, h: m.h };
    case "ellipse":
      return { cx: m.cx, cy: m.cy, rx: m.rx, ry: m.ry };
    case "draw":
      return { points: m.points };
  }
}

// the highlight rect: padded, min-sized bounds of the (already-transformed) mark
function highlightBox(m: Mark, pinSize?: PinSize): Box {
  const b = markBounds(m, pinSize);
  let x = b.x - PAD;
  let y = b.y - PAD;
  let w = b.w + 2 * PAD;
  let h = b.h + 2 * PAD;
  if (w < MIN_HL) {
    x -= (MIN_HL - w) / 2;
    w = MIN_HL;
  }
  if (h < MIN_HL) {
    y -= (MIN_HL - h) / 2;
    h = MIN_HL;
  }
  return { x, y, w, h };
}

// resize handles (fixed screen size) for the mark, in fraction space.
function resizeHandles(m: Mark): { id: string; x: number; y: number; cursor: string }[] {
  switch (m.tool) {
    case "pin":
      return [];
    case "arrow":
    case "line":
      return [
        { id: "p1", x: m.x1, y: m.y1, cursor: "cursor-move" },
        { id: "p2", x: m.x2, y: m.y2, cursor: "cursor-move" },
      ];
    case "rect":
    case "image": {
      const { x, y, w, h } = m;
      return boxHandles(x, y, w, h, true);
    }
    case "ellipse":
      return boxHandles(m.cx - m.rx, m.cy - m.ry, m.rx * 2, m.ry * 2, false);
    case "draw": {
      // bbox-box handles (corners + edges) — resize scales all points; no per-vertex
      const b = markBounds(m);
      return boxHandles(b.x, b.y, b.w, b.h, true);
    }
  }
}

// corner handles always; edge midpoints only when `edges` (rect, not ellipse).
function boxHandles(x: number, y: number, w: number, h: number, edges: boolean) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const corners = [
    { id: "nw", x, y, cursor: "cursor-nwse-resize" },
    { id: "ne", x: x + w, y, cursor: "cursor-nesw-resize" },
    { id: "se", x: x + w, y: y + h, cursor: "cursor-nwse-resize" },
    { id: "sw", x, y: y + h, cursor: "cursor-nesw-resize" },
  ];
  if (!edges) return corners;
  return [
    ...corners,
    { id: "n", x: cx, y, cursor: "cursor-ns-resize" },
    { id: "e", x: x + w, y: cy, cursor: "cursor-ew-resize" },
    { id: "s", x: cx, y: y + h, cursor: "cursor-ns-resize" },
    { id: "w", x, y: cy, cursor: "cursor-ew-resize" },
  ];
}

// ── component ────────────────────────────────────────────────────────────────

export function SelectionOverlay({
  marks,
  layers,
  send,
  scale,
  pinBounds,
  selectedIds,
  onSelectedIdsChange,
  onLiveTransform,
  liveOverride,
}: {
  marks: Mark[];
  layers: Layer[]; // back→front → topmost-hit honors layer order, skips hidden/locked
  send: (m: ClientToServer) => void;
  scale: number; // viewport zoom → the inline note editor welds to the image
  pinBounds: Record<string, PinSize>; // measured pin text boxes (fractions), by id
  selectedIds: string[]; // CONTROLLED by Canvas — the selection SET (shared with the layers panel)
  onSelectedIdsChange: (ids: string[]) => void; // drive the lifted selection
  onLiveTransform?: (m: Mark | null) => void; // lift the mid-drag geometry so the SHAPE moves live
  liveOverride?: Mark | null; // the held drop geometry (until broadcast) → highlight rides it too
}) {
  // selectedIds is lifted (controlled by Canvas); only the transient gesture + the
  // open pin-edit stay local — they're drag-/edit-scoped, not shared state.
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null); // pin label being re-edited

  // every selected mark (outlined); `single` = the lone transform target (only when
  // exactly one is selected — move/resize/edit/delete act on it; ≥2 just outline).
  const selectedMarks = marks.filter((m) => selectedIds.includes(m.id));
  const single = selectedIds.length === 1 ? selectedMarks[0] : undefined;
  // the lone mark as it looks right now: mid-gesture → the live transform; just after
  // release → the held drop geometry (liveOverride) until the broadcast lands,
  // mirroring the shape's hand-off so the highlight box doesn't flash back to the
  // start for a frame; otherwise → the committed mark.
  const held = single && liveOverride && liveOverride.id === single.id ? liveOverride : undefined;
  const live =
    single && gesture
      ? clampToImage(applyGesture(single, gesture), pinBounds[single.id])
      : (held ?? single);
  const hl = single && live ? highlightBox(live, pinBounds[live.id]) : null;
  const editing = editingId ? marks.find((m) => m.id === editingId) : undefined;

  // Push the live transformed mark up DURING a gesture so MarkRenderer moves the
  // actual shape with the cursor. We only set (never null on release) — AnnotationLayer
  // drops it when the committed broadcast arrives, so the shape doesn't flash back
  // to its old spot in the gap between release and broadcast. Cleared on unmount.
  useEffect(() => {
    if (gesture && single)
      onLiveTransform?.(clampToImage(applyGesture(single, gesture), pinBounds[single.id]));
  }, [gesture, single, pinBounds, onLiveTransform]);
  useEffect(() => () => onLiveTransform?.(null), [onLiveTransform]);

  // topmost mark under p (effective-z descending: layer order then zOrder), pins
  // sized to their measured box. Marks in hidden layers aren't drawn and marks in
  // locked layers are pinned → neither is selectable, so both are skipped here.
  function topHit(p: Point): Mark | undefined {
    const cmp = byEffectiveZ(layers);
    return [...marks]
      .filter((m) => isMarkSelectable(layers, m))
      .sort((a, b) => cmp(b, a))
      .find((m) => hitTest(p, m, undefined, pinBounds[m.id]));
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (editingId) setEditingId(null); // a press elsewhere ends an open edit (blur commits it)
    const handle = (e.target as HTMLElement).dataset.handle;
    const p = frac(e);
    if (handle && single) {
      e.stopPropagation();
      setGesture({ type: "resize", handle, start: p, cur: p, shift: e.shiftKey });
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    const hit = topHit(p);
    if (!hit) {
      onSelectedIdsChange([]); // empty press → clear; no stopPropagation → stage pans
      return;
    }
    e.stopPropagation(); // selecting a mark, not panning
    // shift/⌘-press → toggle this mark in the set (for grouping); never a move.
    if (e.shiftKey || e.metaKey) {
      onSelectedIdsChange(
        selectedIds.includes(hit.id)
          ? selectedIds.filter((id) => id !== hit.id)
          : [...selectedIds, hit.id],
      );
      return;
    }
    onSelectedIdsChange([hit.id]); // plain press → single-select (replace the set)
    // double-press a pin (detail===2) → re-edit its label inline, no move gesture.
    // (Detected here rather than via onDoubleClick so the surface stays
    // pointer-only — biome's noStaticElementInteractions flags click-family.)
    if (hit.tool === "pin" && e.detail >= 2) {
      setEditingId(hit.id);
      return;
    }
    setGesture({ type: "move", handle: "", start: p, cur: p, shift: e.shiftKey });
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!gesture) return;
    // track Shift live so toggling it mid-drag flips the aspect behavior
    setGesture({ ...gesture, cur: frac(e), shift: e.shiftKey });
  }
  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!gesture) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    const moved =
      Math.hypot(gesture.cur.x - gesture.start.x, gesture.cur.y - gesture.start.y) >=
      MOVE_THRESHOLD;
    if (moved && single) {
      send({
        type: "mark.update",
        id: single.id,
        patch: geometryPatch(clampToImage(applyGesture(single, gesture), pinBounds[single.id])),
      });
    }
    setGesture(null);
  }

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      className="absolute inset-0"
    >
      {/* every selected mark gets an outline; the single's rides its live geometry
          mid-gesture. The transform frame below is single-selection only. */}
      {selectedMarks.map((m) => {
        const shown = single && single.id === m.id ? (live ?? m) : m;
        const box = highlightBox(shown, pinBounds[shown.id]);
        return (
          <div
            key={m.id}
            className="absolute rounded-sm border-2 border-accent pointer-events-none"
            style={{
              left: `${box.x * 100}%`,
              top: `${box.y * 100}%`,
              width: `${box.w * 100}%`,
              height: `${box.h * 100}%`,
            }}
          />
        );
      })}

      {/* transform frame — handles + actions — only with exactly one mark selected
          and not mid-edit. (Multi-select is for grouping, not multi-transform.) */}
      {single && live && hl && !editing && (
        <>
          {/* resize handles — never present for pins */}
          {resizeHandles(live).map((hnd) => (
            <div
              key={hnd.id}
              data-handle={hnd.id}
              className={`absolute w-2 h-2 -translate-x-1/2 -translate-y-1/2 rounded-sm bg-accent border border-edge ${hnd.cursor}`}
              style={{ left: `${hnd.x * 100}%`, top: `${hnd.y * 100}%` }}
            />
          ))}

          {/* actions — edit (pins) + delete, at the highlight's top-right edge.
              Inter-layer z-order now lives in the layers panel (layer.reorder), so
              the per-selection forward/back chevrons are retired. */}
          <div
            className="absolute flex items-center gap-1 -translate-x-full -translate-y-1/2"
            style={{ left: `${(hl.x + hl.w) * 100}%`, top: `${hl.y * 100}%` }}
          >
            {single.tool === "pin" && (
              <ActionButton title="Edit note" onClick={() => setEditingId(single.id)}>
                <Pencil className="w-3 h-3" />
              </ActionButton>
            )}
            <ActionButton
              title="Delete annotation"
              onClick={() => {
                send({ type: "mark.remove", id: single.id });
                onSelectedIdsChange([]);
              }}
            >
              <X className="w-3 h-3" />
            </ActionButton>
          </div>
        </>
      )}

      {/* inline label editor — reuses the draw-mode pin editor. Enter/blur with
          text → mark.update {label}; Esc/empty → keep the original. */}
      {editing?.tool === "pin" && (
        <PinEditor
          key={editing.id}
          x={editing.x}
          y={editing.y}
          initialLabel={editing.label}
          fontSize={(editing.fontSize ?? DEFAULT_TEXT_SIZE) * scale}
          onSubmit={(label) => {
            send({ type: "mark.update", id: editing.id, patch: { label } });
            setEditingId(null);
          }}
          onCancel={() => setEditingId(null)}
        />
      )}
    </div>
  );
}

function ActionButton({
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
      className="w-5 h-5 rounded-full flex items-center justify-center bg-surface border border-edge text-muted hover:text-accent-ink hover:border-accent"
    >
      {children}
    </button>
  );
}
