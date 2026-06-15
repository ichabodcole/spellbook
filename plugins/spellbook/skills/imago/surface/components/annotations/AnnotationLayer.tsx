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
import type { ClientToServer, Mark } from "../../state/types";
import { frac, type PinSize } from "./coords";
import { MarkRenderer } from "./MarkRenderer";
import { SelectionOverlay } from "./SelectionOverlay";
import type { DrawStyle } from "./style";
import { TOOL_REGISTRY } from "./tools/registry";
import type { Draft } from "./tools/types";

export function AnnotationLayer({
  tool,
  marks,
  resetKey,
  send,
  drawStyle,
  scale,
  onSelectionChange,
}: {
  tool: string;
  marks: Mark[];
  resetKey: string; // changes when the focused image changes → clears any draft
  send: (m: ClientToServer) => void;
  drawStyle: DrawStyle; // active color/width for NEW marks (tools stay style-agnostic)
  scale: number; // viewport zoom scale → marks/drafts weld to the image
  onSelectionChange?: (id: string | null) => void;
}) {
  const [draft, setDraft] = useState<Draft>(null);
  const plugin = TOOL_REGISTRY[tool]; // undefined for the `select` pseudo-tool

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
  // biome-ignore lint/correctness/useExhaustiveDependencies: marks is the broadcast signal — clear the override when committed state arrives
  useEffect(() => {
    setLiveOverride(null);
  }, [marks]);

  // Drop any in-progress draft when the tool or the focused image changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tool + resetKey are the intentional reset keys
  useEffect(() => {
    setDraft(null);
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
    setDraft(plugin.onDown(frac(e), draft));
    if (plugin.capturePointer) e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!plugin || draft == null) return;
    setDraft(plugin.onMove(frac(e), draft));
  }
  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
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

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      className="absolute inset-0"
    >
      <MarkRenderer
        marks={marks}
        scale={scale}
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
          send={send}
          scale={scale}
          pinBounds={pinBounds}
          onSelectionChange={onSelectionChange}
          onLiveTransform={setLiveOverride}
          liveOverride={liveOverride}
        />
      )}
    </div>
  );
}
