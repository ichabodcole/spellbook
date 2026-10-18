// The sidebar is props-only, so these tests drive it from fixtures: what it
// shows, what a click, a right-click, a drop and a typed path send out.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
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
import type { MenuAction, MenuTarget } from "./menuActions.ts";
import { type DraggedRow, encodeRowDrag, ROW_DRAG_MIME } from "./rowDrag.ts";

beforeAll(installDom);
afterEach(cleanup);
afterAll(removeDom);

const solo: ContextEntry = {
  id: "c-solo",
  label: "notes",
  root: "/w/notes",
  membership: "listed",
  nodes: [{ kind: "doc", rel: "memo.md" }],
};
const set: ContextEntry = {
  id: "c-set",
  label: "drafts",
  root: "/w/drafts",
  membership: "mirrored",
  nodes: [
    { kind: "doc", rel: "a.md" },
    { kind: "group", rel: "part", children: [{ kind: "doc", rel: "part/b.md" }] },
  ],
};

type Calls = {
  opened: Array<[string, string]>;
  structure: StructureOp[];
  added: string[];
  removed: string[];
  revealed: string[];
  picked: string[];
  targets: MenuTarget[];
  listed: string[];
};

function harness(over: Partial<ContextSidebarProps> = {}) {
  const calls: Calls = {
    opened: [],
    structure: [],
    added: [],
    removed: [],
    revealed: [],
    picked: [],
    targets: [],
    listed: [],
  };
  const props: ContextSidebarProps = {
    entries: [solo, set],
    activeDoc: null,
    userHome: "/w",
    onOpenDoc: (e, rel) => calls.opened.push([e.id, rel]),
    onAddPath: (p) => calls.added.push(p),
    onStructure: (op) => calls.structure.push(op),
    onRemoveEntry: (id) => calls.removed.push(id),
    onReveal: (p) => calls.revealed.push(p),
    onPick: (w) => calls.picked.push(w),
    listDir: async (path) => {
      calls.listed.push(path);
      return {
        entries: [
          { name: "alpha", path: `${path}/alpha`, dir: true },
          { name: "beta.md", path: `${path}/beta.md`, dir: false },
        ],
      };
    },
    appActionsFor: (target) => {
      calls.targets.push(target);
      return [{ id: "render", label: "Render this", onSelect: () => calls.picked.push("app") }];
    },
    ...over,
  };
  return { calls, props };
}

const root = () => document.body;
const buttonWith = (text: string, within: ParentNode = root()) =>
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
      new window.MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 12,
        clientY: 12,
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

/** The "Move to…" dialog's places, as they read. */
const options = () =>
  [...document.querySelectorAll('[data-slot="move-to-dialog"] [role="option"]')].map((e) =>
    (e.textContent ?? "").trim(),
  );
const option = (text: string) =>
  [...document.querySelectorAll('[data-slot="move-to-dialog"] [role="option"]')].find(
    (e) => (e.textContent ?? "").trim() === text,
  ) ?? null;

async function drop(target: Element, dt: object) {
  await settle(() => {
    const ev = new window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "dataTransfer", { value: dt });
    target.dispatchEvent(ev);
  });
}
const file = (name: string, text: string, isDirectory = false) => ({
  file: new File([text], name),
  isDirectory,
});
function transfer(files: ReturnType<typeof file>[]) {
  return {
    types: ["Files"],
    files: files.map((f) => f.file),
    items: files.map((f) => ({ webkitGetAsEntry: () => ({ isDirectory: f.isDirectory }) })),
    getData: () => "",
  };
}

function mountSidebar(node: ReactNode) {
  return mount(<div style={{ width: 300, height: 600, display: "flex" }}>{node}</div>);
}

describe("what the list shows", () => {
  test("an empty context says what to do", async () => {
    const { props } = harness({ entries: [] });
    const m = await mountSidebar(<ContextSidebar {...props} />);
    expect(root().textContent).toContain("No context yet");
    await m.unmount();
  });

  test("a single document renders as that document, and a folder as a set with its count", async () => {
    const { props } = harness();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    const rows = [...document.querySelectorAll('ul[aria-label="Context"] li')];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("memo.md");
    expect(rows[1]?.textContent).toContain("drafts");
    const counts = rows[1]?.querySelector('[data-slot="set-counts"]');
    expect(counts?.querySelector(".sr-only")?.textContent).toBe("2 documents");
    expect(counts?.getAttribute("title")).toBe("2 documents");
    expect(counts?.textContent).toContain("2");
    // No images, so no image count.
    expect(counts?.querySelectorAll("svg")).toHaveLength(1);
    await m.unmount();
  });

  test("the per-document badge slot shows at the row's edge", async () => {
    const { props } = harness({
      badgeFor: (path) => (path === "/w/notes/memo.md" ? <b data-testid="badge">B</b> : null),
    });
    const m = await mountSidebar(<ContextSidebar {...props} />);
    expect(document.querySelectorAll('[data-testid="badge"]')).toHaveLength(1);
    expect(buttonWith("memo.md")?.querySelector('[data-testid="badge"]')).not.toBeNull();
    await m.unmount();
  });

  test("the folder badge slot shows on a set's row and its folders, never on a single document", async () => {
    const asked: string[] = [];
    const { props } = harness({
      folderBadgeFor: (path) => {
        asked.push(path);
        return <b data-testid="folder-badge">F</b>;
      },
    });
    const m = await mountSidebar(<ContextSidebar {...props} />);
    expect(document.querySelectorAll('[data-testid="folder-badge"]')).toHaveLength(1);
    expect(buttonWith("drafts")?.querySelector('[data-testid="folder-badge"]')).not.toBeNull();
    expect(buttonWith("memo.md")?.querySelector('[data-testid="folder-badge"]')).toBeNull();
    expect(asked).toEqual(["/w/drafts"]);
    await click(buttonWith("drafts"));
    const items = [...document.querySelectorAll('[role="treeitem"]')];
    const part = items.find((e) => e.textContent?.includes("part"));
    const doc = items.find((e) => e.textContent?.includes("a.md"));
    expect(part?.querySelector('[data-testid="folder-badge"]')).not.toBeNull();
    const header = document.querySelector('[aria-label="Back to the context list"]')?.parentElement;
    expect(header?.querySelector('[data-testid="folder-badge"]')).not.toBeNull();
    expect(doc?.querySelector('[data-testid="folder-badge"]')).toBeNull();
    expect(asked).toContain("/w/drafts/part");
    await m.unmount();
  });

  test("the open document's row is marked", async () => {
    const { props } = harness({ activeDoc: { entryId: "c-solo", rel: "memo.md" } });
    const m = await mountSidebar(<ContextSidebar {...props} />);
    expect(buttonWith("memo.md")?.className).toContain("bg-selected");
    await m.unmount();
  });
});

