// Reader mode: the rendered view with both side columns out of the way and the
// chrome quieter.
//
// READER MODE IS A PRESET, NOT A FIFTH VIEW MODE. It is DERIVED: true exactly when
// the view is rendered and both columns are shut, however that came about (the
// toggle, two collapse buttons, a drag, a reload). There is no reader flag that
// could fall out of step with the columns it describes. DOM-free, so the rules are
// tests; `DocumentPane` does the wiring.

import { type Collapsed, type ColumnSide, COLUMN_SIDES as SIDES } from "../context/columns.ts";
import type { ViewMode } from "./pane.ts";

/** Whether the pane is in reader mode: rendered, with both columns collapsed. */
export function isReader(mode: ViewMode, collapsed: Collapsed): boolean {
  return mode === "rendered" && collapsed.context && collapsed.chat;
}

/**
 * What the reader toggle does. Entering sets rendered (from raw, split or compare
 * alike) and collapses whatever is open; leaving reopens both columns and leaves the
 * view rendered. A preset remembers nothing about where you were, which is what
 * keeps it one state.
 */
export function readerAct(
  mode: ViewMode,
  collapsed: Collapsed,
): { mode?: "rendered"; collapse: ColumnSide[]; expand: ColumnSide[] } {
  if (isReader(mode, collapsed)) return { expand: [...SIDES], collapse: [] };
  return { mode: "rendered", collapse: SIDES.filter((s) => !collapsed[s]), expand: [] };
}

/**
 * What reader mode's fade leaves alone: anything asking for attention stays at full
 * strength, and only idle chrome fades. That is unsaved edits (Save, and the
 * save-state marker saying "Unsaved") and a warning (the same marker saying
 * "Changed on disk", or "File gone"). With nothing unsaved, Save is disabled and fades with the
 * rest; the changed-on-disk banner, which carries the acts that answer it, is never
 * faded at all.
 */
export function readerStaysLoud(
  part: "save" | "status" | "other",
  doc: { dirty: boolean; outsideChanged: boolean; missing?: "file" | "folder" },
): boolean {
  if (part === "save") return doc.dirty;
  if (part === "status") return doc.dirty || doc.outsideChanged || !!doc.missing;
  return false;
}
