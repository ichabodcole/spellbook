// An expandable bundle in the sidebar: its row keeps opening the bundle,
// a chevron and "Show contents" / "Hide contents" show its real files under
// it, the convention's files are dimmed, the main file's own row opens it
// (raw: the shell's affair), the type's own files open nothing and take no
// structure acts, and its warnings show as a count. A bundle of a type that
// does not expand keeps no chevron. What the daemon does with each act is in
// `workspace/bundles.expand*.test.ts`.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { type BundleType, registerBundleType, unregisterBundleType } from "../lib/bundles.ts";
import { cleanup, installDom, mount, removeDom, settle, waitFor } from "../lib/testDom.ts";
import type { ContextEntry, StructureOp } from "../workspace/protocol";
import { ContextSidebar, type ContextSidebarProps } from "./ContextSidebar.tsx";
import { dropDirOf, isOwnTarget } from "./EntryTree.tsx";
import { moveTargets } from "./model.ts";

const SHELF: BundleType = {
  extension: ".shelfbundle",
  type: "shelf",
  main: "shelf.json",
  format: "json",
  label: "shelf",
  mainTemplate: "{}\n",
  expand: { members: ["docs"] },
};
const BOARD: BundleType = {
  extension: ".boardbundle",
  type: "board",
  main: "board.board",
  format: "json",
  label: "board",
  mainTemplate: "{}\n",
};

beforeAll(() => {
  installDom();
  registerBundleType(SHELF);
  registerBundleType(BOARD);
});
afterEach(cleanup);
afterAll(async () => {
  unregisterBundleType(SHELF.extension);
  unregisterBundleType(BOARD.extension);
  await removeDom();
});

const R = "lighthouse.shelfbundle";
const ROOT = "/w/world";
const set: ContextEntry = {
  id: "c-set",
  label: "world",
  root: ROOT,
  membership: "mirrored",
  nodes: [
    { kind: "doc", rel: "a.md" },
    { kind: "bundle", rel: "the-well.boardbundle", type: "board", main: "board.board" },
    {
      kind: "bundle",
      rel: R,
      type: "shelf",
      main: "shelf.json",
      title: "The lighthouse",
      warnings: [
        { message: "02-the-keeper.md is in the order but not in docs/" },
        { message: "audio/old/ belongs to no document" },
      ],
      contents: [
        {
          kind: "group",
          rel: `${R}/audio`,
          children: [{ kind: "file", rel: `${R}/audio/take.mp3`, size: 3_984_588 }],
        },
        {
          kind: "group",
          rel: `${R}/docs`,
          children: [{ kind: "doc", rel: `${R}/docs/01-arrival.md` }],
        },
        { kind: "file", rel: `${R}/info.json`, size: 60, convention: true },
        { kind: "file", rel: `${R}/shelf.json`, size: 90, convention: true },
      ],
    },
  ],
};

function harness(over: Partial<ContextSidebarProps> = {}) {
  const calls = { opened: [] as string[], structure: [] as StructureOp[] };
  const props: ContextSidebarProps = {
    entries: [set],
    activeDoc: null,
    userHome: "/w",
    onOpenDoc: (_e, rel) => calls.opened.push(rel),
    onAddPath: () => {},
    onStructure: (op) => calls.structure.push(op),
    onRemoveEntry: () => {},
    onReveal: () => {},
    onPick: () => {},
    listDir: async () => ({ entries: [] }),
    trashPreview: async () => {
      throw new Error("not in this test");
    },
    onTrash: () => {},
    ...over,
  };
  return { calls, props };
}

const framed = (node: ReactNode) => (
  <div style={{ width: 300, height: 600, display: "flex" }}>{node}</div>
);
const mountSidebar = (node: ReactNode) => mount(framed(node));
const buttonWith = (text: string) =>
  [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(text)) ??
  null;
