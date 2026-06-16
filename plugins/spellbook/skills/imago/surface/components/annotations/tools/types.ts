// surface/components/annotations/tools/types.ts
// The annotation tool extension point. Adding a tool = implement ToolPlugin +
// register it in registry.ts; nothing else in the layer needs to change.
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { Mark } from "../../../state/types";
import type { Point } from "../coords";
import type { DrawStyle } from "../style";

// A tool's mid-gesture draft (live preview only, never sent). Each tool owns its
// own shape; the layer treats it opaquely. null = no draft in progress.
export type Draft = unknown;

// Result of a pointerUp: optionally a finished Mark to commit, and the next
// draft. Absent/null draft → the layer clears it (arrow). A returned draft keeps
// it alive (pin keeps its inline editor open until Enter/blur).
export type ToolUpResult = { mark?: Mark; draft?: Draft | null };

// Lets a deferred tool (e.g. the pin's inline text editor) commit/cancel/update
// outside the pointer gesture.
export type DraftContext = {
  commit: (mark: Mark) => void;
  cancel: () => void;
  update: (draft: Draft) => void;
  style: DrawStyle; // active draw style, so a draft can preview WYSIWYG (color/width/text)
  scale: number; // viewport zoom scale, so the draft welds to the image like committed marks
};

export type ToolPlugin = {
  id: string;
  icon: LucideIcon;
  title: string;
  cursor: string; // tailwind cursor utility for the stage while this tool is active
  capturePointer: boolean; // setPointerCapture on down? (true for drag tools)
  onDown: (p: Point, draft: Draft) => Draft;
  onMove: (p: Point, draft: Draft) => Draft;
  onUp: (p: Point, draft: Draft) => ToolUpResult;
  renderDraft: (draft: Draft, ctx: DraftContext) => ReactNode;
};
