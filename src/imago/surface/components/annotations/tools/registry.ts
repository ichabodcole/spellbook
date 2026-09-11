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

const TOOLS = {
  arrow: ArrowTool,
  line: LineTool,
  pin: PinTool,
  rect: RectTool,
  ellipse: EllipseTool,
  draw: DrawTool,
} satisfies Record<string, ToolPlugin>;

/** A registered tool's id — derived from the registry, so it cannot drift. */
export type ToolId = keyof typeof TOOLS;

// Looked up by ARBITRARY strings too (the active tool may be the `select`
// pseudo-tool), so this view stays string-keyed and its reads stay optional.
export const TOOL_REGISTRY: Readonly<Record<string, ToolPlugin>> = TOOLS;

/** The plugin for a registered id — total, because `id` is a `ToolId`. */
export function toolPlugin(id: ToolId): ToolPlugin {
  return TOOLS[id];
}

// Display order in the toolbar (after the `select` pseudo-tool). ⛔ Typed as
// `ToolId[]`, not `string[]`: this list and the registry above used to be two
// hand-kept string lists, so an id in the ORDER but missing from the REGISTRY
// type-checked and crashed the toolbar at render (`p.id` of undefined). Now
// that is a compile error. (The converse — registered but not ordered — never
// crashed; the tool is simply absent from the toolbar, and still compiles.)
export const TOOL_ORDER: readonly ToolId[] = ["arrow", "line", "pin", "rect", "ellipse", "draw"];
