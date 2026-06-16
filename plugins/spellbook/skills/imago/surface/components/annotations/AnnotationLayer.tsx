// surface/components/annotations/AnnotationLayer.tsx
// Lives inset-0 inside the focused image box. Owns the active tool's draft and
// dispatches pointer gestures to it, renders committed marks (MarkRenderer) plus
// the tool's live draft/editor, and commits finished marks via mark.add.
//
// select tool → no plugin: the layer ignores the gesture (no stopPropagation) so
// it bubbles to the stage and drives pan. arrow/pin → the gesture is annotation,
// stopPropagation keeps it off the pan path.
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import type { ClientToServer, Layer, Mark } from "../../state/types";
import { frac, type PinSize, type Point } from "./coords";
import { ERASER_RADIUS, eraseMarks } from "./erase";
import { MarkRenderer } from "./MarkRenderer";
import { SelectionOverlay } from "./SelectionOverlay";
import type { DrawStyle } from "./style";
import { TOOL_REGISTRY } from "./tools/registry";
import type { Draft } from "./tools/types";

// A circle cursor (black halo + white ring, hotspot centered) signaling erase
// mode — Draw tool + Option. Fixed 24px: it marks the mode, not the true radius.
const ERASER_CURSOR =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Ccircle cx='12' cy='12' r='9' fill='none' stroke='black' stroke-width='3'/%3E%3Ccircle cx='12' cy='12' r='9' fill='none' stroke='white' stroke-width='1.5'/%3E%3C/svg%3E\") 12 12, crosshair";