describe("opening, and drilling into a set", () => {
  test("a click on a single document opens it", async () => {
    const { props, calls } = harness();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await click(buttonWith("memo.md"));
    expect(calls.opened).toEqual([["c-solo", "memo.md"]]);
    await m.unmount();
  });

  test("a click on a set drills into its tree, and back returns to the list", async () => {
    const { props, calls } = harness({
      badgeFor: (p) => (p === "/w/drafts/a.md" ? "BADGE" : null),
    });
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await click(buttonWith("drafts"));
    const tree = document.querySelector('[role="tree"]');
    expect(tree).not.toBeNull();
    const items = [...document.querySelectorAll('[role="treeitem"]')].map((e) => e.textContent);
    expect(items[0]).toContain("part");
    expect(items.some((t) => t?.includes("a.md"))).toBe(true);
    // The badge slot reaches the tree's rows too.
    expect(items.find((t) => t?.includes("a.md"))).toContain("BADGE");
    await click(buttonWith("a.md", tree as ParentNode));
    expect(calls.opened).toEqual([["c-set", "a.md"]]);
    await click(document.querySelector('[aria-label="Back to the context list"]'));
    expect(document.querySelector('ul[aria-label="Context"]')).not.toBeNull();
    await m.unmount();
  });
});

describe("the open document's row is revealed when it changes", () => {
  const sidebar = (rel: string, over: Partial<ContextSidebarProps> = {}) => {
    const { props } = harness({ activeDoc: { entryId: "c-set", rel }, ...over });
    return <ContextSidebar {...props} />;
  };
  const row = (name: string) =>
    [...document.querySelectorAll('[role="treeitem"]')].find((e) =>
      (e.textContent ?? "").includes(name),
    ) ?? null;
  const expanded = (name: string) => row(name)?.getAttribute("aria-expanded");

  /** Mount with `a.md` open, drill into the set, and leave `part` shut. */
  async function drilledWithPartShut() {
    const m = await mountSidebar(sidebar("a.md"));
    await click(buttonWith("drafts"));
    await waitFor(() => row("a.md") !== null, "the tree");
    expect(expanded("part")).toBe("false");
    expect(row("b.md")).toBeNull();
    return m;
  }

  test("a document opened in a shut folder (a link, a search, the agent) opens the folder, row in view and marked", async () => {
    const scrolled: string[] = [];
    const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
    const before = proto.scrollIntoView;
    proto.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this.textContent ?? "");
    };
    try {
      const m = await drilledWithPartShut();
      await m.render(
        <div style={{ width: 300, height: 600, display: "flex" }}>{sidebar("part/b.md")}</div>,
      );
      await waitFor(() => row("b.md") !== null, "b.md's row");
      expect(expanded("part")).toBe("true");
      expect((row("b.md") as HTMLElement).dataset.active ?? "").toBe("true");
      await waitFor(() => scrolled.some((t) => t.includes("b.md")), "the row scrolled into view");
      await m.unmount();
    } finally {
      proto.scrollIntoView = before;
    }
  });

  test("a folder the human shuts afterwards stays shut, and nothing they had open is collapsed", async () => {
    const m = await drilledWithPartShut();
    const wrap = (n: ReactNode) => (
      <div style={{ width: 300, height: 600, display: "flex" }}>{n}</div>
    );
    await m.render(wrap(sidebar("part/b.md")));
    await waitFor(() => expanded("part") === "true", "part open");
    // The human shuts it again, while b.md is still the open document.
    await click(row("part"));
    expect(expanded("part")).toBe("false");
    // Another snapshot of the same open document (a re-render, a changed entry) keeps it shut.
    await m.render(wrap(sidebar("part/b.md")));
    await m.render(
      wrap(sidebar("part/b.md", { entries: [solo, { ...set, nodes: [...set.nodes] }] })),
    );
    expect(expanded("part")).toBe("false");
    // Opening a document at the top does not collapse anything either.
    await click(row("part"));
    expect(expanded("part")).toBe("true");
    await m.render(wrap(sidebar("a.md")));
    expect(expanded("part")).toBe("true");
    await m.unmount();
  });

  /** Record which rows were scrolled into view, for the length of `fn`. */
  async function recordingScrolls(fn: (scrolled: string[]) => Promise<void>) {
    const scrolled: string[] = [];
    const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
    const before = proto.scrollIntoView;
    proto.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this.textContent ?? "");
    };
    try {
      await fn(scrolled);
    } finally {
      proto.scrollIntoView = before;
    }
  }

  test("with the column shut to its rail, the scroll waits for the column to reopen, then happens once", async () => {
    await recordingScrolls(async (scrolled) => {
      // The shell keeps a shut column mounted but `hidden`: no layout to scroll in.
      const column = (hidden: boolean, rel: string) => (
        <div hidden={hidden} style={{ width: 300, height: 600, display: "flex" }}>
          {sidebar(rel)}
        </div>
      );
      const m = await drilledWithPartShut();
      await m.render(column(true, "a.md"));
      await m.render(column(true, "part/b.md"));
      await waitFor(() => expanded("part") === "true", "part opened on the rail");
      await new Promise((r) => setTimeout(r, 150));
      expect(scrolled.filter((t) => t.includes("b.md"))).toEqual([]);
      // Reopened: now it scrolls, once.
      await m.render(column(false, "part/b.md"));
      await waitFor(() => scrolled.some((t) => t.includes("b.md")), "the scroll after reopening");
      await new Promise((r) => setTimeout(r, 100));
      expect(scrolled.filter((t) => t.includes("b.md"))).toHaveLength(1);
      await m.unmount();
    });
  });
});

