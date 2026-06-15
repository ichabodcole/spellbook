// surface/components/annotations/tools/registry.ts
// The tool registry. Adding a tool = import it and add it here; the toolbar and
// layer pick it up automatically. (rect/ellipse land in step 2.)
import { ArrowTool } from "./ArrowTool";
import { DrawTool } from "./DrawTool";
import { EllipseTool } from "./EllipseTool";
import { LineTool } from "./LineTool";
import { PinTool } from "./PinTool";
import { RectTool } from "./RectTool";
import type { ToolPlugin } from "./types";

export const TOOL_REGISTRY: Record<string, ToolPlugin> = {
  arrow: ArrowTool,
  line: LineTool,
  pin: PinTool,
  rect: RectTool,
  ellipse: EllipseTool,
  draw: DrawTool,
};

// Display order in the toolbar (after the `select` pseudo-tool).
export const TOOL_ORDER: readonly string[] = ["arrow", "line", "pin", "rect", "ellipse", "draw"];
