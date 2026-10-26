// A folder link in a set's tree (`link` on a group: shown, never entered):
// its row says it is a link and where it leads, never opens like an empty
// folder, makes nothing, offers "Open as its own set", and a drop on it is
// answered with that route rather than sent. And a document made in a set
// inside another (the linked folder opened as its own set) arrives in rename
// mode in that inner set, whichever set the context lists first.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { cleanup, installDom, mount, removeDom, settle, waitFor } from "../lib/testDom.ts";
import type { ContextEntry, StructureOp } from "../workspace/protocol";
import { ContextSidebar, type ContextSidebarProps } from "./ContextSidebar.tsx";
import { innermostSet, moveTargets } from "./model.ts";

beforeAll(installDom);
afterEach(cleanup);
afterAll(async () => {
  await removeDom();
});

const world: ContextEntry = {
  id: "c-world",
  label: "world",
  root: "/w/world",
  membership: "mirrored",
  nodes: [
    { kind: "group", rel: "linkdir", children: [], link: true, linkTo: "/w/outside" },
    { kind: "group", rel: "real", children: [{ kind: "doc", rel: "real/inner.md" }] },
  ],
};
const linkSet: ContextEntry = {
  id: "c-link",
  label: "linkdir",
  root: "/w/world/linkdir",
  membership: "mirrored",
  nodes: [{ kind: "doc", rel: "theirs.md" }],
};

function harness(over: Partial<ContextSidebarProps> = {}) {
  const added: string[] = [];
  const structure: StructureOp[] = [];
  const props: ContextSidebarProps = {
    entries: [world],
    activeDoc: null,
    userHome: "/w",
    onOpenDoc: () => {},
    onAddPath: (p) => added.push(p),
    onStructure: (op) => structure.push(op),
    onRemoveEntry: () => {},
    onReveal: () => {},
    onPick: () => {},
    listDir: async () => ({ entries: [] }),
    trashPreview: async (path) => ({
      path,
      shown: path,
      dir: false,
      files: 1,
      folders: 0,
      docs: [],
    }),
    onTrash: () => {},
    ...over,
  };
  return { added, structure, props };
}

/** The sidebar in its column; re-rendered in the same one, so its state is kept. */
const inColumn = (node: ReactNode) => (
  <div style={{ width: 300, height: 600, display: "flex" }}>{node}</div>
);
const mountSidebar = (node: ReactNode) => mount(inColumn(node));
const buttonWith = (text: string, within: ParentNode = document.body) =>
  [...within.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(text)) ?? null;
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
      new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 9 }),
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
const treeRow = (name: string) =>
  [...document.querySelectorAll('[role="treeitem"]')].find((e) =>
    (e.textContent ?? "").includes(name),
  ) ?? null;
const dialog = () => document.querySelector("[data-slot=confirm-dialog]");
async function drillIn(label = "world") {
  await click(buttonWith(label));
  await waitFor(() => treeRow("real") !== null || treeRow("theirs.md") !== null, "the tree");
}
async function dragEvent(type: string, target: Element, dt: object) {
  await settle(() => {
    const ev = new window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "dataTransfer", { value: dt });
    target.dispatchEvent(ev);
  });
}
const files = () => ({
  types: ["Files"],
  files: [new File(["# S\n"], "scene.md")],
  items: [{ webkitGetAsEntry: () => ({ isDirectory: false }) }],
  getData: () => "",
});

