import {
  Check,
  Copy,
  Eraser,
  ImagePlus,
  Info,
  Maximize,
  MessagesSquare,
  Minus,
  MousePointer,
  MoveUpRight,
  Pin,
  Plus,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { variantLabel } from "../state/derive";
import { importFiles, processFiles } from "../state/fileIntake";
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
  const [zoom, setZoom] = useState(100); // % of the base fit-to-stage size
  const [tool, setTool] = useState<Tool>("select");
  const [arrowStart, setArrowStart] = useState<{ x: number; y: number } | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 }); // viewport offset in px
  const [panning, setPanning] = useState(false);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null); // image natural size
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });
  const [showDetails, setShowDetails] = useState(false);
  const [copied, setCopied] = useState<"prompt" | "analysis" | null>(null);
  const [importDragging, setImportDragging] = useState(false); // image dragged over the canvas
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  const focus = state.focus;
  const batch = focus ? state.batches.find((b) => b.id === focus.batchId) : undefined;
  const vIndex = batch && focus ? batch.variants.findIndex((v) => v.id === focus.variantId) : -1;
  const variant = batch && vIndex >= 0 ? batch.variants[vIndex] : undefined;
  const variantId = variant?.id;

  // Reset the viewport when the focused image changes, and read the image's
  // natural size. CRITICAL: a cached image is already `complete` by the time
  // React attaches `onLoad`, so onLoad never fires for it — read the dims
  // synchronously here (before paint) for that case; onLoad covers async loads.
  // biome-ignore lint/correctness/useExhaustiveDependencies: variantId is the intentional reset key (re-run when the focused image changes)
  useLayoutEffect(() => {
    setZoom(100);
    setPan({ x: 0, y: 0 });
    // NB: showDetails intentionally NOT reset — the details sidebar persists
    // open across variant selection; it just swaps content.
    const el = imgRef.current;
    setNat(el?.complete && el.naturalWidth ? { w: el.naturalWidth, h: el.naturalHeight } : null);
  }, [variantId]);

  // Measure the stage so the image can be fit to it (re-measures on resize and
  // when (re)entering the focused view, since the stage ref attaches then).
  // biome-ignore lint/correctness/useExhaustiveDependencies: variantId re-attaches the stage ref on focus change
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setStageSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [variantId]);

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

  // ── viewport: drag to pan (select tool), wheel to zoom toward the cursor ──
  function onStagePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (tool !== "select") return; // pin/arrow tools place marks on click instead
    // Don't start a pan (which captures the pointer) when the press lands on an
    // overlay control — otherwise pointer-capture swallows the +/−/Fit and
    // toolbar button clicks (regression after the viewport rework).
    if ((e.target as HTMLElement).closest("button")) return;
    dragRef.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
    setPanning(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onStagePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    if (!d) return;
    setPan({ x: d.px + (e.clientX - d.x), y: d.py + (e.clientY - d.y) });
  }
  function onStagePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    dragRef.current = null;
    setPanning(false);
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  }
  function onStageWheel(e: React.WheelEvent<HTMLDivElement>) {
    const el = stageRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // cursor position relative to the stage center (the image's anchor point)
    const cx = e.clientX - rect.left - rect.width / 2;
    const cy = e.clientY - rect.top - rect.height / 2;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const nz = Math.min(400, Math.max(25, Math.round(zoom * factor)));
    if (nz === zoom) return;
    // keep the point under the cursor stationary as the image scales about center
    const ratio = nz / zoom;
    setPan({ x: cx - (cx - pan.x) * ratio, y: cy - (cy - pan.y) * ratio });
    setZoom(nz);
  }
  function fitToStage() {
    setZoom(100);
    setPan({ x: 0, y: 0 });
  }
  function copyText(text: string, key: "prompt" | "analysis") {
    if (!text) return;
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    });
  }

  // ── canvas drop = import a durable working image (vs. the drawer = reference).
  // Separate from the pan/zoom pointer handlers (different event types).
  function onCanvasDragOver(e: React.DragEvent<HTMLElement>) {
    e.preventDefault(); // required so the drop event fires
    if (!importDragging) setImportDragging(true);
  }
  function onCanvasDragLeave(e: React.DragEvent<HTMLElement>) {
    if (e.currentTarget === e.target) setImportDragging(false);
  }
  function onCanvasDrop(e: React.DragEvent<HTMLElement>) {
    e.preventDefault();
    setImportDragging(false);
    importFiles(e.dataTransfer.files, send);
  }

  // Drag highlight shown on the canvas while an image is dragged over it —
  // deliberately stronger than the drawer's subtle tint (this is an import, not
  // a reference). Shared by the blank frame and the focused stage.
  const importHint = importDragging ? (
    <div className="absolute inset-0 z-20 pointer-events-none flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-accent/10">
      <span className="text-accent-ink text-sm font-medium bg-surface/85 px-3 py-1.5 rounded-md border border-accent/40 shadow">
        drop to import as a working image
      </span>
    </div>
  ) : null;

  // ── blank "new image" frame ──
  if (!focus || !variant) {
    const d = frameDims(state.aspect);
    return (
      <section className="card relative h-full overflow-hidden workspace flex flex-col">
        {/* biome-ignore lint/a11y/noStaticElementInteractions: image drop = import */}
        <div
          onDragOver={onCanvasDragOver}
          onDragLeave={onCanvasDragLeave}
          onDrop={onCanvasDrop}
          className="relative flex-1 min-h-0 flex flex-col items-center justify-center gap-5"
        >
          {importHint}
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
        </div>
        <ReferenceDrawer state={state} send={send} />
      </section>
    );
  }

  // ── focused image — a real viewport: natural aspect, wheel-zoom, drag-pan ──
  const aspect = nat ? nat.w / nat.h : 1;
  const PAD = 24; // breathing room around the fitted image
  const availW = Math.max(0, stageSize.w - PAD);
  const availH = Math.max(0, stageSize.h - PAD);
  let baseW = availW;
  let baseH = baseW / aspect;
  if (baseH > availH) {
    baseH = availH;
    baseW = baseH * aspect;
  }
  const scale = zoom / 100;
  const dispW = baseW * scale;
  const dispH = baseH * scale;
  const viewportReady = nat !== null && stageSize.w > 0;
  const batchIndex = state.batches.findIndex((b) => b.id === focus.batchId);
  // For an edit, resolve the source variant to a friendly "Batch M · variant y".
  const sourceLabel = (() => {
    const sid = batch.editedFromVariantId;
    if (!sid) return "—";
    for (let bi = 0; bi < state.batches.length; bi++) {
      const sv = state.batches[bi].variants.findIndex((v) => v.id === sid);
      if (sv >= 0) return `Batch ${bi + 1} · variant ${variantLabel(sv)}`;
    }
    return sid;
  })();
  return (
    <section className="card relative h-full overflow-hidden workspace flex flex-col">
      {/* center row: [stage | details sidebar]. The sidebar is a SIBLING of the
          stage, so the stage's wheel/pan handlers never see the panel's scroll
          (no scroll-bleed), and an open panel pushes the stage rather than
          overlaying it. */}
      <div className="flex-1 min-h-0 flex">
        {/* biome-ignore lint/a11y/noStaticElementInteractions: pan/zoom + image-drop surface */}
        <div
          ref={stageRef}
          onWheel={onStageWheel}
          onPointerDown={onStagePointerDown}
          onPointerMove={onStagePointerMove}
          onPointerUp={onStagePointerUp}
          onPointerLeave={onStagePointerUp}
          onDragOver={onCanvasDragOver}
          onDragLeave={onCanvasDragLeave}
          onDrop={onCanvasDrop}
          className={`relative flex-1 min-w-0 overflow-hidden flex items-center justify-center ${
            tool === "select" ? (panning ? "cursor-grabbing" : "cursor-grab") : "cursor-crosshair"
          }`}
        >
          {importHint}
          {/* The image box is sized to the image's real proportions (no forced
            square) and translated by pan; the marks overlay lives INSIDE it, so
            pins/arrows stay glued to the image as it pans & zooms. */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer-position annotation surface */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: clicks place marks at the cursor — no keyboard equivalent */}
          <div
            onClick={onImageClick}
            className="relative shrink-0 select-none rounded-lg shadow-2xl ring-1 ring-edge overflow-hidden"
            style={{
              width: dispW || undefined,
              height: dispH || undefined,
              transform: `translate(${pan.x}px, ${pan.y}px)`,
              visibility: viewportReady ? "visible" : "hidden",
            }}
          >
            {variant.src ? (
              <img
                ref={imgRef}
                src={variant.src}
                alt={`variant ${variantLabel(vIndex)}`}
                draggable={false}
                onLoad={(e) =>
                  setNat({
                    w: e.currentTarget.naturalWidth,
                    h: e.currentTarget.naturalHeight,
                  })
                }
                className="block w-full h-full object-contain"
              />
            ) : (
              <div className="w-full h-full bg-surface-2" />
            )}

            {/* marks overlay (fractions → percentages of the image box) */}
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
                  className="absolute -translate-x-1/2 -translate-y-1/2 text-[10px] bg-accent text-white px-1.5 py-0.5 rounded shadow pointer-events-none"
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
              onClick={() => setZoom((z) => Math.min(400, z + 25))}
            >
              <Plus className="w-4 h-4" />
            </button>
            <button type="button" className="btn-ghost !p-1.5" onClick={fitToStage} title="Fit">
              <Maximize className="w-4 h-4" />
            </button>
          </div>

          {/* context chip + details toggle */}
          <div className="absolute top-4 right-4 flex items-center gap-2">
            <div className="text-[11px] bg-black/60 border border-edge text-ink px-2.5 py-1 rounded-full">
              Batch {batchIndex + 1} · variant {variantLabel(vIndex)}
              {state.marks.length > 0 ? " · annotating" : ""}
            </div>
            <button
              type="button"
              title="Image details"
              onClick={() => setShowDetails((v) => !v)}
              className={`w-7 h-7 rounded-full flex items-center justify-center border transition-colors ${
                showDetails
                  ? "bg-accent/25 border-accent/60 text-accent-ink"
                  : "bg-black/60 border-edge text-muted hover:text-ink hover:border-edge-hover"
              }`}
            >
              <Info className="w-3.5 h-3.5" />
            </button>
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
        </div>

        {/* details sidebar — docked, pushes the stage. A SIBLING of the stage so
            its own overflow-y-auto scroll never reaches the stage's wheel/pan
            handlers. Persists open across variant selection (content swaps).
            Structured as stacked sections so more can be added later. */}
        {showDetails && (
          <aside className="w-[300px] shrink-0 border-l border-divider bg-surface flex flex-col overflow-y-auto">
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-divider">
              <span className="section-title">Details</span>
              <span className={`ml-auto ${batch.kind === "edit" ? "badge-accent" : "badge-muted"}`}>
                {batch.kind}
              </span>
              <button
                type="button"
                title="Close details"
                onClick={() => setShowDetails(false)}
                className="shrink-0 text-faint hover:text-ink"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 flex flex-col gap-4 text-xs">
              <span className="text-sm font-semibold text-ink-strong">
                Batch {batchIndex + 1} · variant {variantLabel(vIndex)}
              </span>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-faint uppercase tracking-wider">prompt</span>
                  <button
                    type="button"
                    title="Copy prompt"
                    onClick={() => copyText(batch.prompt, "prompt")}
                    disabled={!batch.prompt}
                    className="flex items-center gap-1 text-faint hover:text-ink disabled:opacity-40 disabled:hover:text-faint"
                  >
                    {copied === "prompt" ? (
                      <>
                        <Check className="w-3 h-3" /> copied
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" /> copy
                      </>
                    )}
                  </button>
                </div>
                <p className="text-muted leading-relaxed whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                  {batch.prompt || "—"}
                </p>
              </div>

              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
                <dt className="text-faint">model</dt>
                <dd className="text-ink break-words [overflow-wrap:anywhere]">
                  {variant.model || "—"}
                </dd>
                <dt className="text-faint">seed</dt>
                <dd className="text-ink tabular-nums">{variant.seed ?? "—"}</dd>
                <dt className="text-faint">kind</dt>
                <dd className="text-ink">{batch.kind}</dd>
                {batch.kind === "edit" && (
                  <>
                    <dt className="text-faint">source</dt>
                    <dd className="text-ink">{sourceLabel}</dd>
                  </>
                )}
              </dl>

              {/* analysis — the agent's living read of THIS image (durable,
                  distinct from the prompt). Empty until the agent analyzes it. */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-faint uppercase tracking-wider">analysis</span>
                  {variant.analysis && (
                    <button
                      type="button"
                      title="Copy analysis"
                      onClick={() => copyText(variant.analysis, "analysis")}
                      className="flex items-center gap-1 text-faint hover:text-ink"
                    >
                      {copied === "analysis" ? (
                        <>
                          <Check className="w-3 h-3" /> copied
                        </>
                      ) : (
                        <>
                          <Copy className="w-3 h-3" /> copy
                        </>
                      )}
                    </button>
                  )}
                </div>
                {variant.analysis ? (
                  <p className="text-muted leading-relaxed whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                    {variant.analysis}
                  </p>
                ) : (
                  <p className="text-faint italic">— not analyzed yet</p>
                )}
              </div>
            </div>
          </aside>
        )}
      </div>
      <ReferenceDrawer state={state} send={send} />
    </section>
  );
}

