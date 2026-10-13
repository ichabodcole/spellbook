// Every recipe in src/kit/ui renders ONE class per utility group. The kit's
// `cn` only joins strings, so two classes from one group on an element (a base
// `rounded-lg` beside a size's own radius) leave the winner to stylesheet
// order, and the variant silently loses: sm buttons got 8px corners, not 6px
// (Scriptorium's move onto the kit, 2026-10-13). A recipe whose base class
// conflicts with a variant's is the defect, so the base must not hold it.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { cleanup, installDom, mount, removeDom, settle, waitFor } from "../lib/testDom.ts";
import {
  Button,
  buttonVariants,
  ConfirmDialog,
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
  createToastStore,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Dot,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Input,
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  Separator,
  StatusStrip,
  Toasts,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./index.ts";

const FONT_SIZE = /^text-(xs|sm|base|lg|[2-9]?xl|\[\d.*(px|rem|em)\])(\/.+)?$/;
const TEXT_OTHER =
  /^text-(left|center|right|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip)$/;
const BG_OTHER =
  /^bg-(clip|origin|none|fixed|local|scroll|repeat|no-repeat|cover|contain|auto|linear|radial|conic|gradient|blend)/;
const RADIUS = /^rounded(-(none|xs|sm|md|lg|xl|2xl|3xl|4xl|full|\[.*\]))?$/;

/** The groups one class claims, as tailwind-merge would count them. */
export function groupsOf(utility: string): string[] {
  const u = utility.replace(/^-/, "");
  if (RADIUS.test(u)) return ["radius"];
  if (/^size-/.test(u)) return ["height", "width"];
  if (/^h-/.test(u)) return ["height"];
  if (/^w-/.test(u)) return ["width"];
  if (/^max-w-/.test(u)) return ["max-width"];
  if (/^p-/.test(u)) return ["padding-l", "padding-r", "padding-t", "padding-b"];
  if (/^px-/.test(u)) return ["padding-l", "padding-r"];
  if (/^py-/.test(u)) return ["padding-t", "padding-b"];
  if (/^pl-/.test(u)) return ["padding-l"];
  if (/^pr-/.test(u)) return ["padding-r"];
  if (/^pt-/.test(u)) return ["padding-t"];
  if (/^pb-/.test(u)) return ["padding-b"];
  if (/^gap-\d|^gap-\[/.test(u)) return ["gap"];
  if (FONT_SIZE.test(u)) return ["font-size"];
  if (/^text-/.test(u) && !TEXT_OTHER.test(u)) return ["text-color"];
  if (/^bg-/.test(u) && !BG_OTHER.test(u)) return ["bg-color"];
  if (/^font-(thin|light|normal|medium|semibold|bold|extrabold|black)$/.test(u))
    return ["font-weight"];
  if (/^font-(sans|serif|mono)$/.test(u)) return ["font-family"];
  if (/^(flex|grid|block|inline-flex|inline-block|inline|hidden|contents)$/.test(u))
    return ["display"];
  if (/^items-/.test(u)) return ["align-items"];
  if (/^justify-(start|end|center|between|around|evenly|stretch)$/.test(u))
    return ["justify-content"];
  if (/^flex-(row|col)(-reverse)?$/.test(u)) return ["flex-direction"];
  if (/^(absolute|relative|fixed|sticky)$/.test(u)) return ["position"];
  return [];
}

/** Splits a class at its last top-level colon: the variant prefix, then the utility. */
function split(cls: string): [string, string] {
  let depth = 0;
  let cut = -1;
  for (let i = 0; i < cls.length; i++) {
    const c = cls[i];
    if (c === "[" || c === "(") depth++;
    else if (c === "]" || c === ")") depth--;
    else if (c === ":" && depth === 0) cut = i;
  }
  return cut < 0 ? ["", cls] : [cls.slice(0, cut), cls.slice(cut + 1)];
}

/** Each pair of classes on one element that claims the same group under the same variants. */
export function conflicts(classList: string): string[] {
  const seen = new Map<string, string>();
  const out: string[] = [];
  for (const cls of new Set(classList.split(/\s+/).filter(Boolean))) {
    const [prefix, utility] = split(cls.replace(/!$/, ""));
    for (const g of groupsOf(utility)) {
      const key = `${prefix}|${g}`;
      const prior = seen.get(key);
      if (prior && prior !== cls) out.push(`${g}: ${prior} + ${cls}`);
      else seen.set(key, cls);
    }
  }
  return [...new Set(out)];
}

describe("the group check itself", () => {
  test("catches two radii, a size beside a height, and padding shorthands", () => {
    expect(conflicts("rounded-lg rounded-[min(var(--radius-md),12px)]")).toHaveLength(1);
    expect(conflicts("size-7 h-8")).toEqual(["height: size-7 + h-8"]);
    expect(conflicts("p-4 px-2").length).toBeGreaterThan(0);
    expect(conflicts("text-sm text-xs")).toEqual(["font-size: text-sm + text-xs"]);
    expect(conflicts("text-sm/relaxed text-[11px]")).toHaveLength(1);
  });
  test("lets one group per variant prefix through, and colours apart from sizes", () => {
    expect(conflicts("rounded-md in-data-[slot=button-group]:rounded-lg")).toEqual([]);
    expect(conflicts("text-sm text-ink bg-bg bg-clip-padding")).toEqual([]);
    expect(conflicts("px-2 py-1 pl-1.5")).toEqual(["padding-l: px-2 + pl-1.5"]);
  });
});

const VARIANTS = ["default", "outline", "secondary", "ghost", "destructive", "link"] as const;
const SIZES = [
  "default",
  "xs",
  "sm",
  "chrome",
  "2xs",
  "3xs",
  "lg",
  "icon",
  "icon-xs",
  "icon-sm",
  "icon-lg",
] as const;

describe("button: every variant at every size holds one class per group", () => {
  for (const variant of VARIANTS)
    for (const size of SIZES)
      test(`${variant} × ${size}`, () => {
        expect(conflicts(buttonVariants({ variant, size }))).toEqual([]);
      });
});

beforeAll(installDom);
afterEach(cleanup);
afterAll(removeDom);

function offenders(root: ParentNode): string[] {
  return [...root.querySelectorAll("[class]")].flatMap((el) => {
    const found = conflicts(el.getAttribute("class") ?? "");
    const slot = el.getAttribute("data-slot") ?? el.tagName.toLowerCase();
    return found.map((f) => `${slot}: ${f}`);
  });
}

describe("every rendered primitive holds one class per group", () => {
  test("the ones that render without opening", async () => {
    const store = createToastStore();
    const m = await mount(
      <div>
        <Input placeholder="p" />
        <Separator />
        <Separator orientation="vertical" />
        <Dot tone="bg-danger" pulse />
        <Empty>
          <EmptyHeader>
            <EmptyMedia>a</EmptyMedia>
            <EmptyMedia variant="icon">b</EmptyMedia>
            <EmptyTitle>t</EmptyTitle>
            <EmptyDescription>d</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button>go</Button>
          </EmptyContent>
        </Empty>
        <div style={{ width: 400, height: 200 }}>
          <ResizablePanelGroup orientation="horizontal">
            <ResizablePanel id="a">A</ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel id="b">B</ResizablePanel>
          </ResizablePanelGroup>
        </div>
        <StatusStrip
          segments={[
            { label: "a", value: "1" },
            { value: "2", priority: "low" },
          ]}
        />
        <Toasts store={store} />
      </div>,
    );
    await settle(() => {
      store.announce("Saved", "All of it", [{ label: "Undo", onAct: () => {} }]);
    });
    expect(offenders(m.container)).toEqual([]);
    store.dispose();
    await m.unmount();
  });

  test("dialogs, at both sizes, and the confirm dialog", async () => {
    for (const size of ["default", "md"] as const) {
      const m = await mount(
        <Dialog open>
          <DialogContent size={size}>
            <DialogHeader>
              <DialogTitle>t</DialogTitle>
              <DialogDescription>d</DialogDescription>
            </DialogHeader>
            <DialogFooter showCloseButton>
              <Button>ok</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>,
      );
      await waitFor(() => !!document.querySelector('[data-slot="dialog-content"]'), "the dialog");
      expect(offenders(document.body)).toEqual([]);
      await m.unmount();
    }
    const c = await mount(
      <ConfirmDialog open onOpenChange={() => {}} title="t" message="m" onConfirm={() => {}} />,
    );
    await waitFor(() => !!document.querySelector('[data-slot="confirm-dialog"]'), "confirm");
    expect(offenders(document.body)).toEqual([]);
    await c.unmount();
  });

  test("the dropdown menu, every item kind", async () => {
    const m = await mount(
      <DropdownMenu open>
        <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuGroup>
            <DropdownMenuLabel inset>label</DropdownMenuLabel>
            <DropdownMenuItem>
              one <DropdownMenuShortcut>⌘1</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem inset>inset</DropdownMenuItem>
            <DropdownMenuItem stacked>stacked</DropdownMenuItem>
            <DropdownMenuItem variant="destructive">gone</DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem checked>check</DropdownMenuCheckboxItem>
          <DropdownMenuRadioGroup value="a">
            <DropdownMenuRadioItem value="a">a</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger inset>more</DropdownMenuSubTrigger>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    await waitFor(() => !!document.querySelector('[data-slot="dropdown-menu-item"]'), "items");
    expect(offenders(document.body)).toEqual([]);
    await m.unmount();
  });

  test("the context menu, every item kind", async () => {
    const m = await mount(
      <ContextMenu>
        <ContextMenuTrigger>Right-click me</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuGroup>
            <ContextMenuLabel inset>label</ContextMenuLabel>
            <ContextMenuItem>
              one <ContextMenuShortcut>⌘1</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem inset>inset</ContextMenuItem>
            <ContextMenuItem variant="destructive">gone</ContextMenuItem>
          </ContextMenuGroup>
          <ContextMenuSeparator />
          <ContextMenuCheckboxItem checked>check</ContextMenuCheckboxItem>
          <ContextMenuRadioGroup value="a">
            <ContextMenuRadioItem value="a">a</ContextMenuRadioItem>
          </ContextMenuRadioGroup>
          <ContextMenuSub>
            <ContextMenuSubTrigger inset>more</ContextMenuSubTrigger>
          </ContextMenuSub>
        </ContextMenuContent>
      </ContextMenu>,
    );
    const trigger = document.querySelector('[data-slot="context-menu-trigger"]');
    await settle(() => {
      trigger?.dispatchEvent(
        new window.MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
        }),
      );
    });
    await waitFor(() => !!document.querySelector('[data-slot="context-menu-item"]'), "items");
    expect(offenders(document.body)).toEqual([]);
    await m.unmount();
  });

  test("the tooltip and the popover, open", async () => {
    const m = await mount(
      <div>
        <TooltipProvider>
          <Tooltip open>
            <TooltipTrigger>Hover</TooltipTrigger>
            <TooltipContent>Says more</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <Popover open>
          <PopoverTrigger>Open</PopoverTrigger>
          <PopoverContent>
            <PopoverTitle>t</PopoverTitle>
            <PopoverDescription>d</PopoverDescription>
          </PopoverContent>
        </Popover>
      </div>,
    );
    await waitFor(() => !!document.querySelector('[data-slot="tooltip-content"]'), "the tooltip");
    expect(offenders(document.body)).toEqual([]);
    await m.unmount();
  });
});