export function AnnotationLayer({
  tool,
  marks,
  layers,
  resetKey,
  send,
  drawStyle,
  scale,
  natW,
  natH,
  selectedIds,
  onSelectedIdsChange,
}: {
  tool: string;
  marks: Mark[];
  layers: Layer[]; // container metadata (back→front) → effective z + hidden skip
  resetKey: string; // changes when the focused image changes → clears any draft
  send: (m: ClientToServer) => void;
  drawStyle: DrawStyle; // active color/width for NEW marks (tools stay style-agnostic)
  scale: number; // viewport zoom scale → marks/drafts weld to the image
  natW: number; // image natural px (the SVG viewBox basis)
  natH: number;
  selectedIds: string[]; // controlled selection SET, owned by Canvas
  onSelectedIdsChange: (ids: string[]) => void;
}) {
  const [draft, setDraft] = useState<Draft>(null);
  const plugin = TOOL_REGISTRY[tool]; // undefined for the `select` pseudo-tool

  // Pen eraser: with the Draw tool active, Option turns a drag into an erase.
  // eraserPath is the live cursor trail (fraction space); altHeld drives the
  // mode cursor. Both are draw-tool-only.
  const [eraserPath, setEraserPath] = useState<Point[] | null>(null);
  // the erase result, held from release until the marks.replace broadcast lands,
  // so the trimmed set doesn't flash back to the full stroke for a frame.
  const [pendingErase, setPendingErase] = useState<Mark[] | null>(null);
  const [altHeld, setAltHeld] = useState(false);
  const eraseArmed = tool === "draw" && altHeld;
  // Track Option/Alt while mounted so the cursor can signal erase mode.
  useEffect(() => {
    const sync = (e: KeyboardEvent) => setAltHeld(e.altKey);
    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
    };
  }, []);

  // measured pin text boxes (fractions), reported by MarkRenderer → fed to
  // SELECT so a note's hit area + highlight match the rendered text. Guard the
  // setter on value-equality so a measure→render→measure cycle can't loop.
  const [pinBounds, setPinBounds] = useState<Record<string, PinSize>>({});
  const onMeasurePin = useCallback((id: string, size: PinSize) => {
    setPinBounds((prev) => {
      const cur = prev[id];
      if (cur && Math.abs(cur.w - size.w) < 1e-4 && Math.abs(cur.h - size.h) < 1e-4) return prev;
      return { ...prev, [id]: size };
    });
  }, []);

  // The selected mark's live geometry mid-drag (move/resize), lifted from
  // SelectionOverlay so MarkRenderer can render the SHAPE moving with the cursor,
  // not just the highlight box. SelectionOverlay only SETS this during a gesture;
  // we drop it when the post-commit `marks` broadcast lands (below) so the shape
  // never snaps back to its old spot for a frame between release and broadcast.
  const [liveOverride, setLiveOverride] = useState<Mark | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: marks is the broadcast signal — clear held overrides when committed state arrives
  useEffect(() => {
    setLiveOverride(null);
    setPendingErase(null);
  }, [marks]);

  // Drop any in-progress draft/erase when the tool or the focused image changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tool + resetKey are the intentional reset keys
  useEffect(() => {
    setDraft(null);
    setEraserPath(null);
    setPendingErase(null);
  }, [tool, resetKey]);

  function commit(mark: Mark) {
    // apply the active draw style at commit — tools never see it
    const styled: Mark = { ...mark };
    if (drawStyle.color) styled.color = drawStyle.color;
    if (drawStyle.width != null) styled.width = drawStyle.width;
    if (drawStyle.fontSize != null) styled.fontSize = drawStyle.fontSize;
    send({ type: "mark.add", mark: styled });
    setDraft(null);
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!plugin) return; // select → fall through to the stage (pan)
    e.stopPropagation(); // annotation gesture, not a pan
    // Draw + Option → erase gesture instead of a new stroke
    if (tool === "draw" && e.altKey) {
      setEraserPath([frac(e)]);
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    setDraft(plugin.onDown(frac(e), draft));
    if (plugin.capturePointer) e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (eraserPath) {
      // read frac NOW — the functional updater runs in the render phase, after
      // the handler returns, when e.currentTarget is already null
      const pt = frac(e);
      setEraserPath((p) => (p ? [...p, pt] : p));
      return;
    }
    if (!plugin || draft == null) return;
    setDraft(plugin.onMove(frac(e), draft));
  }
  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (eraserPath) {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
      // one marks.replace = one history step (server snapshots once → one undo)
      const result = eraseMarks(marks, eraserPath, ERASER_RADIUS);
      send({ type: "marks.replace", marks: result });
      // hold the trimmed result until the broadcast lands (no full-stroke flash)
      setPendingErase(result);
      setEraserPath(null);
      return;
    }
    if (!plugin || draft == null) return;
    if (plugin.capturePointer) e.currentTarget.releasePointerCapture?.(e.pointerId);
    const r = plugin.onUp(frac(e), draft);
    if (r.mark) commit(r.mark);
    else setDraft(r.draft ?? null);
  }

  const ctx = {
    commit,
    cancel: () => setDraft(null),
    update: (d: Draft) => setDraft(d),
    style: drawStyle,
    scale,
  };

  // While erasing, render the trimmed/split result locally (mirrors liveOverride)
  // so strokes visibly shrink/split as you drag; on release we hold that result
  // (pendingErase) until the broadcast lands, then fall back to committed marks.
  const shownMarks = eraserPath
    ? eraseMarks(marks, eraserPath, ERASER_RADIUS)
    : (pendingErase ?? marks);

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      className="absolute inset-0"
      style={eraseArmed ? { cursor: ERASER_CURSOR } : undefined}
    >
      <MarkRenderer
        marks={shownMarks}
        layers={layers}
        scale={scale}
        natW={natW}
        natH={natH}
        onMeasurePin={onMeasurePin}
        liveOverride={liveOverride}
      />
      {plugin?.renderDraft(draft, ctx)}
      {/* select tool: selection/move/delete. Keyed on the focused variant so
          selection clears on image change; unmounts when a draw tool is active. */}
      {!plugin && (
        <SelectionOverlay
          key={resetKey}
          marks={marks}
          layers={layers}
          send={send}
          scale={scale}
          pinBounds={pinBounds}
          selectedIds={selectedIds}
          onSelectedIdsChange={onSelectedIdsChange}
          onLiveTransform={setLiveOverride}
          liveOverride={liveOverride}
        />
      )}
    </div>
  );
}
