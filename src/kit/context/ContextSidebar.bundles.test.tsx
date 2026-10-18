// Bundles in the sidebar: one row named by its title, with its type's icon and
// nothing inside it; "New <type>" beside New document and New folder, arriving
// in rename mode; and Duplicate on a bundle's or a document's menu. What the
// daemon does with each act is in `workspace/bundles*.test.ts`.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { type BundleType, registerBundleType, unregisterBundleType } from "../lib/bundles.ts";
import {
  cleanup,
  installDom,
  mount,
  removeDom,
  settle,
  typeInto,
  waitFor,
} from "../lib/testDom.ts";
import type { ContextEntry, StructureOp } from "../workspace/protocol";
import { ContextSidebar, type ContextSidebarProps } from "./ContextSidebar.tsx";
import { trashDialog } from "./trashDialog.ts";

const BOARD: BundleType = {
  extension: ".boardbundle",
  type: "board",
  main: "board.board",
  format: "json",
  label: "board",
  mainTemplate: "{}\n",
  icon: <svg data-testid="board-icon" />,
};

beforeAll(() => {
  installDom();
  registerBundleType(BOARD);
});
afterEach(cleanup);
afterAll(async () => {
  unregisterBundleType(BOARD.extension);
  await removeDom();
});

const WS = "/w/projects";
const set: ContextEntry = {
  id: "c-set",
  label: "world",
  root: "/w/world",
  membership: "mirrored",
  nodes: [
    { kind: "doc", rel: "a.md" },
    {
      kind: "bundle",
      rel: "the-well.boardbundle",
      type: "board",
      main: "board.board",
      title: "The well",
    },
    { kind: "bundle", rel: "Plain.boardbundle", type: "board", main: "board.board" },
  ],
};
const loose: ContextEntry = {
  id: "c-loose",
  label: "Sketch.boardbundle",
  root: WS,
  membership: "listed",
  nodes: [
    {
      kind: "bundle",
      rel: "Sketch.boardbundle",
      type: "board",
      main: "board.board",
      title: "A sketch",
    },
  ],
};

function harness(over: Partial<ContextSidebarProps> = {}) {
  const calls = { opened: [] as Array<[string, string]>, structure: [] as StructureOp[] };
  const props: ContextSidebarProps = {
    entries: [loose, set],
    activeDoc: null,
    userHome: "/w",
    onOpenDoc: (e, rel) => calls.opened.push([e.id, rel]),
    onAddPath: () => {},
    onStructure: (op) => calls.structure.push(op),
    onRemoveEntry: () => {},
    onReveal: () => {},
    onPick: () => {},
    listDir: async () => ({ entries: [] }),
    workspace: WS,
    onSetWorkspace: () => {},
    ...over,
  };
  return { calls, props };
}

const mountSidebar = (node: ReactNode) =>
  mount(<div style={{ width: 300, height: 600, display: "flex" }}>{node}</div>);
const byLabel = (l: string) => document.querySelector(`[aria-label="${l}"]`);
const buttonWith = (text: string) =>
  [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(text)) ??
  null;
const treeItems = () => [...document.querySelectorAll('[role="treeitem"]')];
const treeItem = (text: string) =>
  treeItems().find((e) => (e.textContent ?? "").includes(text)) ?? null;
const click = async (el: Element | null) => {
  if (!el) throw new Error("nothing to click");
  await settle(() => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};
const rightClick = async (el: Element | null) => {
  if (!el) throw new Error("nothing to right-click");
  await settle(() => {
    el.dispatchEvent(
      new window.MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 9,
        clientY: 9,
      }),
    );
  });
};
const menuItems = () =>
  [...document.querySelectorAll('[data-slot^="context-menu-"][role^="menuitem"]')].map((e) =>
    (e.textContent ?? "").trim(),
  );
const menuItem = (text: string) =>
  [...document.querySelectorAll('[role^="menuitem"]')].find((e) =>
    (e.textContent ?? "").includes(text),
  ) ?? null;

describe("one row", () => {
  test("in a set: named by its title, or its folder without the extension, with its type's icon", async () => {
    const { props } = harness();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await click(buttonWith("world"));
    const names = treeItems().map((e) => (e.textContent ?? "").trim());
    expect(names).toEqual(["a.md", "Plain", "The well"]);
    const well = treeItem("The well");
    expect(well?.querySelector('[data-testid="board-icon"]')).not.toBeNull();
    expect(well?.querySelector('[data-format="bundle"]')?.getAttribute("data-bundle")).toBe(
      "board",
    );
    // A bundle is no folder: nothing to expand.
    expect(well?.getAttribute("aria-expanded")).toBeNull();
    await m.unmount();
  });

  test("a click opens the bundle; its row is marked while its main file is open", async () => {
    const { props, calls } = harness({
      activeDoc: { entryId: "c-set", rel: "the-well.boardbundle/board.board" },
    });
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await click(buttonWith("world"));
    expect(treeItem("The well")?.getAttribute("data-active")).toBe("true");
    await click(treeItem("Plain"));
    expect(calls.opened).toEqual([["c-set", "Plain.boardbundle"]]);
    await m.unmount();
  });

  test("listed by itself: its title, its icon, and marked while open", async () => {
    const { props, calls } = harness({
      activeDoc: { entryId: "c-loose", rel: "Sketch.boardbundle/board.board" },
    });
    const m = await mountSidebar(<ContextSidebar {...props} />);
    const row = buttonWith("A sketch");
    expect(row?.querySelector('[data-testid="board-icon"]')).not.toBeNull();
    expect(row?.className).toContain("bg-selected");
    await click(row);
    expect(calls.opened).toEqual([["c-loose", "Sketch.boardbundle"]]);
    await m.unmount();
  });
});