describe("a link's row", () => {
  test("is marked a link, says where it leads, and has no chevron to open", async () => {
    const { props } = harness();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await drillIn();
    const row = treeRow("linkdir") as HTMLElement;
    expect(row.dataset.link).toBe("true");
    expect(row.title).toBe("A link to ~/outside: right-click to open it as its own set");
    expect(row.querySelector("[data-slot=link-icon]")).not.toBeNull();
    expect(row.getAttribute("aria-expanded")).toBeNull();
    // A plain click opens nothing and expands nothing.
    await click(row);
    expect(row.getAttribute("aria-expanded")).toBeNull();
    expect(treeRow("real")?.querySelector("[data-slot=link-icon]")).toBeNull();
    await m.unmount();
  });

  test("its accessible name says it is a link, and where it leads, in the ~ form", async () => {
    const { props } = harness();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await drillIn();
    expect(treeRow("linkdir")?.getAttribute("aria-label")).toBe("linkdir, a link to ~/outside");
    // A real folder keeps the library's own name.
    expect(treeRow("real")?.getAttribute("aria-label")).toBe("real");
    await m.unmount();
  });

  test("a row dragged onto it in the tree is not moved: the dialog offers it as its own set", async () => {
    const withDoc: ContextEntry = {
      ...world,
      nodes: [...world.nodes, { kind: "doc", rel: "a.md" }],
    };
    const { props, structure, added } = harness({ entries: [withDoc] });
    const moves: [string, string][] = [];
    const m = await mountSidebar(
      <ContextSidebar
        {...props}
        onStructure={(op) => {
          if (op.op === "move") moves.push([op.path, op.into]);
          structure.push(op);
        }}
      />,
    );
    await drillIn();
    const store: Record<string, string> = {};
    const dt = {
      types: [] as string[],
      setData: (f: string, d: string) => {
        store[f] = d;
        dt.types.push(f);
      },
      getData: (f: string) => store[f] ?? "",
      setDragImage: () => {},
      dropEffect: "move",
      effectAllowed: "all",
      files: [],
      items: [],
    };
    await dragEvent("dragstart", treeRow("a.md") as Element, dt);
    await dragEvent("dragover", treeRow("linkdir") as Element, dt);
    await dragEvent("drop", treeRow("linkdir") as Element, dt);
    await waitFor(() => dialog() !== null, "the dialog");
    expect(dialog()?.textContent).toContain("linkdir is a link to ~/outside");
    await settle(() => {});
    expect(moves).toEqual([]);
    expect(structure).toEqual([]);
    await click(buttonWith("Open as its own set", dialog() as ParentNode));
    expect(added).toEqual(["/w/world/linkdir"]);
    await m.unmount();
  });

  test("its menu makes nothing, keeps what acts on the link, and opens it as its own set", async () => {
    const { props, added } = harness();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await drillIn();
    await rightClick(treeRow("linkdir"));
    await waitFor(() => menuItems().length > 0, "the link's menu");
    const items = menuItems();
    expect(items).not.toContain("New document");
    expect(items).not.toContain("New folder");
    for (const kept of ["Open as its own set", "Move to…", "Move to Trash"])
      expect(items.some((i) => i.startsWith(kept))).toBe(true);
    expect(items.some((i) => i.startsWith("Rename"))).toBe(true);
    await click(menuItem("Open as its own set"));
    expect(added).toEqual(["/w/world/linkdir"]);
    // Once the daemon's state shows the new set, it is the one drilled into.
    await m.render(inColumn(<ContextSidebar {...props} entries={[world, linkSet]} />));
    await waitFor(() => treeRow("theirs.md") !== null, "the link's own set");
    await m.unmount();
  });

  test("a real folder's menu still makes things, and offers no set of its own", async () => {
    const { props } = harness();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await drillIn();
    await rightClick(treeRow("real"));
    await waitFor(() => menuItems().length > 0, "the folder's menu");
    expect(menuItems()).toContain("New document");
    expect(menuItems()).not.toContain("Open as its own set");
    await m.unmount();
  });

  test("files dropped on it import nothing: a dialog offers it as its own set", async () => {
    const { props, structure, added } = harness();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await drillIn();
    const row = treeRow("linkdir") as Element;
    const dt = files();
    await dragEvent("dragover", row, dt);
    await dragEvent("drop", row, dt);
    await waitFor(() => dialog() !== null, "the dialog");
    expect(dialog()?.textContent).toContain("linkdir is a link to ~/outside");
    await settle(() => {});
    expect(structure).toEqual([]);
    await click(buttonWith("Open as its own set", dialog() as ParentNode));
    expect(added).toEqual(["/w/world/linkdir"]);
    await m.unmount();
  });

  test("is no place offered by Move to…", () => {
    const places = moveTargets([world], "/w/world/real/inner.md").map((t) => t.path);
    expect(places).toContain("/w/world");
    expect(places).not.toContain("/w/world/linkdir");
  });
});

describe.each([
  ["the holding set first", [world, linkSet]],
  ["the link's set first", [linkSet, world]],
] as const)("a document made in the link's own set, with %s", (_, entries) => {
  test("the innermost set is the one that holds it", () => {
    expect(innermostSet(entries, "/w/world/linkdir/Untitled.md")?.id).toBe("c-link");
    expect(innermostSet(entries, "/w/world/real/x.md")?.id).toBe("c-world");
  });

  test("arrives in rename mode in that set", async () => {
    const { props } = harness({ entries: [...entries] });
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await drillIn("linkdir");
    const made: ContextEntry = {
      ...linkSet,
      nodes: [...linkSet.nodes, { kind: "doc", rel: "Untitled.md" }],
    };
    const next = entries.map((e) => (e.id === "c-link" ? made : e));
    await m.render(
      inColumn(
        <ContextSidebar
          {...props}
          entries={next}
          created={{ path: "/w/world/linkdir/Untitled.md", seq: 1 }}
        />,
      ),
    );
    await waitFor(
      () => !!document.querySelector('input[aria-label="Rename Untitled.md"]'),
      "the rename box",
    );
    expect(treeRow("theirs.md")).not.toBeNull();
    await m.unmount();
  });
});
