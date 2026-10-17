// What a sidebar row carries when it is dragged out of the sidebar
// (kit-tree-drag-into-document): the row's entry, absolute path and kind, under
// one MIME type of the kit's own. Every row sets it, the tree's and the list's,
// so anything that takes a drop can read which rows came without knowing the
// sidebar: an open document embeds a dragged image, and the board will make a
// reference card from the same drag.
//
// No `text/plain` goes with it, on purpose: a drop onto a text field or an
// editor that does not read this type must insert nothing, not a stray path.
// The sidebar reads it too, for every move that leaves the tree: a row dropped
// on a set in the list, on the list itself or on a set's way back (the
// workspace). A move within one set's tree still comes from the tree's own
// drag state.

import type { ContextNode } from "../workspace/protocol";

/** The MIME type a dragged sidebar row is carried under. */
export const ROW_DRAG_MIME = "application/x-story-studio-rows+json";

/**
 * What a row is. `set` is a whole context entry dragged from the list;
 * `bundle` is one item that is a folder on disk (`lib/bundles.ts`), its path
 * the folder's. A reader drops kinds it does not know.
 */
export type RowDragKind = "document" | "image" | "bundle" | "folder" | "set";

const KINDS: readonly RowDragKind[] = ["document", "image", "bundle", "folder", "set"];

/** One dragged row. */
export type DraggedRow = {
  /** The context entry's id. */
  entry: string;
  /** The row's absolute path (a set's root, for `set`). */
  path: string;
  kind: RowDragKind;
};

/** The rows the last drag from this page carried (`draggedRows`). */
let lastRows: readonly DraggedRow[] | null = null;

/** The data carried under `ROW_DRAG_MIME`, for a library that sets it itself. */
export function encodeRowDrag(rows: readonly DraggedRow[]): string {
  lastRows = rows.map((r) => ({ ...r }));
  return JSON.stringify({ rows });
}

/**
 * The rows the last row drag from THIS page carried, for a target that must
 * judge a drag while it is still over it (a board refusing a board that would
 * be inside itself): `dragover` cannot read the data, only its types. Ask
 * only while `carriesRows` says the drag carries rows; a drag from another
 * page carries rows this page never wrote, so treat the answer as a preview
 * and judge the drop by `readRowDrag`.
 */
export function draggedRows(): readonly DraggedRow[] | null {
  return lastRows;
}

/** Put `rows` on a drag. Call from `dragstart`; a drag with no rows carries nothing. */
export function writeRowDrag(dt: Pick<DataTransfer, "setData">, rows: readonly DraggedRow[]): void {
  if (rows.length === 0) return;
  dt.setData(ROW_DRAG_MIME, encodeRowDrag(rows));
}

/**
 * Whether a drag carries rows. Readable in `dragover` and `dragenter`, where
 * the browser hides the data itself and shows only its types.
 */
export function carriesRows(dt: Pick<DataTransfer, "types"> | null): boolean {
  return !!dt && Array.from(dt.types).includes(ROW_DRAG_MIME);
}

/**
 * The rows a drop carries, or null when it carries none. Only `drop` can read
 * them. A row that is not well formed, or of a kind this kit does not know, is
 * left out rather than failing the whole drop.
 */
export function readRowDrag(dt: Pick<DataTransfer, "getData"> | null): DraggedRow[] | null {
  const raw = dt?.getData(ROW_DRAG_MIME);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const list = (parsed as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(list)) return null;
  const rows: DraggedRow[] = [];
  for (const r of list as unknown[]) {
    if (typeof r !== "object" || r === null) continue;
    const { entry, path, kind } = r as Record<string, unknown>;
    if (typeof entry !== "string" || typeof path !== "string" || path === "") continue;
    if (!KINDS.includes(kind as RowDragKind)) continue;
    rows.push({ entry, path, kind: kind as RowDragKind });
  }
  return rows.length > 0 ? rows : null;
}

/** The drag kind of a tree node: a group is a folder. */
export function rowKindOf(node: Pick<ContextNode, "kind">): RowDragKind {
  return node.kind === "group"
    ? "folder"
    : node.kind === "image"
      ? "image"
      : node.kind === "bundle"
        ? "bundle"
        : "document";
}