// The reference drawer — a full-width strip pinned to the bottom of the canvas
// pane. A forgiving drop target (and click-to-add) that stages reference images
// into shared state.refs; both this and the composer just emit ref.add/ref.remove.
function ReferenceDrawer({
  state,
  send,
}: {
  state: ImagoState;
  send: (m: ClientToServer) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const selectedCount = state.refs.filter((r) => r.selected).length;
  // The analysis popover, anchored to the badge that opened it (fixed-positioned
  // so it escapes the drawer's overflow clipping). Keyed by ref id so it closes
  // itself if that ref is removed while open.
  const [analysisAnchor, setAnalysisAnchor] = useState<{ id: string; rect: DOMRect } | null>(null);
  const analysisRef = analysisAnchor
    ? state.refs.find((r) => r.id === analysisAnchor.id)
    : undefined;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drag-drop file zone
    <div
      className={`shrink-0 border-t px-3 py-2 transition-colors ${
        dragging ? "border-accent/60 bg-accent/5" : "border-divider"
      }`}
      onDragOver={(e) => {
        e.preventDefault();
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        processFiles(e.dataTransfer.files, send);
      }}
    >
      {state.refs.length === 0 ? (
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          className={`w-full h-[75px] rounded-md border border-dashed flex items-center justify-center gap-1.5 text-[11px] transition-colors ${
            dragging
              ? "border-accent/60 bg-accent/10 text-accent-ink"
              : "border-edge-strong text-faint hover:text-ink hover:border-edge-hover"
          }`}
        >
          <ImagePlus className="w-3.5 h-3.5" />
          {dragging ? "drop to add as a reference" : "drag reference images here, or click to add"}
        </button>
      ) : (
        <div className="flex flex-col gap-1.5">
          {/* header row — label left, count right (justify-between) so the count
              appears/disappears in a fixed spot and never reflows the thumbnails.
              Right side is also where future drawer actions can live. */}
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-faint">refs</span>
            {selectedCount > 0 && <span className="text-accent-ink">{selectedCount} selected</span>}
          </div>
          {/* px/py give the outset selection ring room on all four sides —
              overflow-x-auto forces vertical clipping, so an exact-height row
              would cut the ring at top & bottom. */}
          <div className="flex items-center gap-2 overflow-x-auto px-1 py-1">
            {state.refs.map((r) => (
              <div
                key={r.id}
                className={`relative w-[75px] h-[75px] rounded-md overflow-hidden shrink-0 transition-shadow ${
                  r.selected ? "ring-2 ring-accent" : "ring-1 ring-edge"
                }`}
              >
                <img src={r.src} alt={r.name} className="w-full h-full object-cover" />
                {/* body click toggles selection for the next generation */}
                <button
                  type="button"
                  title={
                    r.selected
                      ? "Selected — click to deselect"
                      : "Click to select for the next generation"
                  }
                  onClick={() => send({ type: "ref.select", id: r.id, selected: !r.selected })}
                  className="absolute inset-0 cursor-pointer"
                />
                {r.selected && (
                  <span className="absolute top-0 left-0 bg-accent text-accent-fg rounded-br p-0.5 pointer-events-none">
                    <Check className="w-3 h-3" />
                  </span>
                )}
                {r.analysis && (
                  <button
                    type="button"
                    title="View the agent's read of this reference"
                    onClick={(e) => {
                      e.stopPropagation();
                      setAnalysisAnchor({
                        id: r.id,
                        rect: e.currentTarget.getBoundingClientRect(),
                      });
                    }}
                    className="absolute bottom-0 left-0 bg-positive text-bg rounded-tr p-0.5"
                  >
                    <Info className="w-3 h-3" />
                  </button>
                )}
                <button
                  type="button"
                  title="Remove reference"
                  onClick={(e) => {
                    e.stopPropagation();
                    send({ type: "ref.remove", id: r.id });
                  }}
                  className="absolute top-0 right-0 bg-black/70 text-white rounded-bl"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
            <button
              type="button"
              title="Add reference images"
              onClick={() => fileInput.current?.click()}
              className="w-[75px] h-[75px] shrink-0 rounded-md border border-dashed border-edge-strong text-faint hover:text-ink hover:border-edge-hover flex items-center justify-center transition-colors"
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          processFiles(e.target.files, send);
          e.target.value = "";
        }}
      />

      {/* analysis popover — the agent's read of a reference, opened from its badge */}
      {analysisRef && analysisAnchor && (
        <>
          {/* click-out backdrop */}
          <button
            type="button"
            aria-label="Close analysis"
            onClick={() => setAnalysisAnchor(null)}
            className="fixed inset-0 z-40 cursor-default"
          />
          <div
            className="fixed z-50 w-64 max-h-64 overflow-y-auto card p-3 shadow-xl"
            style={{
              left: Math.max(8, Math.min(analysisAnchor.rect.left, window.innerWidth - 264)),
              bottom: window.innerHeight - analysisAnchor.rect.top + 8,
            }}
          >
            <div className="flex items-start gap-2 mb-1.5">
              <span className="text-[11px] font-semibold text-ink-strong truncate">
                {analysisRef.name}
              </span>
              <button
                type="button"
                title="Close"
                onClick={() => setAnalysisAnchor(null)}
                className="ml-auto shrink-0 text-faint hover:text-ink"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <p className="text-[11px] text-muted leading-relaxed whitespace-pre-wrap">
              {analysisRef.analysis}
            </p>
          </div>
        </>
      )}
    </div>
  );
}