describe("New board", () => {
  test("sits beside New document and New set in the workspace row, and in a set's header", async () => {
    const { props, calls } = harness();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    const newBoard = byLabel("New board");
    // After New set, among the other registered types' (one process holds
    // every test file's registrations).
    const row = [...(newBoard?.parentElement?.children ?? [])].map((b) =>
      b.getAttribute("aria-label"),
    );
    expect(row.indexOf("New board")).toBeGreaterThan(row.indexOf("New set"));
    expect(row.indexOf("New set")).toBeGreaterThan(row.indexOf("New document"));
    await click(newBoard);
    await click(buttonWith("world"));
    await click(byLabel("New board in this set"));
    expect(calls.structure).toEqual([
      { op: "bundle.create", dir: WS, extension: ".boardbundle" },
      { op: "bundle.create", dir: "/w/world", extension: ".boardbundle" },
    ]);
    await m.unmount();
  });

  test("a new one arrives in rename mode, its whole title selected; the name typed is sent as it is", async () => {
    const made: ContextEntry = {
      ...loose,
      id: "c-made",
      nodes: [
        {
          kind: "bundle",
          rel: "Untitled.boardbundle",
          type: "board",
          main: "board.board",
          title: "Untitled",
        },
      ],
    };
    const { props, calls } = harness({
      entries: [made],
      created: { path: `${WS}/Untitled.boardbundle`, seq: 1 },
    });
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await waitFor(() => !!byLabel("Rename Untitled"), "the rename box");
    const box = byLabel("Rename Untitled") as HTMLInputElement;
    await typeInto(box, "Touchstones");
    await settle(() => {
      box.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(calls.structure).toEqual([
      { op: "rename", path: `${WS}/Untitled.boardbundle`, name: "Touchstones" },
    ]);
    await m.unmount();
  });

  test("a new one in a set arrives in the tree's rename mode", async () => {
    const { props } = harness({ created: { path: "/w/world/Plain.boardbundle", seq: 1 } });
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await waitFor(() => !!byLabel("Rename Plain"), "the tree's rename box");
    await m.unmount();
  });

  test("a folder's menu offers it too", async () => {
    const { props, calls } = harness();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await click(buttonWith("world"));
    await rightClick(document.querySelector('[role="tree"]'));
    expect(menuItems()).toContain("New board");
    await click(menuItem("New board"));
    expect(calls.structure).toEqual([
      { op: "bundle.create", dir: "/w/world", extension: ".boardbundle" },
    ]);
    await m.unmount();
  });
});

describe("a bundle's menu", () => {
  test("Open, Rename, Duplicate and Move to, and Duplicate sends a copy of the whole bundle", async () => {
    const { props, calls } = harness({
      onTrash: () => {},
      trashPreview: async () => ({}) as never,
    });
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await click(buttonWith("world"));
    await rightClick(treeItem("The well"));
    const items = menuItems();
    for (const want of ["Open", "Rename", "Duplicate", "Move to…", "Move to Trash…"])
      expect(items.some((i) => i.startsWith(want))).toBe(true);
    expect(items).not.toContain("New board");
    await click(menuItem("Duplicate"));
    expect(calls.structure).toEqual([{ op: "duplicate", path: "/w/world/the-well.boardbundle" }]);
    await m.unmount();
  });

  test("a folder's menu offers no Duplicate", async () => {
    const withFolder: ContextEntry = {
      ...set,
      nodes: [...set.nodes, { kind: "group", rel: "places", children: [] }],
    };
    const { props, calls } = harness({ entries: [withFolder] });
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await click(buttonWith("world"));
    await rightClick(treeItem("places"));
    expect(menuItems().some((i) => i.startsWith("Rename"))).toBe(true);
    expect(menuItem("Duplicate")).toBeNull();
    expect(calls.structure).toEqual([]);
    await m.unmount();
  });

  test("a document's menu offers Duplicate too", async () => {
    const { props, calls } = harness();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await click(buttonWith("world"));
    await rightClick(treeItem("a.md"));
    await click(menuItem("Duplicate"));
    expect(calls.structure).toEqual([{ op: "duplicate", path: "/w/world/a.md" }]);
    await m.unmount();
  });

  test("the Trash dialog names it as one item, by its title", () => {
    const d = trashDialog({
      path: "/w/world/the-well.boardbundle",
      shown: "world/the-well.boardbundle",
      dir: true,
      files: 4,
      folders: 1,
      docs: [{ slug: "the-well", name: "board.board", unsaved: true, versions: 1, open: true }],
      bundle: { label: "board", name: "The well" },
    });
    expect(d.title).toBe("Move The well to the Trash?");
    expect(d.message).toBe(
      "The board The well goes to the Trash whole, with everything it holds. You can put it back from the Trash.",
    );
    expect(d.warning).toBe(
      "The well has unsaved edits: they stay in this session, not in the file. The well is open, and closes.",
    );
  });
});