const treeItems = () => [...document.querySelectorAll('[role="treeitem"]')];
const names = () => treeItems().map((e) => (e.textContent ?? "").trim());
const treeItem = (text: string) =>
  treeItems().find((e) => (e.textContent ?? "").trim().startsWith(text)) ?? null;
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
const closeMenu = async () => {
  await settle(() => {
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
};
const chevronOf = (row: Element | null) =>
  row?.querySelector('[data-slot="bundle-chevron"]') ?? null;

describe("the row", () => {
  test("an expandable bundle has a chevron; one that does not expand has none", async () => {
    const { props } = harness();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await click(buttonWith("world"));
    expect(chevronOf(treeItem("The lighthouse"))).not.toBeNull();
    expect(chevronOf(treeItem("the-well"))).toBeNull();
    expect(treeItem("The lighthouse")?.getAttribute("aria-expanded")).toBe("false");
    expect(treeItem("the-well")?.getAttribute("aria-expanded")).toBeNull();
    m.unmount();
  });

  test("clicking the row opens the bundle and does not expand it", async () => {
    const { calls, props } = harness();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await click(buttonWith("world"));
    await click(treeItem("The lighthouse"));
    expect(calls.opened).toEqual([R]);
    expect(names()).toEqual(["a.md", "The lighthouse2, 2 warnings", "the-well"]);
    m.unmount();
  });

  test("the chevron shows the real files, and shuts them again; it opens nothing", async () => {
    const { calls, props } = harness();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await click(buttonWith("world"));
    await click(chevronOf(treeItem("The lighthouse")));
    expect(calls.opened).toEqual([]);
    expect(treeItem("The lighthouse")?.getAttribute("aria-expanded")).toBe("true");
    // Folders first, then files: `audio/` and `docs/` shut, the convention's files dimmed.
    expect(names()).toEqual([
      "a.md",
      "The lighthouse2, 2 warnings",
      "audio",
      "docs",
      "info.json60 B",
      "shelf.json90 B",
      "the-well",
    ]);
    const dimmed = treeItems()
      .filter((e) => e.getAttribute("data-convention") === "true")
      .map((e) => (e.textContent ?? "").replace(/\d+ B$/, ""));
    expect(dimmed).toEqual(["info.json", "shelf.json"]);
    await click(treeItem("docs"));
    await click(treeItem("audio"));
    expect(names()).toContain("01-arrival.md");
    expect(names()).toContain("take.mp33.8 MB");
    await click(chevronOf(treeItem("The lighthouse")));
    expect(names()).toEqual(["a.md", "The lighthouse2, 2 warnings", "the-well"]);
    m.unmount();
  });

  test("Show contents and Hide contents on the row's menu", async () => {
    const { props } = harness();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await click(buttonWith("world"));
    await rightClick(treeItem("The lighthouse"));
    expect(menuItems()).toContain("Show contents");
    await click(menuItem("Show contents"));
    expect(names()).toContain("docs");
    await rightClick(treeItem("The lighthouse"));
    expect(menuItems()).toContain("Hide contents");
    await click(menuItem("Hide contents"));
    expect(names()).not.toContain("docs");
    // A bundle that does not expand offers neither.
    await rightClick(treeItem("the-well"));
    expect(menuItems().some((i) => i.includes("contents"))).toBe(false);
    await closeMenu();
    m.unmount();
  });

  test("expansion is remembered per bundle while the set is shown, as a folder's is", async () => {
    const { props } = harness();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await click(buttonWith("world"));
    await click(chevronOf(treeItem("The lighthouse")));
    await click(treeItem("docs"));
    // A new snapshot of the same set (a file came) keeps it open.
    const next = {
      ...set,
      nodes: set.nodes.map((n) =>
        n.kind === "bundle" && n.contents
          ? {
              ...n,
              contents: n.contents.map((c) =>
                c.kind === "group" && c.rel === `${R}/docs`
                  ? {
                      ...c,
                      children: [
                        ...c.children,
                        { kind: "doc" as const, rel: `${R}/docs/02-the-keeper.md` },
                      ],
                    }
                  : c,
              ),
            }
          : n,
      ),
    };
    await m.render(framed(<ContextSidebar {...props} entries={[next]} />));
    expect(names()).toContain("02-the-keeper.md");
    expect(names()).toContain("01-arrival.md");
    m.unmount();
  });

  test("the warnings show as a count on the row, the messages in its tooltip", async () => {
    const { props } = harness();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await click(buttonWith("world"));
    const mark = treeItem("The lighthouse")?.querySelector('[data-slot="bundle-warnings"]');
    expect(mark?.textContent).toContain("2");
    expect(mark?.getAttribute("title")).toContain("02-the-keeper.md is in the order");
    expect(treeItem("the-well")?.querySelector('[data-slot="bundle-warnings"]')).toBeNull();
    m.unmount();
  });
});

describe("the rows inside", () => {
  const expanded = async () => {
    const h = harness();
    const m = await mountSidebar(<ContextSidebar {...h.props} />);
    await click(buttonWith("world"));
    await click(chevronOf(treeItem("The lighthouse")));
    await click(treeItem("docs"));
    await click(treeItem("audio"));
    return { ...h, m };
  };

  test("a member's document opens as any document does", async () => {
    const { calls, m } = await expanded();
    await click(treeItem("01-arrival.md"));
    expect(calls.opened).toEqual([`${R}/docs/01-arrival.md`]);
    m.unmount();
  });

  test("the main file's own row opens it; info.json and a render open nothing", async () => {
    const { calls, m } = await expanded();
    await click(treeItem("shelf.json"));
    await click(treeItem("info.json"));
    await click(treeItem("take.mp3"));
    expect(calls.opened).toEqual([`${R}/shelf.json`]);
    m.unmount();
  });

  test("the main file opened from its own row marks that row, not the bundle's", async () => {
    const { props } = harness({
      activeDoc: { entryId: "c-set", rel: `${R}/shelf.json`, raw: true },
    });
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await click(buttonWith("world"));
    const active = treeItems().filter((e) => e.getAttribute("data-active") === "true");
    expect(active.map((e) => (e.textContent ?? "").replace(/\d+ B$/, ""))).toEqual(["shelf.json"]);
    m.unmount();
  });

  test("opened as the bundle, the bundle's row is marked", async () => {
    const { props } = harness({ activeDoc: { entryId: "c-set", rel: `${R}/shelf.json` } });
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await click(buttonWith("world"));
    const active = treeItems().filter((e) => e.getAttribute("data-active") === "true");
    expect(active.map((e) => e.textContent)).toEqual(["The lighthouse2, 2 warnings"]);
    m.unmount();
  });

  test("the member folder takes a new document; it is not renamed, moved or deleted", async () => {
    const { calls, m } = await expanded();
    await rightClick(treeItem("docs"));
    const items = menuItems();
    expect(items).toContain("New document");
    expect(items).toContain("New folder");
    expect(items.some((i) => i.startsWith("New shelf") || i.startsWith("New board"))).toBe(false);
    expect(items.some((i) => i.startsWith("Rename"))).toBe(false);
    expect(items.some((i) => i.startsWith("Move to"))).toBe(false);
    expect(items.some((i) => i.startsWith("Move to Trash"))).toBe(false);
    await click(menuItem("New document"));
    expect(calls.structure).toEqual([{ op: "doc.create", dir: `${ROOT}/${R}/docs` }]);
    m.unmount();
  });

  test("a member's document is renamed, moved, duplicated and deleted like any", async () => {
    const { m } = await expanded();
    await rightClick(treeItem("01-arrival.md"));
    const items = menuItems();
    for (const want of ["Open", "Rename", "Duplicate", "Move to…", "Move to Trash"])
      expect(items.some((i) => i.startsWith(want))).toBe(true);
    await closeMenu();
    m.unmount();
  });

  test("the type's own files and folders take no act and make nothing", async () => {
    const { m } = await expanded();
    for (const row of ["audio", "take.mp3", "info.json"]) {
      await rightClick(treeItem(row));
      const items = menuItems();
      for (const no of ["New document", "New folder", "Rename", "Duplicate", "Move to"])
        expect(items.some((i) => i.startsWith(no))).toBe(false);
      expect(items.some((i) => i.startsWith("Reveal") || i.startsWith("Show in"))).toBe(true);
      await closeMenu();
    }
    await rightClick(treeItem("shelf.json"));
    expect(menuItems().some((i) => i.startsWith("Open"))).toBe(true);
    expect(menuItems().some((i) => i.startsWith("Rename"))).toBe(false);
    await closeMenu();
    m.unmount();
  });

  test("Move to offers a member folder, never the type's own", () => {
    const targets = moveTargets([set], `${ROOT}/a.md`, null).map((t) => t.label);
    expect(targets).toContain("world/The lighthouse/docs");
    expect(targets.some((t) => t.includes("audio"))).toBe(false);
  });
});

describe("drops and app actions inside", () => {
  const node = (rel: string) => {
    const find = (
      list: readonly ContextEntry["nodes"][number][],
    ): ContextEntry["nodes"][number] | undefined => {
      for (const n of list) {
        if (n.rel === rel) return n;
        const inner =
          n.kind === "group" ? n.children : n.kind === "bundle" ? (n.contents ?? []) : [];
        const hit = find(inner);
        if (hit) return hit;
      }
      return undefined;
    };
    const hit = find(set.nodes);
    if (!hit) throw new Error(`no node ${rel}`);
    return hit;
  };

  test("the type's own folders and files are no drop target; the member folder and the bundle row are", () => {
    expect(isOwnTarget(ROOT, node(`${R}/audio`))).toBe(true);
    expect(isOwnTarget(ROOT, node(`${R}/audio/take.mp3`))).toBe(true);
    expect(isOwnTarget(ROOT, node(`${R}/info.json`))).toBe(true);
    expect(isOwnTarget(ROOT, node(`${R}/shelf.json`))).toBe(true);
    expect(isOwnTarget(ROOT, node(`${R}/docs`))).toBe(false);
    expect(isOwnTarget(ROOT, node(`${R}/docs/01-arrival.md`))).toBe(false);
    expect(isOwnTarget(ROOT, node(R))).toBe(false);
    expect(isOwnTarget(ROOT, node("a.md"))).toBe(false);
  });

  test("an app's folder actions are offered on the member folder, never on the type's own", async () => {
    const asked: string[] = [];
    const { props } = harness({
      appActionsFor: (t) => {
        asked.push(`${t.kind}:${t.path}`);
        return t.kind === "group"
          ? [{ id: "map", label: "Map of this folder", onSelect: () => {} }]
          : [];
      },
    });
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await click(buttonWith("world"));
    await click(chevronOf(treeItem("The lighthouse")));
    await rightClick(treeItem("audio"));
    expect(menuItems()).not.toContain("Map of this folder");
    await closeMenu();
    await rightClick(treeItem("docs"));
    expect(menuItems()).toContain("Map of this folder");
    await closeMenu();
    expect(asked.some((a) => a.endsWith("/audio"))).toBe(false);
    m.unmount();
  });

  test("a bundle read only in part says so on its row", async () => {
    const partial: ContextEntry = {
      ...set,
      nodes: set.nodes.map((n) =>
        n.kind === "bundle" && n.contents ? { ...n, truncated: true as const } : n,
      ),
    };
    const { props } = harness({ entries: [partial] });
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await click(buttonWith("world"));
    expect(
      treeItem("The lighthouse")?.querySelector('[data-slot="bundle-partial"]'),
    ).not.toBeNull();
    expect(treeItem("the-well")?.querySelector('[data-slot="bundle-partial"]')).toBeNull();
    m.unmount();
  });
});

describe("a drop on the bundle's own row", () => {
  // ⛔ A drop on an expandable bundle's row landed beside the bundle: a member
  // document dragged onto its own stage's row left the stage.
  test("goes into its member folder, so a member document dropped there stays put", () => {
    const shelf = set.nodes.find((n) => n.rel === R);
    if (!shelf) throw new Error("no shelf");
    expect(dropDirOf(ROOT, shelf)).toBe(`${ROOT}/${R}/docs`);
    const member = `${ROOT}/${R}/docs/01-arrival.md`;
    // The tree moves a row only when its folder is not the drop's.
    expect(member.slice(0, member.lastIndexOf("/"))).toBe(dropDirOf(ROOT, shelf));
  });

  test("a bundle that does not expand, a folder and a document keep their drops", () => {
    const well = set.nodes.find((n) => n.rel === "the-well.boardbundle");
    if (!well) throw new Error("no well");
    expect(dropDirOf(ROOT, well)).toBe(ROOT);
    expect(dropDirOf(ROOT, { kind: "group", rel: "part", children: [] })).toBe(`${ROOT}/part`);
    expect(dropDirOf(ROOT, { kind: "doc", rel: "part/b.md" })).toBe(`${ROOT}/part`);
  });
});

describe("a drop on the bundle's row, through the tree", () => {
  const dragEvent = async (type: string, target: Element, dt: object) => {
    await settle(() => {
      const ev = new window.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(ev, "dataTransfer", { value: dt });
      target.dispatchEvent(ev);
    });
  };
  const transfer = (name: string, text: string) => ({
    types: ["Files"],
    files: [new File([text], name)],
    items: [{ webkitGetAsEntry: () => ({ isDirectory: false }) }],
    getData: () => "",
  });

  // ⛔ The tree's own drop handling, not only `dropDirOf`: with the old rule
  // (a drop on a bundle's row lands in the bundle's parent) an outside
  // document dropped on a stage's row landed beside the stage.
  test("an outside document dropped on an expandable bundle's row lands in its docs/", async () => {
    const { calls, props } = harness({ workspace: "/w/projects" });
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await click(buttonWith("world"));
    const row = treeItem("The lighthouse") as Element;
    const dt = transfer("03-the-light.md", "# The light\n");
    await dragEvent("dragover", row, dt);
    await dragEvent("drop", row, dt);
    await waitFor(() => calls.structure.length > 0, "the import");
    expect(calls.structure).toEqual([
      { op: "import", name: "03-the-light.md", text: "# The light\n", dir: `${ROOT}/${R}/docs` },
    ]);
    m.unmount();
  });
});
