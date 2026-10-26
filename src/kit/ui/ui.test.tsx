// A smoke render per component: it mounts in a DOM, carries its slot marker,
// and the interactive ones answer a real interaction. The shadcn recipes are
// generated code; what is worth holding is that they still render on the Base UI
// version this kit pins.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { useState } from "react";
import { cleanup, installDom, mount, removeDom, settle, waitFor } from "../lib/testDom.ts";
import {
  Button,
  ConfirmDialog,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  createToastStore,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Dot,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Input,
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
  useConfirm,
} from "./index.ts";

// The import registers a DOM once per process; a file that runs after another has
// removed it registers again.
beforeAll(installDom);
afterEach(cleanup);
afterAll(removeDom);

const slot = (root: ParentNode, name: string) => root.querySelector(`[data-slot="${name}"]`);
const click = async (el: Element | null) => {
  if (!el) throw new Error("nothing to click");
  await settle(() => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};

describe("ui smoke renders", () => {
  test("Button renders its variant and fires onClick", async () => {
    let clicked = 0;
    const m = await mount(
      <Button variant="secondary" size="sm" onClick={() => clicked++}>
        Go
      </Button>,
    );
    const b = slot(m.container, "button");
    expect(b?.textContent).toBe("Go");
    await click(b);
    expect(clicked).toBe(1);
    await m.unmount();
  });

  test("Input renders and carries its value", async () => {
    const m = await mount(<Input defaultValue="hello" placeholder="p" />);
    const i = slot(m.container, "input") as HTMLInputElement;
    expect(i.value).toBe("hello");
    expect(i.placeholder).toBe("p");
    await m.unmount();
  });

  test("Separator renders with its orientation", async () => {
    const m = await mount(<Separator orientation="vertical" />);
    expect(slot(m.container, "separator")?.getAttribute("data-orientation")).toBe("vertical");
    await m.unmount();
  });

  test("Empty renders its parts", async () => {
    const m = await mount(
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Nothing yet</EmptyTitle>
          <EmptyDescription>Add something.</EmptyDescription>
        </EmptyHeader>
      </Empty>,
    );
    expect(slot(m.container, "empty-title")?.textContent).toBe("Nothing yet");
    expect(slot(m.container, "empty-description")?.textContent).toBe("Add something.");
    await m.unmount();
  });

  test("Dot renders, tinted and pulsing on request", async () => {
    const m = await mount(<Dot tone="bg-danger" pulse title="stalled" />);
    const d = m.container.firstElementChild as HTMLElement;
    expect(d.className).toContain("bg-danger");
    expect(d.className).toContain("animate-pulse");
    expect(d.title).toBe("stalled");
    await m.unmount();
  });

  test("Dialog opens with its content and title", async () => {
    const m = await mount(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Rename</DialogTitle>
          <DialogDescription>Pick a name.</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    const content = slot(document.body, "dialog-content");
    expect(content).not.toBeNull();
    expect(slot(document.body, "dialog-title")?.textContent).toBe("Rename");
    await m.unmount();
  });

  test("ConfirmDialog confirms and cancels", async () => {
    const seen: string[] = [];
    const m = await mount(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Move it?"
        message="One document."
        confirmLabel="Move"
        onConfirm={() => seen.push("confirm")}
        onCancel={() => seen.push("cancel")}
      />,
    );
    await waitFor(() => !!slot(document.body, "confirm-dialog"), "the confirm dialog");
    const popup = slot(document.body, "confirm-dialog");
    expect(popup?.textContent).toContain("Move it?");
    const buttons = [...(popup?.querySelectorAll("button") ?? [])];
    await click(buttons.find((b) => b.textContent === "Move") ?? null);
    expect(seen).toEqual(["confirm"]);
    await click(buttons.find((b) => b.textContent === "Cancel") ?? null);
    expect(seen).toContain("cancel");
    await m.unmount();
  });

  test("a modal keeps the page behind inert and Tab inside, and lets the page back on close", async () => {
    let close: () => void = () => {};
    function Host({ kind }: { kind: "confirm" | "dialog" }) {
      const [open, setOpen] = useState(true);
      close = () => setOpen(false);
      return (
        <>
          <button type="button">Behind</button>
          {kind === "confirm" ? (
            <ConfirmDialog
              open={open}
              onOpenChange={setOpen}
              title="Sure?"
              confirmLabel="Yes"
              onConfirm={() => {}}
            />
          ) : (
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogContent>
                <DialogTitle>Rename</DialogTitle>
              </DialogContent>
            </Dialog>
          )}
        </>
      );
    }
    for (const [kind, slotName] of [
      ["confirm", "confirm-dialog"],
      ["dialog", "dialog-content"],
    ] as const) {
      const m = await mount(<Host kind={kind} />);
      await waitFor(() => !!slot(document.body, slotName), `the ${kind} popup`);
      const popup = slot(document.body, slotName) as HTMLElement;
      const behind = [...document.body.querySelectorAll("button")].find(
        (b) => b.textContent === "Behind",
      ) as HTMLElement;
      const holderOf = (el: Element) => {
        let at: Element | null = el;
        while (at && at.parentElement !== document.body) at = at.parentElement;
        return at as HTMLElement;
      };
      // Everything but the popup's own portal is inert.
      expect(holderOf(behind).inert).toBe(true);
      expect(holderOf(popup).inert).toBe(false);
      // Focus landing beside the popup (a focus guard) goes round to its other end.
      const stops = [...popup.querySelectorAll("button")];
      const guards = [...holderOf(popup).querySelectorAll<HTMLElement>("[tabindex='0']")].filter(
        (g) => !popup.contains(g),
      );
      expect(guards.length).toBeGreaterThan(0);
      const after = guards.find((g) => popup.compareDocumentPosition(g) & 4) as HTMLElement;
      await settle(() => after.focus());
      expect(document.activeElement).toBe(stops[0] as HTMLElement);
      const before = guards.find((g) => popup.compareDocumentPosition(g) & 2) as HTMLElement;
      await settle(() => before.focus());
      expect(document.activeElement).toBe(stops.at(-1) as HTMLElement);
      // Closed, the page is back.
      await settle(() => close());
      await waitFor(() => !holderOf(behind).inert, "the page back");
      await m.unmount();
    }
  });

  test("useConfirm answers a promise", async () => {
    let ask: (() => Promise<boolean>) | undefined;
    function Host() {
      const { confirm, dialog } = useConfirm();
      ask = () => confirm({ title: "Sure?", confirmLabel: "Yes" });
      return <>{dialog}</>;
    }
    const m = await mount(<Host />);
    let answer: boolean | undefined;
    await settle(() => {
      void ask?.().then((v) => {
        answer = v;
      });
    });
    await waitFor(() => !!slot(document.body, "confirm-dialog"), "the confirm dialog");
    const yes = [...document.body.querySelectorAll("button")].find((b) => b.textContent === "Yes");
    await click(yes ?? null);
    await settle();
    expect(answer).toBe(true);
    await m.unmount();
  });

  test("DropdownMenu opens from its trigger and runs an item", async () => {
    const picked: string[] = [];
    const m = await mount(
      <DropdownMenu>
        <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onClick={() => picked.push("one")}>One</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    expect(slot(m.container, "dropdown-menu-trigger")).not.toBeNull();
    await click(slot(m.container, "dropdown-menu-trigger"));
    await waitFor(() => !!slot(document.body, "dropdown-menu-item"), "the menu item");
    const item = slot(document.body, "dropdown-menu-item");
    expect(item?.textContent).toBe("One");
    await click(item);
    expect(picked).toEqual(["one"]);
    await m.unmount();
  });

  test("ContextMenu opens on a context click", async () => {
    const m = await mount(
      <ContextMenu>
        <ContextMenuTrigger>Right-click me</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>Open</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    );
    const trigger = slot(m.container, "context-menu-trigger");
    expect(trigger).not.toBeNull();
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
    await waitFor(() => !!slot(document.body, "context-menu-item"), "the menu item");
    expect(slot(document.body, "context-menu-item")?.textContent).toBe("Open");
    await m.unmount();
  });

  test("Tooltip renders its trigger, and its content when open", async () => {
    const m = await mount(
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger>Hover</TooltipTrigger>
          <TooltipContent>Says more</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    expect(slot(m.container, "tooltip-trigger")?.textContent).toBe("Hover");
    await waitFor(() => !!slot(document.body, "tooltip-content"), "the tooltip");
    expect(slot(document.body, "tooltip-content")?.textContent).toContain("Says more");
    await m.unmount();
  });

  test("Resizable renders a group of panels and a handle", async () => {
    const m = await mount(
      <div style={{ width: 400, height: 200 }}>
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel id="a">A</ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel id="b">B</ResizablePanel>
        </ResizablePanelGroup>
      </div>,
    );
    expect(slot(m.container, "resizable-panel-group")).not.toBeNull();
    expect(m.container.querySelectorAll('[data-slot="resizable-panel"]').length).toBe(2);
    expect(slot(m.container, "resizable-handle")).not.toBeNull();
    await m.unmount();
  });

  test("Toasts show an announcement, run its action, and dismiss", async () => {
    const store = createToastStore();
    const acted: string[] = [];
    function Host() {
      const [, force] = useState(0);
      return (
        <div>
          <button type="button" onClick={() => force((n) => n + 1)}>
            tick
          </button>
          <Toasts store={store} />
        </div>
      );
    }
    const m = await mount(<Host />);
    await settle(() => {
      store.announce("Saved", "All of it", [{ label: "Undo", onAct: () => acted.push("undo") }]);
    });
    expect(m.container.textContent).toContain("Saved");
    const undo = [...m.container.querySelectorAll("button")].find((b) => b.textContent === "Undo");
    await click(undo ?? null);
    expect(acted).toEqual(["undo"]);
    expect(store.snapshot()).toHaveLength(0);
    store.dispose();
    await m.unmount();
  });

  test("StatusStrip renders its segments with a divider between them", async () => {
    const m = await mount(
      <StatusStrip
        segments={[
          { label: "Version", value: "v2 by you" },
          { value: "saved" },
          { label: "Words", value: "420", priority: "low" },
        ]}
      />,
    );
    const strip = slot(m.container, "status-strip");
    expect(strip?.textContent).toContain("Version:v2 by you");
    expect(strip?.textContent).toContain("saved");
    expect(strip?.textContent).toContain("Words:420");
    expect(strip?.querySelectorAll('[data-slot="separator"]')).toHaveLength(2);
    await m.unmount();
  });

  test("Escape closes a dialog", async () => {
    const seen: boolean[] = [];
    function Host() {
      const [open, setOpen] = useState(true);
      return (
        <ConfirmDialog
          open={open}
          onOpenChange={(next) => {
            seen.push(next);
            setOpen(next);
          }}
          title="Sure?"
          onConfirm={() => {}}
        />
      );
    }
    const m = await mount(<Host />);
    await waitFor(() => !!slot(document.body, "confirm-dialog"), "the dialog");
    await settle(() => {
      document.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    await waitFor(() => !slot(document.body, "confirm-dialog"), "the dialog to close");
    expect(seen).toContain(false);
    await m.unmount();
  });
});
