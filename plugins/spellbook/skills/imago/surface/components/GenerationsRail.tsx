import { Heart, Layers, Paperclip, X } from "lucide-react";
import { useState } from "react";
import { focusedVariant, variantLabel } from "../state/derive";
import { addImageLayerFromSrc, IMAGO_IMAGE_DND } from "../state/fileIntake";
import type { ClientToServer, ImagoState } from "../state/types";
import { MarkRenderer } from "./annotations/MarkRenderer";

type Size = "s" | "m" | "l";
const THUMB: Record<Size, string> = {
  s: "w-[60px]",
  m: "w-[92px]",
  l: "w-[132px]",
};
// rendered thumb width in px (mirrors THUMB) — drives the mark overlay's stroke
// scale so annotations weld at thumb scale instead of full-image px.
const THUMB_PX: Record<Size, number> = { s: 60, m: 92, l: 132 };

// Left pane: every kept generation, grouped by batch. Click a variant to focus
// it on the canvas (a "focus" gesture the agent hears).
export function GenerationsRail({
  state,
  send,
}: {
  state: ImagoState;
  send: (m: ClientToServer) => void;
}) {
  const [size, setSize] = useState<Size>("m");
  // natural px per variant (measured on thumb load) → the mark overlay's viewBox
  // basis + slice alignment with the object-cover image.
  const [dims, setDims] = useState<Record<string, { w: number; h: number }>>({});
  // library filter: all media, AI-made (generate+edit), brought-in (import), or
  // References. The first three filter by batch.kind; "references" is a different
  // axis — a VARIANT predicate (v.refSelected) that cuts across batches — so it
  // filters variants WITHIN each batch (see the variant map) and keeps batches
  // with at least one selected ref. This is the "browse all your refs" home that
  // lets the bottom drawer stay just the selected tray.
  const [filter, setFilter] = useState<"all" | "generated" | "imported" | "references">("all");
  const refsFacet = filter === "references";
  // the focused image a generation can be composited onto (undefined on the blank
  // frame → "add as layer" hidden).
  const focusedSrc = focusedVariant(state)?.src;

  const shown = state.batches.filter((b) => {
    if (refsFacet) return b.variants.some((v) => v.refSelected);
    if (filter === "imported") return b.kind === "import";
    if (filter === "generated") return b.kind !== "import";
    return true; // all
  });
  const FILTERS: { id: typeof filter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "generated", label: "Generated" },
    { id: "imported", label: "Imported" },
    { id: "references", label: "References" },
  ];

  return (
    <aside className="card flex flex-col min-h-0 h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-divider">
        <span className="section-title">Library</span>
        <div className="inline-flex rounded-md border border-edge-strong overflow-hidden">
          {(["s", "m", "l"] as Size[]).map((z) => (
            <button
              type="button"
              key={z}
              onClick={() => setSize(z)}
              className={`px-2 py-0.5 text-xs font-medium ${
                size === z ? "bg-accent text-white" : "text-muted hover:bg-surface-3"
              }`}
            >
              {z.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* filter the library by source: all / AI-made / brought-in */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-divider">
        {FILTERS.map((f) => (
          <button
            type="button"
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={`px-2 py-0.5 text-xs font-medium rounded ${
              filter === f.id ? "bg-surface-3 text-ink" : "text-faint hover:text-ink"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-4">
        {state.batches.length === 0 && (
          <p className="text-faint italic text-center mt-10 px-4">
            your images appear here — say what you want to make on the right, or drop one in
          </p>
        )}
        {state.batches.length > 0 && shown.length === 0 && (
          <p className="text-faint italic text-center mt-10 px-4">nothing in this filter</p>
        )}

        {shown.map((b) => (
          <div key={b.id} className="flex flex-col gap-2 min-w-0">
            <div className="flex items-center gap-2">
              {/* canonical batch number (position in history), stable across filters */}
              <span className="text-xs font-medium text-ink">
                Batch {state.batches.indexOf(b) + 1}
              </span>
              <span
                className={
                  b.kind === "edit"
                    ? "badge-canon"
                    : b.kind === "import"
                      ? "badge-muted"
                      : "badge-accent"
                }
              >
                {b.kind}
              </span>
              <span className="text-faint ml-auto">
                {b.variants.length} {b.variants.length === 1 ? "variant" : "variants"}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {b.variants
                // keep the ORIGINAL index (vi) so the derived "a"/"b" label stays
                // stable; under the References facet, show only selected refs.
                .map((v, vi) => ({ v, vi }))
                .filter(({ v }) => !refsFacet || v.refSelected)
                .map(({ v, vi }) => {
                  const selected = state.focus?.variantId === v.id;
                  // composite the variant's layers + marks onto its thumbnail so you
                  // can tell a worked-on image (collage / annotations) from a raw one.
                  const marks = state.marksByVariant[v.id] ?? [];
                  const layers = state.layersByVariant[v.id] ?? [];
                  const d = dims[v.id];
                  const hasOverlay = (marks.length > 0 || layers.length > 0) && d && d.w > 0;
                  return (
                    // wrapper holds the ring + the two sibling buttons (a focus
                    // button can't NEST an "add as layer" button — invalid HTML).
                    <div
                      key={v.id}
                      className={`group relative rounded-md overflow-hidden aspect-square shrink-0 ${THUMB[size]} ${
                        selected ? "ring-2 ring-accent" : "ring-1 ring-edge hover:ring-edge-hover"
                      }`}
                    >
                      <button
                        type="button"
                        title={`Focus variant ${variantLabel(vi)}`}
                        onClick={() =>
                          send({
                            type: "focus.set",
                            batchId: b.id,
                            variantId: v.id,
                          })
                        }
                        className="absolute inset-0"
                      >
                        {v.src ? (
                          <img
                            src={v.src}
                            alt={`variant ${variantLabel(vi)}`}
                            className="w-full h-full object-cover"
                            // drag a sidebar image onto the canvas (margin → import,
                            // image-box → collage layer); stash src for the drop.
                            draggable
                            onDragStart={(e) => {
                              e.dataTransfer.setData(
                                IMAGO_IMAGE_DND,
                                JSON.stringify({
                                  src: v.src,
                                  name: `variant ${variantLabel(vi)}`,
                                  variantId: v.id, // lets a refs-drawer drop select THIS variant
                                }),
                              );
                              e.dataTransfer.effectAllowed = "copy";
                            }}
                            onLoad={(e) => {
                              const t = e.currentTarget;
                              setDims((prev) =>
                                prev[v.id]?.w === t.naturalWidth
                                  ? prev
                                  : { ...prev, [v.id]: { w: t.naturalWidth, h: t.naturalHeight } },
                              );
                            }}
                          />
                        ) : (
                          <div className="w-full h-full bg-surface-2" />
                        )}
                      </button>
                      {/* layer/mark overlay — slice to match the object-cover image;
                        pointer-events-none so the focus button still gets clicks */}
                      {hasOverlay && (
                        <MarkRenderer
                          marks={marks}
                          layers={layers}
                          natW={d.w}
                          natH={d.h}
                          scale={THUMB_PX[size] / d.w}
                          preserveAspectRatio="xMidYMid slice"
                        />
                      )}
                      <span className="absolute top-0.5 left-0.5 text-[9px] bg-black/60 text-ink px-1 rounded pointer-events-none">
                        {variantLabel(vi)}
                      </span>
                      {/* reference indicator — this variant is pointed at for the next
                        generation (mirrors the bottom "selected" tray). Top-center:
                        the four corners are taken (label / heart / add-layer / delete),
                        and the focus state already owns the accent ring. */}
                      {v.refSelected && (
                        <span
                          title="Selected as a reference for the next generation"
                          className="absolute top-0.5 left-1/2 -translate-x-1/2 bg-accent text-accent-ink rounded p-0.5 flex items-center pointer-events-none"
                        >
                          <Paperclip className="w-2.5 h-2.5" />
                        </span>
                      )}
                      {v.liked && (
                        <Heart className="absolute bottom-0.5 right-0.5 w-3 h-3 text-like fill-like pointer-events-none" />
                      )}
                      {/* composite a DIFFERENT generation onto the focused image */}
                      {focusedSrc && !selected && v.src && (
                        <button
                          type="button"
                          title="Add as a layer on the focused image"
                          onClick={() =>
                            addImageLayerFromSrc(
                              v.src,
                              `variant ${variantLabel(vi)}`,
                              focusedSrc,
                              send,
                            )
                          }
                          className="absolute top-0.5 right-0.5 bg-black/70 text-ink rounded p-0.5 opacity-0 group-hover:opacity-100 transition-opacity hover:text-accent-ink"
                        >
                          <Layers className="w-3 h-3" />
                        </button>
                      )}
                      {/* delete this image from the library (also drops its batch
                        when it empties; clears focus if it was focused) */}
                      <button
                        type="button"
                        title="Delete from library"
                        onClick={() =>
                          send({ type: "variant.remove", batchId: b.id, variantId: v.id })
                        }
                        className="absolute bottom-0.5 left-0.5 bg-black/70 text-ink rounded p-0.5 opacity-0 group-hover:opacity-100 transition-opacity hover:text-red-400"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  );
                })}
            </div>
            {b.tag && (
              <p className="text-faint italic break-words [overflow-wrap:anywhere]">{b.tag}</p>
            )}
          </div>
        ))}
      </div>
    </aside>
  );
}