describe("the list drills into the set that holds a document opened elsewhere", () => {
  const other: ContextEntry = {
    id: "c-other",
    label: "others",
    root: "/w/others",
    membership: "mirrored",
    nodes: [{ kind: "doc", rel: "z.md" }],
  };
  const sidebar = (activeDoc: ContextSidebarProps["activeDoc"]) => {
    const { props } = harness({ entries: [solo, set, other], activeDoc });
    return (
      <div style={{ width: 300, height: 600, display: "flex" }}>
        <ContextSidebar {...props} />
      </div>
    );
  };
  const treeRows = () =>
    [...document.querySelectorAll('[role="treeitem"]')].map((e) => e.textContent ?? "");

  test("from the list a fresh load shows, a document opened by a link drills in and reveals its row", async () => {
    const m = await mount(sidebar({ entryId: "c-solo", rel: "memo.md" }));
    expect(document.querySelector('ul[aria-label="Context"]')).not.toBeNull();
    await m.render(sidebar({ entryId: "c-set", rel: "part/b.md" }));
    await waitFor(() => treeRows().some((t) => t.includes("b.md")), "drilled in, b.md shown");
    const part = [...document.querySelectorAll('[role="treeitem"]')].find((e) =>
      (e.textContent ?? "").includes("part"),
    );
    expect(part?.getAttribute("aria-expanded")).toBe("true");
    await m.unmount();
  });

  test("a set the human drilled into is never switched away from", async () => {
    const m = await mount(sidebar(null));
    await click(buttonWith("others"));
    await waitFor(() => treeRows().some((t) => t.includes("z.md")), "the other set");
    await m.render(sidebar({ entryId: "c-set", rel: "part/b.md" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(treeRows().some((t) => t.includes("z.md"))).toBe(true);
    expect(treeRows().some((t) => t.includes("b.md"))).toBe(false);
    await m.unmount();
  });

  test("a single document in the list stays in the list; it already shows there", async () => {
    const m = await mount(sidebar(null));
    await m.render(sidebar({ entryId: "c-solo", rel: "memo.md" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelector('ul[aria-label="Context"]')).not.toBeNull();
    await m.unmount();
  });
});

describe("right-click menus", () => {
  test("a listed document: Open, Rename, Reveal, the app's action, and Remove from context", async () => {
    const { props, calls } = harness();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await rightClick(buttonWith("memo.md"));
    await waitFor(() => menuItems().length > 0, "the menu");
    const items = menuItems();
    expect(items).toContain("Open");
    expect(items).toContain("Rename");
    expect(
      items.some((i) => i.includes("Reveal in Finder") || i.includes("Show in file manager")),
    ).toBe(true);
    expect(items).toContain("Render this");
    expect(items).toContain("Remove from context");
    // A listed document is not a place to put things, so there is nothing to make in it.
    expect(items).not.toContain("New document");
    // The app hears what was clicked.
    const target = calls.targets.at(-1) as MenuTarget;
    expect(target.kind).toBe("entry");
    expect(target.path).toBe("/w/notes/memo.md");
    expect(target.entry?.id).toBe("c-solo");
    await click(menuItem("Render this"));
    expect(calls.picked).toContain("app");
    await m.unmount();
  });

  test("Reveal and Remove send their ops, and Remove asks for nothing it cannot undo", async () => {
    const { props, calls } = harness();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await rightClick(buttonWith("memo.md"));
    await waitFor(() => menuItems().length > 0, "the menu");
    await click(menuItem("Remove from context"));
    expect(calls.removed).toEqual(["c-solo"]);
    await rightClick(buttonWith("memo.md"));
    await waitFor(() => menuItem("Reveal") !== null || menuItem("Show in file") !== null, "reveal");
    await click(menuItem("Reveal") ?? menuItem("Show in file"));
    expect(calls.revealed).toEqual(["/w/notes/memo.md"]);
    await m.unmount();
  });

  test("a set offers New document, New folder and Move to, and moves by the daemon's own op", async () => {
    const { props, calls } = harness();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await rightClick(buttonWith("drafts"));
    await waitFor(() => menuItems().length > 0, "the menu");
    expect(menuItems()).toContain("Open set");
    await click(menuItem("New document"));
    expect(calls.structure).toEqual([{ op: "doc.create", dir: "/w/drafts" }]);
    await rightClick(buttonWith("drafts"));
    await waitFor(() => menuItem("New folder") !== null, "the menu again");
    // It makes a folder in the set, not a set of its own.
    expect(menuItems()).not.toContain("New set");
    await click(menuItem("New folder"));
    expect(calls.structure.at(-1)).toEqual({ op: "folder.create", dir: "/w/drafts" });
    await m.unmount();
  });

  test("Move to… lists the workspace, then every set and folder, and sends a move", async () => {
    const { props, calls } = harness({ workspace: "/w/projects" });
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await rightClick(buttonWith("memo.md"));
    await waitFor(() => menuItem("Move to") !== null, "the menu");
    await click(menuItem("Move to"));
    await waitFor(() => options().length > 0, "the dialog");
    expect(document.querySelector('[data-slot="move-to-dialog"]')?.textContent).toContain(
      "Move memo.md to",
    );
    expect(options()).toEqual(["Workspace~/projects", "drafts", "drafts/part"]);
    await click(option("drafts"));
    expect(calls.structure).toEqual([{ op: "move", path: "/w/notes/memo.md", into: "/w/drafts" }]);
    await waitFor(() => options().length === 0, "the dialog to close");
    await m.unmount();
  });

  test("Move to… is the same inside a set: the workspace first, and a search across all", async () => {
    const { props, calls } = harness({ workspace: "/w/projects" });
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await click(buttonWith("drafts"));
    const treeRow = (name: string) =>
      [...document.querySelectorAll('[role="treeitem"]')].find((e) =>
        (e.textContent ?? "").includes(name),
      ) ?? null;
    // The folder holding b.md is shut: open it first.
    await click(treeRow("part"));
    await waitFor(() => treeRow("b.md") !== null, "the folder open");
    await rightClick(treeRow("b.md"));
    await waitFor(() => menuItem("Move to") !== null, "the menu");
    await click(menuItem("Move to"));
    await waitFor(() => options().length > 0, "the dialog");
    // Where it is (drafts/part) is not offered; the workspace is, first.
    expect(options()).toEqual(["Workspace~/projects", "drafts"]);
    const search = document.querySelector(
      '[aria-label="Search sets and folders"]',
    ) as HTMLInputElement;
    const key = (k: string) =>
      settle(() => {
        search.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true }));
      });
    // Nothing is chosen on opening: a reflex Enter moves nothing.
    expect(search.getAttribute("aria-activedescendant")).toBeNull();
    await key("Enter");
    expect(calls.structure).toEqual([]);
    await typeInto(search, "work");
    expect(options()).toEqual(["Workspace~/projects"]);
    await typeInto(search, "zzz");
    expect(document.body.textContent).toContain("No set or folder matches.");
    // With no list shown, the box says so: nothing expanded, nothing controlled.
    expect(search.getAttribute("aria-expanded")).toBe("false");
    expect(search.getAttribute("aria-controls")).toBeNull();
    await typeInto(search, "");
    expect(search.getAttribute("aria-expanded")).toBe("true");
    await key("Enter");
    expect(calls.structure).toEqual([]);
    await key("ArrowDown");
    await key("Enter");
    expect(calls.structure).toEqual([
      { op: "move", path: "/w/drafts/part/b.md", into: "/w/projects" },
    ]);
    await m.unmount();
  });

  test("Move to… on a whole set offers no workspace: only another set", async () => {
    const { props } = harness({
      workspace: "/w/projects",
      entries: [solo, set, { ...set, id: "c-other", label: "other", root: "/x/other", nodes: [] }],
    });
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await rightClick(buttonWith("drafts"));
    await waitFor(() => menuItem("Move to") !== null, "the menu");
    await click(menuItem("Move to"));
    await waitFor(() => options().length > 0, "the dialog");
    expect(options()).toEqual(["other"]);
    await m.unmount();
  });

  test("Move to… on the only set says there is nowhere else, not that nothing matches", async () => {
    const { props } = harness({ workspace: "/w/projects", entries: [set] });
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await rightClick(buttonWith("drafts"));
    await waitFor(() => menuItem("Move to") !== null, "the menu");
    await click(menuItem("Move to"));
    await waitFor(
      () => document.querySelector('[data-slot="move-to-dialog"]') !== null,
      "the dialog",
    );
    expect(document.body.textContent).toContain("There is no other set to move this into.");
    await m.unmount();
  });

  test("after Move to…, the moved row takes the focus where it now is", async () => {
    const { props } = harness({ workspace: "/w/projects" });
    const m = await mountSidebar(<ContextSidebar {...props} />);
    // Out of a set to the workspace: the list shows, and its row is focused.
    await click(buttonWith("drafts"));
    await rightClick(
      [...document.querySelectorAll('[role="treeitem"]')].find((e) =>
        (e.textContent ?? "").includes("a.md"),
      ) ?? null,
    );
    await click(menuItem("Move to"));
    await waitFor(() => options().length > 0, "the dialog");
    await click(option("Workspace~/projects"));
    const moved: ContextEntry = {
      id: "c-moved",
      label: "projects",
      root: "/w/projects",
      membership: "listed",
      nodes: [{ kind: "doc", rel: "a.md" }],
    };
    const after = [solo, { ...set, nodes: (set.nodes ?? []).slice(1) }, moved];
    await m.render(
      <div style={{ width: 300, height: 600, display: "flex" }}>
        <ContextSidebar {...props} entries={after} moved={{ path: "/w/projects/a.md", seq: 1 }} />
      </div>,
    );
    await waitFor(
      () => (document.activeElement as HTMLElement | null)?.dataset.rowPath === "/w/projects/a.md",
      "the moved row focused in the list",
    );
    // Into a folder of a set: the set opens to it, and its tree row is focused.
    await rightClick(buttonWith("memo.md"));
    await click(menuItem("Move to"));
    await waitFor(() => options().length > 0, "the dialog");
    await click(option("drafts/part"));
    const intoPart = [
      moved,
      {
        ...set,
        nodes: [
          {
            kind: "group" as const,
            rel: "part",
            children: [
              { kind: "doc" as const, rel: "part/b.md" },
              { kind: "doc" as const, rel: "part/memo.md" },
            ],
          },
        ],
      },
    ];
    await m.render(
      <div style={{ width: 300, height: 600, display: "flex" }}>
        <ContextSidebar
          {...props}
          entries={intoPart}
          moved={{ path: "/w/drafts/part/memo.md", seq: 2 }}
        />
      </div>,
    );
    await waitFor(
      () =>
        document.activeElement?.getAttribute("role") === "treeitem" &&
        (document.activeElement?.textContent ?? "").includes("memo.md"),
      "the moved row focused in the tree",
    );
    await m.unmount();
  });

  test("a refused Move to… moves no focus: the file already there of that name is not opened", async () => {
    // drafts already holds a.md; memo.md is renamed a.md in the list, so the
    // move into drafts clashes and the daemon refuses it.
    const clash: ContextEntry = { ...solo, nodes: [{ kind: "doc", rel: "a.md" }] };
    const { props, calls } = harness({ workspace: "/w/projects", entries: [clash, set] });
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await rightClick(buttonWith("a.md"));
    await click(menuItem("Move to"));
    await waitFor(() => options().length > 0, "the dialog");
    await click(option("drafts"));
    expect(calls.structure).toEqual([{ op: "move", path: "/w/notes/a.md", into: "/w/drafts" }]);
    // No success comes back: a fresh snapshot arrives, unchanged.
    await m.render(
      <div style={{ width: 300, height: 600, display: "flex" }}>
        <ContextSidebar {...props} entries={[clash, { ...set }]} />
      </div>,
    );
    await settle(() => {});
    expect(document.querySelector('[role="tree"]')).toBeNull();
    expect(document.activeElement?.getAttribute("role")).not.toBe("treeitem");
    await m.unmount();
  });

  test("a row from a set dropped on the list or on the way back moves to the workspace; a list row never does", async () => {
    const { props, calls } = harness({ workspace: "/w/projects" });
    const m = await mountSidebar(<ContextSidebar {...props} />);
    // The kit's one row payload (`rowDrag.ts`), as the tree and the list write it.
    const rows = (list: { entry: string; path: string; kind: DraggedRow["kind"] }[]) => {
      const data = encodeRowDrag(list);
      return {
        types: [ROW_DRAG_MIME],
        files: [],
        items: [],
        getData: (t: string) => (t === ROW_DRAG_MIME ? data : ""),
      };
    };
    const listEl = document.querySelector('[aria-label="Context"]') as Element;
    // A slip of the mouse on the list: a whole set, or a document listed from
    // elsewhere on disk, is never carried into the workspace.
    await drop(listEl, rows([{ entry: "c-set", path: "/w/drafts", kind: "set" }]));
    await drop(listEl, rows([{ entry: "c-solo", path: "/w/notes/memo.md", kind: "document" }]));
    expect(calls.structure).toEqual([]);
    // A row from inside a set, dropped on the list (the list opened under the drag).
    await drop(listEl, rows([{ entry: "c-set", path: "/w/drafts/a.md", kind: "document" }]));
    expect(calls.structure).toEqual([{ op: "move", path: "/w/drafts/a.md", into: "/w/projects" }]);
    // From inside the set: dropped on the way back.
    await click(buttonWith("drafts"));
    const back = document.querySelector('[aria-label="Back to the context list"]') as Element;
    await drop(
      back,
      rows([
        { entry: "c-set", path: "/w/drafts/a.md", kind: "document" },
        { entry: "c-set", path: "/w/drafts/part", kind: "folder" },
      ]),
    );
    expect(calls.structure.slice(1)).toEqual([
      { op: "move", path: "/w/drafts/a.md", into: "/w/projects" },
      { op: "move", path: "/w/drafts/part", into: "/w/projects" },
    ]);
    // Neither a set nor something already in the workspace moves from there.
    await drop(back, rows([{ entry: "c-set", path: "/w/drafts", kind: "set" }]));
    await drop(back, rows([{ entry: "c-set", path: "/w/projects/here.md", kind: "document" }]));
    expect(calls.structure).toHaveLength(3);
    await m.unmount();
  });

  test("a tree row's menu names the node: a document, then a folder, then the set's background", async () => {
    const { props, calls } = harness();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await click(buttonWith("drafts"));
    const row = (name: string) =>
      [...document.querySelectorAll('[role="treeitem"]')].find((e) =>
        (e.textContent ?? "").includes(name),
      ) ?? null;
    await rightClick(row("a.md"));
    await waitFor(() => menuItems().length > 0, "the menu");
    expect(menuItems()).toContain("Open");
    expect(menuItems()).not.toContain("New document");
    expect(calls.targets.at(-1)?.kind).toBe("doc");
    expect(calls.targets.at(-1)?.path).toBe("/w/drafts/a.md");
    await settle(() => {
      document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await rightClick(row("part"));
    await waitFor(() => menuItem("New document") !== null, "the folder menu");
    expect(calls.targets.at(-1)?.kind).toBe("group");
    await click(menuItem("New document"));
    expect(calls.structure.at(-1)).toEqual({ op: "doc.create", dir: "/w/drafts/part" });
    await m.unmount();
  });

  test("the app adds nothing when it returns nothing", async () => {
    const { props } = harness({ appActionsFor: () => [] });
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await rightClick(buttonWith("memo.md"));
    await waitFor(() => menuItems().length > 0, "the menu");
    expect(menuItems()).not.toContain("Render this");
    await m.unmount();
  });

  test("a destructive app action is drawn as one", async () => {
    const actions: MenuAction[] = [
      { id: "x", label: "Discard renders", onSelect: () => {}, destructive: true },
    ];
    const { props } = harness({ appActionsFor: () => actions });
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await rightClick(buttonWith("memo.md"));
    await waitFor(() => menuItem("Discard renders") !== null, "the menu");
    expect(menuItem("Discard renders")?.getAttribute("data-variant")).toBe("destructive");
    await m.unmount();
  });
});

describe("drag and drop from outside", () => {
  test("dropped documents are sent to the daemon as imports, text and all", async () => {
    const { props, calls } = harness();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    const list = document.querySelector('ul[aria-label="Context"]')?.parentElement as Element;
    await drop(list, transfer([file("scene.md", "# Scene\n")]));
    await waitFor(() => calls.structure.length > 0, "the import");
    expect(calls.structure).toEqual([{ op: "import", name: "scene.md", text: "# Scene\n" }]);
    await m.unmount();
  });

  test("a dropped folder is refused with a message that points at the picker", async () => {
    const { props, calls } = harness();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    const list = document.querySelector('ul[aria-label="Context"]')?.parentElement as Element;
    await drop(list, transfer([file("manuscript", "", true)]));
    await waitFor(() => !!document.querySelector('[role="alert"]'), "the notice");
    const notice = document.querySelector('[role="alert"]')?.textContent ?? "";
    expect(notice).toContain("manuscript");
    expect(notice).toContain("folder button");
    expect(notice).toContain("type its path");
    expect(calls.structure).toEqual([]);
    await m.unmount();
  });

  test("a file that is not a document is named and not sent", async () => {
    const { props, calls } = harness();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    const list = document.querySelector('ul[aria-label="Context"]')?.parentElement as Element;
    await drop(list, transfer([file("cover.png", "x"), file("ok.txt", "fine")]));
    await waitFor(() => calls.structure.length > 0, "the import");
    expect(calls.structure).toEqual([{ op: "import", name: "ok.txt", text: "fine" }]);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("cover.png");
    await m.unmount();
  });

  test("the notice can be dismissed", async () => {
    const { props } = harness();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    const list = document.querySelector('ul[aria-label="Context"]')?.parentElement as Element;
    await drop(list, transfer([file("cover.png", "x")]));
    await waitFor(() => !!document.querySelector('[role="alert"]'), "the notice");
    await click(document.querySelector('[role="alert"] button'));
    expect(document.querySelector('[role="alert"]')).toBeNull();
    await m.unmount();
  });
});

describe("adding a path", () => {
  const input = () => document.querySelector('input[data-slot="input"]') as HTMLInputElement;
  const type = (value: string) => typeInto(input(), value);
  const key = (k: string) =>
    settle(() => {
      input().dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true }));
    });

  test("typing a directory asks the daemon for its listing and offers completions", async () => {
    const { props, calls } = harness();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await type("/w/al");
    await waitFor(() => calls.listed.length > 0, "a listing");
    expect(calls.listed.at(-1)).toBe("/w");
    await waitFor(() => !!document.querySelector('[role="listbox"]'), "suggestions");
    // Only what matches the typed prefix.
    const names = [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent);
    expect(names).toEqual(["alpha/"]);
    // Tab completes it, keeping what was typed and adding the slash for a folder.
    await key("Tab");
    expect(input().value).toBe("/w/alpha/");
    await m.unmount();
  });

  test("the box is a combobox that says whether its list is open, and what it controls", async () => {
    const { props } = harness();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    expect(input().getAttribute("role")).toBe("combobox");
    expect(input().getAttribute("aria-expanded")).toBe("false");
    await type("/w/al");
    await waitFor(() => !!document.querySelector('[role="listbox"]'), "suggestions");
    expect(input().getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('[role="listbox"]')?.id).toBe(
      input().getAttribute("aria-controls") ?? undefined,
    );
    await m.unmount();
  });

  test("Enter adds the path, and the box empties", async () => {
    const { props, calls } = harness();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await type("/w/notes/memo.md");
    await key("Enter");
    expect(calls.added).toEqual(["/w/notes/memo.md"]);
    expect(input().value).toBe("");
    await m.unmount();
  });

  test("the picker buttons ask the daemon to open the OS picker", async () => {
    const { props, calls } = harness();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await click(document.querySelector('[aria-label="Choose documents with the file picker"]'));
    await click(document.querySelector('[aria-label="Choose a folder with the file picker"]'));
    expect(calls.picked).toEqual(["context-file", "context-folder"]);
    await m.unmount();
  });
});

describe("the list's own menu", () => {
  test("on the empty background it offers the pickers", async () => {
    const { props, calls } = harness({ entries: [] });
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await rightClick(document.querySelector('[data-slot="empty"]'));
    await waitFor(() => menuItem("Add documents") !== null, "the menu");
    await click(menuItem("Add documents"));
    expect(calls.picked).toEqual(["context-file"]);
    await m.unmount();
  });
});

describe("the workspace row", () => {
  const withWorkspace = (over: Partial<ContextSidebarProps> = {}) => {
    const set: string[] = [];
    const h = harness({
      workspace: "/w/projects/stories/series/the-lighthouse",
      onSetWorkspace: (p) => set.push(p),
      ...over,
    });
    return { ...h, set };
  };
  const rowTitle = () =>
    document.querySelector(
      '[title="/w/projects/stories/series/the-lighthouse"]',
    ) as HTMLElement | null;
  const boxes = () => document.querySelectorAll('input[data-slot="input"]');
  const workspaceBox = () =>
    document.querySelector('input[aria-label="Workspace folder"]') as HTMLInputElement;
  const keyIn = (box: HTMLInputElement, k: string) =>
    settle(() => {
      box.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true }));
    });

  test("shows the workspace shortened, with the whole path as its tooltip", async () => {
    const { props } = withWorkspace();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    expect(rowTitle()?.textContent).toContain("Workspace");
    expect(rowTitle()?.textContent).toContain("…/series/the-lighthouse");
    await m.unmount();
  });

  test("a session without one shows no row, and the drop hint is the old one", async () => {
    const { props } = harness();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    expect(document.body.textContent).not.toContain("Workspace");
    expect(document.body.textContent).toContain("Drop documents or images here to copy them in");
    await m.unmount();
  });

  test("the drop hint says where a drop lands", async () => {
    const { props } = withWorkspace();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    expect(document.body.textContent).toContain("copy them into the workspace");
    await m.unmount();
  });

  test("the pencil opens a folder path box with completion; Enter sets the workspace", async () => {
    const { props, set, calls } = withWorkspace();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    expect(boxes()).toHaveLength(1); // the add-a-path box
    await click(document.querySelector('[aria-label="Change the workspace folder"]'));
    expect(boxes()).toHaveLength(2);
    expect(workspaceBox().value).toBe("~/projects/stories/series/the-lighthouse");
    await typeInto(workspaceBox(), "/w/al");
    await waitFor(() => !!document.querySelector('[role="listbox"]'), "suggestions");
    expect(calls.listed).toContain("/w");
    // Folders only: alpha is offered, the file beta.md is not.
    expect(document.querySelector('[role="listbox"]')?.textContent).toContain("alpha");
    expect(document.querySelector('[role="listbox"]')?.textContent).not.toContain("beta.md");
    await typeInto(workspaceBox(), "/w/elsewhere");
    await keyIn(workspaceBox(), "Enter");
    expect(set).toEqual(["/w/elsewhere"]);
    expect(calls.added).toEqual([]);
    expect(boxes()).toHaveLength(1); // closed again
    await m.unmount();
  });

  test("Escape leaves the workspace as it was", async () => {
    const { props, set } = withWorkspace();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await click(document.querySelector('[aria-label="Change the workspace folder"]'));
    await keyIn(workspaceBox(), "Escape");
    expect(set).toEqual([]);
    expect(boxes()).toHaveLength(1);
    await m.unmount();
  });

  test("a dropped file is sent as an import: the daemon lands it in the workspace", async () => {
    const { props, calls } = withWorkspace();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    const list = document.querySelector('ul[aria-label="Context"]')?.parentElement as Element;
    await drop(list, transfer([file("scene.md", "# Scene\n")]));
    await waitFor(() => calls.structure.length === 1, "the import");
    expect(calls.structure).toEqual([{ op: "import", name: "scene.md", text: "# Scene\n" }]);
    await m.unmount();
  });
});

