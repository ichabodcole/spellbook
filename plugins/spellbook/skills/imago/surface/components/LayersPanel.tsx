// surface/components/LayersPanel.tsx
// The layers inspector — a heterogeneous, reorderable list of the focused
// variant's container layers (layersByVariant[focus]) plus a synthetic locked
// "Background" row for the base image. Lives in the right-of-stage details aside
// as a sibling tab to Details. Consumes the layer.* contract directly; the server
// is authoritative + undoable (one history step per op), so every control is a
// single send() — no local layer state to keep in sync.
//
// ORDER: layersByVariant is back→front (index 0 = back). The panel reads top→bottom
// as front→back, so the list is rendered REVERSED. The Background row (the Variant
// itself) is pinned at the BOTTOM — it is NOT a stored layer: not draggable, not
// hideable/lockable, not removable.
//
// REORDER index mapping: HTML5 drag-drop gives a VISUAL index in the reversed list;
// layer.reorder wants the absolute server index (back→front). The inversion is
//   toIndex = (realCount - 1) - visualIndex
// — get this right or layers stack upside-down.
import {
  Eye,
  EyeOff,
  GripVertical,
  Image as ImageIcon,
  Lock,
  Pencil,
  Shapes,
  Unlock,
  X,
} from "lucide-react";
import type React from "react";
import { useState } from "react";
import type { ClientToServer, Layer, Mark } from "../state/types";

