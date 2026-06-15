import {
  Eraser,
  Maximize,
  MessagesSquare,
  Minus,
  MousePointer,
  MoveUpRight,
  Pin,
  Plus,
  Sparkles,
} from "lucide-react";
import { useState } from "react";
import { variantLabel } from "../state/derive";
import {
  ASPECTS,
  type ClientToServer,
  type ImageSize,
  type ImagoState,
  type Mark,
  SIZES,
} from "../state/types";

type Tool = "select" | "pin" | "arrow";

function id(): string {
  return crypto.randomUUID();
}

function frameDims(aspect: string): { w: number; h: number } {
  const [w, h] = (aspect.split(":").map(Number) as [number, number]) ?? [1, 1];
  const base = 300;
  const s = base / Math.max(w || 1, h || 1);
  return { w: Math.round((w || 1) * s), h: Math.round((h || 1) * s) };
}

// Center pane: the stage. A blank aspect-ratio'd frame when nothing is focused
// (pick an aspect + size, then describe it on the right), or the focused image
// with pan/zoom + light annotation (arrow + pin). Marks are committed to the
// conversation — handed to the agent — never "applied" by a hidden button.
export function Canvas({ state, send }: { state: ImagoState; send: (m: ClientToServer) => void }) {
  const [zoom, setZoom] = useState(100);
  const [tool, setTool] = useState<Tool>("select");
  const [arrowStart, setArrowStart] = useState<{ x: number; y: number } | null>(null);

  const focus = state.focus;
  const batch = focus ? state.batches.find((b) => b.id === focus.batchId) : undefined;
  const vIndex = batch && focus ? batch.variants.findIndex((v) => v.id === focus.variantId) : -1;
  const variant = batch && vIndex >= 0 ? batch.variants[vIndex] : undefined;

  function frac(e: React.MouseEvent<HTMLElement>): { x: number; y: number } {
    const r = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  }

  function onImageClick(e: React.MouseEvent<HTMLElement>) {
    if (tool === "select" || !variant) return;
    const p = frac(e);
    if (tool === "pin") {
      send({
        type: "mark.add",
        mark: { id: id(), tool: "pin", label: "note", x: p.x, y: p.y },
      });
    } else if (tool === "arrow") {
      if (!arrowStart) setArrowStart(p);
      else {
        send({
          type: "mark.add",
          mark: {
            id: id(),
            tool: "arrow",
            x1: arrowStart.x,
            y1: arrowStart.y,
            x2: p.x,
            y2: p.y,
          },
        });
        setArrowStart(null);
      }
    }
  }

  function commitMarks() {
    if (!focus || state.marks.length === 0) return;
    const pins = state.marks.filter((m) => m.tool === "pin").length;
    const arrows = state.marks.filter((m) => m.tool === "arrow").length;
    const parts = [
      arrows && `${arrows} arrow${arrows > 1 ? "s" : ""}`,
      pins && `${pins} pin${pins > 1 ? "s" : ""}`,
    ].filter(Boolean);
    send({
      type: "marks.commit",
      text: `marked: ${parts.join(", ")}`,
      batchId: focus.batchId,
      variantId: focus.variantId,
    });
  }

  // ── blank "new image" frame ──
  if (!focus || !variant) {
    const d = frameDims(state.aspect);
    return (
      <section className="card relative h-full overflow-hidden workspace flex flex-col items-center justify-center gap-5">
        <div
          className="rounded-lg border-2 border-dashed border-edge-strong bg-surface/40 flex flex-col items-center justify-center gap-2 text-faint"
          style={{ width: d.w, height: d.h }}
        >
          <Sparkles className="w-8 h-8" />
          <span className="text-xs">{state.aspect} · new image</span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-faint">aspect</span>
          <div className="inline-flex rounded-md border border-edge-strong overflow-hidden">
            {ASPECTS.map((r) => (
              <button
                type="button"
                key={r}
                onClick={() => send({ type: "aspect.set", aspect: r })}
                className={`px-2 py-0.5 font-medium ${
                  state.aspect === r ? "bg-accent text-white" : "text-muted hover:bg-surface-3"
                }`}
              >
                {r}
              </button>
            ))}
          </div>
          <span className="text-faint ml-1">size</span>
          <div className="inline-flex rounded-md border border-edge-strong overflow-hidden">
            {SIZES.map((z: ImageSize) => (
              <button
                type="button"
                key={z}
                onClick={() => send({ type: "size.set", size: z })}
                className={`px-2 py-0.5 font-medium ${
                  state.size === z ? "bg-accent text-white" : "text-muted hover:bg-surface-3"
                }`}
              >
                {z}
              </button>
            ))}
          </div>
        </div>
        <p className="text-faint text-center max-w-xs">
          start talking on the right → say what you want to make. imago handles the rest.
        </p>
      </section>
    );
  }

  // ── focused image ──
  const dim = zoom * 3.4;
  return (
    <section className="card relative h-full overflow-hidden workspace flex items-center justify-center p-8">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer-position annotation surface */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: clicks place marks at the cursor — no keyboard equivalent */}
      <div
        onClick={onImageClick}
        className={`relative rounded-lg shadow-2xl ring-1 ring-edge overflow-hidden ${
          tool === "select" ? "" : "cursor-crosshair"
        }`}
        style={{ width: dim, height: dim }}
      >
        {variant.src ? (
          <img
            src={variant.src}
            alt={`variant ${variantLabel(vIndex)}`}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full bg-surface-2" />
        )}

        {/* marks overlay (fractions → percentages) */}
        <svg
          className="absolute inset-0 w-full h-full pointer-events-none"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          <title>annotations</title>
          <defs>
            <marker id="ah" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 Z" fill="var(--color-attention)" />
            </marker>
          </defs>
          {state.marks.map((m: Mark) =>
            m.tool === "arrow" ? (
              <line
                key={m.id}
                x1={m.x1 * 100}
                y1={m.y1 * 100}
                x2={m.x2 * 100}
                y2={m.y2 * 100}
                stroke="var(--color-attention)"
                strokeWidth="0.8"
                markerEnd="url(#ah)"
              />
            ) : null,
          )}
        </svg>
        {state.marks.map((m) =>
          m.tool === "pin" ? (
            <span
              key={m.id}
              className="absolute -translate-x-1/2 -translate-y-1/2 text-[10px] bg-accent text-white px-1.5 py-0.5 rounded shadow"
              style={{ left: `${m.x * 100}%`, top: `${m.y * 100}%` }}
            >
              {m.label}
            </span>
          ) : null,
        )}
      </div>

      {/* annotation toolbar */}
      <div className="absolute top-4 left-4 flex flex-col gap-1.5 p-1.5 card">
        {(
          [
            ["select", MousePointer, "Select / pan"],
            ["arrow", MoveUpRight, "Arrow — move this → there"],
            ["pin", Pin, "Pin — label a spot"],
          ] as const
        ).map(([t, Icon, title]) => (
          <button
            type="button"
            key={t}
            title={title}
            onClick={() => {
              setTool(t);
              setArrowStart(null);
            }}
            className={`w-9 h-9 rounded-md flex items-center justify-center border transition-colors ${
              tool === t
                ? "bg-accent/25 border-accent/60 text-accent-ink"
                : "border-edge text-muted hover:text-white hover:border-edge-hover"
            }`}
          >
            <Icon className="w-4 h-4" />
          </button>
        ))}
        {state.marks.length > 0 && (
          <button
            type="button"
            title="Clear annotations"
            onClick={() => send({ type: "marks.clear" })}
            className="w-9 h-9 rounded-md flex items-center justify-center border border-edge text-muted hover:text-white hover:border-edge-hover"
          >
            <Eraser className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* zoom */}
      <div className="absolute bottom-4 right-4 flex items-center gap-1 p-1 card">
        <button
          type="button"
          className="btn-ghost !p-1.5"
          onClick={() => setZoom((z) => Math.max(25, z - 25))}
        >
          <Minus className="w-4 h-4" />
        </button>
        <span className="text-xs text-ink w-12 text-center tabular-nums">{zoom}%</span>
        <button
          type="button"
          className="btn-ghost !p-1.5"
          onClick={() => setZoom((z) => Math.min(300, z + 25))}
        >
          <Plus className="w-4 h-4" />
        </button>
        <button type="button" className="btn-ghost !p-1.5" onClick={() => setZoom(100)} title="Fit">
          <Maximize className="w-4 h-4" />
        </button>
      </div>

      {/* context chip */}
      <div className="absolute top-4 right-4 text-[11px] bg-black/60 border border-edge text-ink px-2.5 py-1 rounded-full">
        Batch {state.batches.findIndex((b) => b.id === focus.batchId) + 1} · variant{" "}
        {variantLabel(vIndex)}
        {state.marks.length > 0 ? " · annotating" : ""}
      </div>

      {/* hand the marks to the conversation (not a hidden "apply") */}
      {state.marks.length > 0 && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-2 card">
          <span className="text-[11px] text-muted">{state.marks.length} mark(s)</span>
          <button
            type="button"
            className="btn-primary !px-2.5 !py-1 text-[11px]"
            onClick={commitMarks}
          >
            <MessagesSquare className="w-3.5 h-3.5" /> Take marks to the conversation →
          </button>
        </div>
      )}
    </section>
  );
}