describe("New document and New set in the top row", () => {
  const WS = "/w/projects";
  const byLabel = (l: string) => document.querySelector(`[aria-label="${l}"]`);
  const inList = (over: Partial<ContextSidebarProps> = {}) =>
    harness({ workspace: WS, onSetWorkspace: () => {}, ...over });

  test("each creates in the workspace folder; a folder made there is a set, and says so", async () => {
    const { props, calls } = inList();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    expect(byLabel("New folder")).toBeNull();
    await click(byLabel("New document"));
    await click(byLabel("New set"));
    expect(calls.structure).toEqual([
      { op: "doc.create", dir: WS },
      { op: "folder.create", dir: WS },
    ]);
    await m.unmount();
  });

  test("they are there with nothing in the context yet", async () => {
    const { props, calls } = inList({ entries: [] });
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await click(byLabel("New document"));
    expect(calls.structure).toEqual([{ op: "doc.create", dir: WS }]);
    await m.unmount();
  });

  test("a new top-level document arrives in rename mode, as one made in a set does", async () => {
    const made: ContextEntry = {
      id: "c-new",
      label: "Untitled.md",
      root: WS,
      membership: "listed",
      nodes: [{ kind: "doc", rel: "Untitled.md" }],
    };
    const { props, calls } = inList({
      entries: [made],
      created: { path: `${WS}/Untitled.md`, seq: 1 },
    });
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await waitFor(
      () => !!document.querySelector('input[aria-label="Rename Untitled.md"]'),
      "the rename box",
    );
    const box = document.querySelector(
      'input[aria-label="Rename Untitled.md"]',
    ) as HTMLInputElement;
    await typeInto(box, "Chapter one.md");
    await settle(() => {
      box.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(calls.structure).toEqual([
      { op: "rename", path: `${WS}/Untitled.md`, name: "Chapter one.md" },
    ]);
    await m.unmount();
  });

  test("a new set arrives in rename mode too", async () => {
    const made: ContextEntry = {
      id: "c-new",
      label: "New set",
      root: `${WS}/New set`,
      membership: "mirrored",
      nodes: [],
    };
    const { props } = inList({
      entries: [made],
      created: { path: `${WS}/New set`, seq: 1 },
    });
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await waitFor(
      () => !!document.querySelector('input[aria-label="Rename New set"]'),
      "the rename box",
    );
    await m.unmount();
  });

  test("inside a drilled-in set the buttons create in that set, not the workspace", async () => {
    const { props, calls } = inList();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await click(buttonWith("drafts"));
    expect(byLabel("New document")).toBeNull(); // the set's own say "in this set"
    expect(byLabel("New set")).toBeNull(); // a folder made in a set is only a folder
    await click(document.querySelector('[aria-label="New document in this set"]'));
    await click(document.querySelector('[aria-label="New folder in this set"]'));
    expect(calls.structure).toEqual([
      { op: "doc.create", dir: "/w/drafts" },
      { op: "folder.create", dir: "/w/drafts" },
    ]);
    await m.unmount();
  });

  test("inside a set, a folder's menu and the tree's own say New folder, never New set", async () => {
    const { props, calls } = inList();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await click(buttonWith("drafts"));
    const treeRow = (name: string) =>
      [...document.querySelectorAll('[role="treeitem"]')].find((e) =>
        (e.textContent ?? "").includes(name),
      ) ?? null;
    await rightClick(treeRow("part"));
    await waitFor(() => menuItems().length > 0, "the folder's menu");
    expect(menuItems()).toContain("New folder");
    expect(menuItems()).not.toContain("New set");
    await click(menuItem("New folder"));
    expect(calls.structure).toEqual([{ op: "folder.create", dir: "/w/drafts/part" }]);
    await m.unmount();
  });

  test("a session without a workspace has no top-row buttons", async () => {
    const { props } = harness();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    expect(byLabel("New document")).toBeNull();
    await m.unmount();
  });
});

describe("a drop onto a set", () => {
  async function dragOver(target: Element, dt: object) {
    await settle(() => {
      const ev = new window.Event("dragover", { bubbles: true, cancelable: true });
      Object.defineProperty(ev, "dataTransfer", { value: dt });
      target.dispatchEvent(ev);
    });
  }

  test("a drop on a set's row in the list lands in that set", async () => {
    const { props, calls } = harness({ workspace: "/w/projects" });
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await drop(buttonWith("drafts") as Element, transfer([file("scene.md", "# Scene\n")]));
    await waitFor(() => calls.structure.length > 0, "the import");
    expect(calls.structure).toEqual([
      { op: "import", name: "scene.md", text: "# Scene\n", dir: "/w/drafts" },
    ]);
    await m.unmount();
  });

  test("a drop on a drilled-in set's tree imports once, into that set", async () => {
    const { props, calls } = harness({ workspace: "/w/projects" });
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await click(buttonWith("drafts"));
    const tree = document.querySelector('[role="tree"]') as Element;
    const dt = transfer([file("scene.md", "# Scene\n")]);
    await dragOver(tree, dt);
    await drop(tree, dt);
    await waitFor(() => calls.structure.length > 0, "the import");
    await settle(() => {});
    expect(calls.structure).toEqual([
      { op: "import", name: "scene.md", text: "# Scene\n", dir: "/w/drafts" },
    ]);
    await m.unmount();
  });

  test("a drop on the empty space under a set's tree imports once, into that set", async () => {
    const { props, calls } = harness({ workspace: "/w/projects" });
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await click(buttonWith("drafts"));
    const tree = document.querySelector('[role="tree"]') as Element;
    const below = tree.parentElement?.lastElementChild as Element;
    await drop(below, transfer([file("scene.md", "# Scene\n")]));
    await waitFor(() => calls.structure.length > 0, "the import");
    await settle(() => {});
    expect(calls.structure).toEqual([
      { op: "import", name: "scene.md", text: "# Scene\n", dir: "/w/drafts" },
    ]);
    await m.unmount();
  });

  test("a drop on a row, then a drop below the rows, imports both", async () => {
    const { props, calls } = harness({ workspace: "/w/projects" });
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await click(buttonWith("drafts"));
    const tree = document.querySelector('[role="tree"]') as Element;
    const row = document.querySelector('[role="treeitem"]') as Element;
    const dt = transfer([file("one.md", "1")]);
    await dragOver(row, dt);
    await drop(row, dt);
    await waitFor(() => calls.structure.length === 1, "the row drop");
    // Let the drop's own turn end: nothing may linger to swallow the next one.
    await new Promise((r) => setTimeout(r, 10));
    const below = tree.parentElement?.lastElementChild as Element;
    await drop(below, transfer([file("two.md", "2")]));
    await waitFor(() => calls.structure.length === 2, "the background drop");
    expect(calls.structure.map((o) => (o.op === "import" ? o.name : o.op))).toEqual([
      "one.md",
      "two.md",
    ]);
    await m.unmount();
  });
});