export function LayersPanel({
  layers,
  marks,
  send,
  variantSrc,
  selectedMarkId,
  onClearSelection,
}: {
  layers: Layer[]; // server order: back→front (index 0 = back)
  marks: Mark[]; // derives image-layer thumbnails + the selected-mark → layer check
  send: (m: ClientToServer) => void;
  variantSrc?: string; // the Background row's thumbnail (the base image)
  selectedMarkId: string | null;
  onClearSelection: () => void; // drop selection when its layer goes hidden/locked/removed
}) {
  const [editingId, setEditingId] = useState<string | null>(null); // layer being renamed
  const [draftName, setDraftName] = useState("");
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null); // row under the drag (drop target)

  const realCount = layers.length;
  const visual = [...layers].reverse(); // front-first display order

  // Does the current selection live in this layer? Drives auto-deselect when the
  // layer is hidden/locked/removed out from under a selected-but-now-unreachable mark.
  function selectionIn(layerId: string): boolean {
    return (
      selectedMarkId != null && marks.find((m) => m.id === selectedMarkId)?.layerId === layerId
    );
  }

  function toggleHidden(layer: Layer) {
    const hidden = !layer.hidden;
    send({ type: "layer.setHidden", id: layer.id, hidden });
    if (hidden && selectionIn(layer.id)) onClearSelection();
  }
  function toggleLocked(layer: Layer) {
    const locked = !layer.locked;
    send({ type: "layer.setLocked", id: layer.id, locked });
    if (locked && selectionIn(layer.id)) onClearSelection();
  }
  function remove(layer: Layer) {
    send({ type: "layer.remove", id: layer.id }); // deletes the layer AND its marks
    if (selectionIn(layer.id)) onClearSelection();
  }
  function commitRename(layer: Layer) {
    const name = draftName.trim();
    if (name && name !== layer.name) send({ type: "layer.rename", id: layer.id, name });
    setEditingId(null);
  }

  // Drop the dragged layer onto the row at visualIndex → absolute server toIndex.
  function onDropRow(visualIndex: number) {
    const id = draggingId;
    setDraggingId(null);
    setOverId(null);
    if (!id) return;
    const target = visual[visualIndex];
    if (!target || target.id === id) return; // dropped on itself → no-op
    send({ type: "layer.reorder", id, toIndex: realCount - 1 - visualIndex });
  }

  return (
    <div className="p-2 flex flex-col gap-0.5 text-xs">
      {realCount === 0 && (
        <p className="px-2 py-3 text-faint italic text-center">
          No layers yet — drop an image onto the canvas, or group marks, to make one.
        </p>
      )}

      {visual.map((layer, j) => {
        // an image layer's thumbnail is its bitmap, which lives on the image MARK
        // (not the Layer). Find the layer's image element, then narrow to read `src`.
        const imgMark =
          layer.kind === "image"
            ? marks.find((m) => m.layerId === layer.id && m.tool === "image")
            : undefined;
        const thumbSrc = imgMark?.tool === "image" ? imgMark.src : undefined;
        const isEditing = editingId === layer.id;
        const sel = selectionIn(layer.id);
        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: HTML5 drag-drop reorder target
          <div
            key={layer.id}
            onDragOver={(e) => {
              if (!draggingId) return;
              e.preventDefault(); // allow drop
              if (overId !== layer.id) setOverId(layer.id);
            }}
            onDragLeave={(e) => {
              if (e.currentTarget === e.target) setOverId((id) => (id === layer.id ? null : id));
            }}
            onDrop={(e) => {
              e.preventDefault();
              onDropRow(j);
            }}
            className={`group flex items-center gap-1.5 rounded-md px-1.5 py-1 border ${
              overId === layer.id ? "border-accent bg-accent/10" : "border-transparent"
            } ${sel ? "bg-accent/10" : "hover:bg-surface-3"} ${layer.hidden ? "opacity-55" : ""}`}
          >
            {/* drag handle — a button so it stays interactive (no a11y flag) */}
            <button
              type="button"
              draggable
              onDragStart={() => setDraggingId(layer.id)}
              onDragEnd={() => {
                setDraggingId(null);
                setOverId(null);
              }}
              title="Drag to reorder"
              className="shrink-0 cursor-grab active:cursor-grabbing text-faint hover:text-muted"
            >
              <GripVertical className="w-3.5 h-3.5" />
            </button>

            {/* thumbnail — the bitmap for an image layer, else a kind icon */}
            <span className="shrink-0 w-7 h-7 rounded ring-1 ring-edge overflow-hidden bg-surface-2 flex items-center justify-center text-muted">
              {thumbSrc ? (
                <img src={thumbSrc} alt="" className="w-full h-full object-cover" />
              ) : layer.kind === "sketch" ? (
                <Pencil className="w-3.5 h-3.5" />
              ) : layer.kind === "image" ? (
                <ImageIcon className="w-3.5 h-3.5" />
              ) : (
                <Shapes className="w-3.5 h-3.5" />
              )}
            </span>

            {/* name — double-click to rename inline */}
            {isEditing ? (
              <input
                ref={(el) => {
                  if (el) {
                    el.focus();
                    el.select();
                  }
                }}
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename(layer);
                  else if (e.key === "Escape") setEditingId(null);
                }}
                onBlur={() => commitRename(layer)}
                className="flex-1 min-w-0 bg-surface border border-edge-strong rounded px-1 py-0.5 text-ink"
              />
            ) : (
              <button
                type="button"
                onDoubleClick={() => {
                  setEditingId(layer.id);
                  setDraftName(layer.name);
                }}
                title="Double-click to rename"
                className="flex-1 min-w-0 text-left truncate text-ink"
              >
                {layer.name}
              </button>
            )}

            {/* visibility · lock · delete */}
            <RowButton
              title={layer.hidden ? "Show layer" : "Hide layer"}
              active={layer.hidden}
              onClick={() => toggleHidden(layer)}
            >
              {layer.hidden ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            </RowButton>
            <RowButton
              title={layer.locked ? "Unlock layer" : "Lock layer"}
              active={layer.locked}
              onClick={() => toggleLocked(layer)}
            >
              {layer.locked ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
            </RowButton>
            <RowButton title="Delete layer (and its marks)" onClick={() => remove(layer)}>
              <X className="w-3.5 h-3.5" />
            </RowButton>
          </div>
        );
      })}

      {/* synthetic Background row = the base image (the Variant). Not a real layer:
          pinned at the bottom, implicitly locked, no controls. */}
      <div className="flex items-center gap-1.5 rounded-md px-1.5 py-1 border-t border-divider mt-0.5 pt-1.5">
        <span className="shrink-0 w-3.5" />
        <span className="shrink-0 w-7 h-7 rounded ring-1 ring-edge overflow-hidden bg-surface-2 flex items-center justify-center text-muted">
          {variantSrc ? (
            <img src={variantSrc} alt="" className="w-full h-full object-cover" />
          ) : (
            <ImageIcon className="w-3.5 h-3.5" />
          )}
        </span>
        <span className="flex-1 min-w-0 truncate text-muted">Background</span>
        <span className="shrink-0 p-1 text-faint" title="The base image is locked">
          <Lock className="w-3.5 h-3.5" />
        </span>
      </div>
    </div>
  );
}

function RowButton({
  title,
  active,
  onClick,
  children,
}: {
  title: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`shrink-0 p-1 rounded ${active ? "text-accent-ink" : "text-faint hover:text-ink"}`}
    >
      {children}
    </button>
  );
}
