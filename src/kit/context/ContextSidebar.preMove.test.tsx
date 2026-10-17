// The pre-move slot (`./preMove.ts`): an app may answer a move with a dialog,
// and the move waits for the human. Driven from fixtures, as the sidebar's
// other tests are; the same gestures with no slot must send at once.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { cleanup, installDom, mount, removeDom, settle, waitFor } from "../lib/testDom.ts";
import type { ContextEntry, StructureOp } from "../workspace/protocol";
import { ContextSidebar, type ContextSidebarProps } from "./ContextSidebar.tsx";
import type { BeforeMove, PendingMove } from "./preMove.ts";
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
const drafts: ContextEntry = {
  id: "c-drafts",
  label: "drafts",
  root: "/w/drafts",
  membership: "mirrored",
  nodes: [
    { kind: "doc", rel: "a.md" },
    { kind: "doc", rel: "b.md" },
  ],
};
const ideas: ContextEntry = {
  id: "c-ideas",
  label: "ideas",
  root: "/w/ideas",
  membership: "mirrored",
  nodes: [{ kind: "doc", rel: "c.md" }],
};

function harness(over: Partial<ContextSidebarProps> = {}) {
  const structure: StructureOp[] = [];
  const props: ContextSidebarProps = {
    entries: [solo, drafts, ideas],
    activeDoc: null,
    userHome: "/w",
    workspace: "/w/projects",
    onOpenDoc: () => {},
    onAddPath: () => {},
    onStructure: (op) => structure.push(op),
    onRemoveEntry: () => {},
    onReveal: () => {},
    onPick: () => {},
    listDir: async () => ({ entries: [] }),
    ...over,
  };
  return { structure, props };
}

const mountSidebar = (node: ReactNode) =>
  mount(<div style={{ width: 300, height: 600, display: "flex" }}>{node}</div>);
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
const menuItem = (text: string) =>
  [...document.querySelectorAll('[role^="menuitem"]')].find((e) =>
    (e.textContent ?? "").includes(text),
  ) ?? null;
const option = (text: string) =>
  [...document.querySelectorAll('[data-slot="move-to-dialog"] [role="option"]')].find(
    (e) => (e.textContent ?? "").trim() === text,
  ) ?? null;
const dialog = () => document.querySelector<HTMLElement>('[data-slot="confirm-dialog"]');
const notice = () => document.querySelector('[role="alert"]')?.textContent ?? "";

/**
 * "Move to…" from a row's menu, choosing `into` in the dialog. `during` runs
 * straight after the choosing click is dispatched, before anything is awaited.
 */
async function moveTo(row: string, into: string, during: () => void = () => {}) {
  await rightClick(buttonWith(row));
  await waitFor(() => menuItem("Move to") !== null, "the menu");
  await click(menuItem("Move to"));
  await waitFor(() => option(into) !== null, "the Move to dialog");
  const el = option(into) as Element;
  await settle(() => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    during();
  });
}

/** Sidebar rows dropped onto `target`, in the kit's own row payload; `during` as for `moveTo`. */
async function dropRows(target: Element, rows: DraggedRow[], during: () => void = () => {}) {
  const data = encodeRowDrag(rows);
  const dt = {
    types: [ROW_DRAG_MIME],
    files: [],
    items: [],
    getData: (t: string) => (t === ROW_DRAG_MIME ? data : ""),
  };
  await settle(() => {
    const ev = new window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "dataTransfer", { value: dt });
    target.dispatchEvent(ev);
    during();
  });
}

const plan = (asked: PendingMove[]): BeforeMove => {
  return (m) => {
    asked.push(m);
    return { title: `Move ${m.path} into ${m.into}?`, message: "It breaks 2 links." };
  };
};

describe("with no slot, nothing changes", () => {
  test("Move to… and a drag each send the move at once, in the same act, with no dialog", async () => {
    const { props, structure } = harness();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    // Sent inside the click itself, before anything is awaited: not a microtask later.
    let atOnce: StructureOp[] = [];
    await moveTo("memo.md", "drafts", () => {
      atOnce = [...structure];
    });
    expect(atOnce).toEqual([{ op: "move", path: "/w/notes/memo.md", into: "/w/drafts" }]);
    expect(structure).toEqual(atOnce);
    await dropRows(
      buttonWith("ideas") as Element,
      [
        { entry: "c-drafts", path: "/w/drafts/a.md", kind: "document" },
        { entry: "c-drafts", path: "/w/drafts/b.md", kind: "document" },
      ],
      () => {
        atOnce = [...structure];
      },
    );
    expect(atOnce).toHaveLength(3);
    expect(structure.slice(1)).toEqual([
      { op: "move", path: "/w/drafts/a.md", into: "/w/ideas" },
      { op: "move", path: "/w/drafts/b.md", into: "/w/ideas" },
    ]);
    expect(dialog()).toBeNull();
    await m.unmount();
  });
});

describe("with a slot, the move waits for the human", () => {
  test("Move to…: the app is asked with the move, its words are shown, and Move sends it", async () => {
    const asked: PendingMove[] = [];
    const { props, structure } = harness({ beforeMove: plan(asked) });
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await moveTo("memo.md", "drafts");
    await waitFor(() => dialog() !== null, "the slot's dialog");
    expect(asked).toEqual([{ path: "/w/notes/memo.md", into: "/w/drafts" }]);
    expect(dialog()?.textContent).toContain("Move /w/notes/memo.md into /w/drafts?");
    expect(dialog()?.textContent).toContain("It breaks 2 links.");
    expect(structure).toEqual([]);
    await click(buttonWith("Confirm", dialog() as ParentNode));
    await waitFor(() => structure.length === 1, "the move");
    expect(structure).toEqual([{ op: "move", path: "/w/notes/memo.md", into: "/w/drafts" }]);
    await waitFor(() => dialog() === null, "the dialog to close");
    await m.unmount();
  });

  test("Cancel sends nothing", async () => {
    const { props, structure } = harness({ beforeMove: plan([]) });
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await moveTo("memo.md", "drafts");
    await waitFor(() => dialog() !== null, "the slot's dialog");
    await click(buttonWith("Cancel", dialog() as ParentNode));
    await waitFor(() => dialog() === null, "the dialog to close");
    await settle(() => {});
    expect(structure).toEqual([]);
    await m.unmount();
  });

  test("a drag of two rows asks about each in turn, and sends only what was confirmed, in order", async () => {
    const asked: PendingMove[] = [];
    const { props, structure } = harness({ beforeMove: plan(asked) });
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await dropRows(buttonWith("ideas") as Element, [
      { entry: "c-drafts", path: "/w/drafts/a.md", kind: "document" },
      { entry: "c-drafts", path: "/w/drafts/b.md", kind: "document" },
    ]);
    await waitFor(() => dialog() !== null, "the first question");
    // One at a time: the second is not asked while the first is open.
    expect(asked).toEqual([{ path: "/w/drafts/a.md", into: "/w/ideas" }]);
    await click(buttonWith("Cancel", dialog() as ParentNode));
    await waitFor(
      () => dialog()?.textContent?.includes("/w/drafts/b.md") === true,
      "the second question",
    );
    await click(buttonWith("Confirm", dialog() as ParentNode));
    await waitFor(() => structure.length === 1, "the confirmed move");
    expect(structure).toEqual([{ op: "move", path: "/w/drafts/b.md", into: "/w/ideas" }]);
    await m.unmount();
  });

  test("a drop on the list (to the workspace) goes through it too", async () => {
    const asked: PendingMove[] = [];
    const { props, structure } = harness({ beforeMove: plan(asked) });
    const m = await mountSidebar(<ContextSidebar {...props} />);
    const list = document.querySelector('[aria-label="Context"]') as Element;
    await dropRows(list, [{ entry: "c-drafts", path: "/w/drafts/a.md", kind: "document" }]);
    await waitFor(() => dialog() !== null, "the slot's dialog");
    expect(asked).toEqual([{ path: "/w/drafts/a.md", into: "/w/projects" }]);
    await click(buttonWith("Confirm", dialog() as ParentNode));
    await waitFor(() => structure.length === 1, "the move");
    await m.unmount();
  });

  test("an app with nothing to say moves at once; a refusal is the notice and sends nothing", async () => {
    let answer: "nothing" | "refuse" = "nothing";
    const { props, structure } = harness({
      beforeMove: () => (answer === "nothing" ? null : { refused: "a.md is already there" }),
    });
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await moveTo("memo.md", "drafts");
    await waitFor(() => structure.length === 1, "the move");
    expect(dialog()).toBeNull();
    answer = "refuse";
    await moveTo("memo.md", "ideas");
    await waitFor(() => notice().includes("a.md is already there"), "the notice");
    expect(dialog()).toBeNull();
    expect(structure).toHaveLength(1);
    await m.unmount();
  });
});

describe("a check that fails or never answers still lets the human choose", () => {
  test("a failed check asks with the reason, and Move anyway sends the move", async () => {
    const { props, structure } = harness({
      beforeMove: async () => {
        throw new Error("the session has ended");
      },
    });
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await moveTo("memo.md", "drafts");
    await waitFor(() => dialog() !== null, "the unchecked question");
    const text = dialog()?.textContent ?? "";
    expect(text).toContain("Move “memo.md” into “drafts”?");
    expect(text).toContain("could not be checked first (the session has ended)");
    expect(structure).toEqual([]);
    await click(buttonWith("Move anyway", dialog() as ParentNode));
    await waitFor(() => structure.length === 1, "the move");
    await m.unmount();
  });

  test("a check that never answers is asked without it after the timeout; Cancel sends nothing, and a late answer is ignored", async () => {
    let late: ((a: null) => void) | null = null;
    const { props, structure } = harness({
      beforeMove: () =>
        new Promise((resolve) => {
          late = resolve;
        }),
      beforeMoveTimeoutMs: 40,
    });
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await moveTo("memo.md", "drafts");
    await waitFor(() => dialog() !== null, "the unchecked question");
    expect(dialog()?.textContent).toContain("no answer within");
    await click(buttonWith("Cancel", dialog() as ParentNode));
    await waitFor(() => dialog() === null, "the dialog to close");
    await settle(() => (late as ((a: null) => void) | null)?.(null));
    await settle(() => {});
    expect(structure).toEqual([]);
    await m.unmount();
  });
});

describe("a drag inside one set's tree (headless-tree's own drag state)", () => {
  const nested: ContextEntry = {
    id: "c-nested",
    label: "nested",
    root: "/w/nested",
    membership: "mirrored",
    nodes: [
      { kind: "group", rel: "sub", children: [{ kind: "doc", rel: "sub/b.md" }] },
      { kind: "doc", rel: "a.md" },
    ],
  };
  const treeRow = (name: string) =>
    [...document.querySelectorAll('[role="treeitem"]')].find((e) =>
      (e.textContent ?? "").trim().startsWith(name),
    ) ?? null;
  /** A DataTransfer the library can write its drag into and read it back from. */
  function dataTransfer() {
    const store = new Map<string, string>();
    return {
      dropEffect: "move",
      effectAllowed: "move",
      types: [] as string[],
      files: [],
      items: [],
      setData(t: string, v: string) {
        store.set(t, v);
        this.types.push(t);
      },
      getData: (t: string) => store.get(t) ?? "",
      setDragImage() {},
    };
  }
  async function fire(el: Element, type: string, dt: unknown) {
    await settle(() => {
      const ev = new window.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(ev, "dataTransfer", { value: dt });
      Object.defineProperty(ev, "clientX", { value: 5 });
      Object.defineProperty(ev, "clientY", { value: 5 });
      el.dispatchEvent(ev);
    });
  }
  async function dragIntoSub(over: Partial<ContextSidebarProps>) {
    const h = harness({ entries: [nested], ...over });
    const m = await mountSidebar(<ContextSidebar {...h.props} />);
    await click(buttonWith("nested"));
    await waitFor(() => treeRow("a.md") !== null && treeRow("sub") !== null, "the tree");
    const dt = dataTransfer();
    await fire(treeRow("a.md") as Element, "dragstart", dt);
    await fire(treeRow("sub") as Element, "dragover", dt);
    await fire(treeRow("sub") as Element, "drop", dt);
    return { ...h, m };
  }

  test("with no slot, the drop moves the row into the folder at once", async () => {
    const { structure, m } = await dragIntoSub({});
    await waitFor(() => structure.length > 0, "the move");
    expect(structure).toEqual([{ op: "move", path: "/w/nested/a.md", into: "/w/nested/sub" }]);
    await m.unmount();
  });

  test("with a slot, it is asked with the move, and nothing is sent until the human answers", async () => {
    const asked: PendingMove[] = [];
    const { structure, m } = await dragIntoSub({ beforeMove: plan(asked) });
    await waitFor(() => dialog() !== null, "the slot's dialog");
    expect(asked).toEqual([{ path: "/w/nested/a.md", into: "/w/nested/sub" }]);
    await Bun.sleep(50);
    expect(structure).toEqual([]);
    await click(buttonWith("Confirm", dialog() as ParentNode));
    await waitFor(() => structure.length === 1, "the move");
    expect(structure).toEqual([{ op: "move", path: "/w/nested/a.md", into: "/w/nested/sub" }]);
    await m.unmount();
  });
});

describe("a cancelled Move to… expects nothing", () => {
  test("the daemon later reporting a move to that same place (the agent's) does not take the view there", async () => {
    const { props } = harness({ beforeMove: plan([]) });
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await moveTo("memo.md", "drafts");
    await waitFor(() => dialog() !== null, "the slot's dialog");
    await click(buttonWith("Cancel", dialog() as ParentNode));
    await waitFor(() => dialog() === null, "the dialog to close");
    // Later the agent moves memo.md into drafts, and the daemon reports it.
    const after: ContextEntry = {
      ...drafts,
      nodes: [...drafts.nodes, { kind: "doc", rel: "memo.md" }],
    };
    await m.render(
      <div style={{ width: 300, height: 600, display: "flex" }}>
        <ContextSidebar
          {...props}
          entries={[after, ideas]}
          moved={{ path: "/w/drafts/memo.md", seq: 1 }}
        />
      </div>,
    );
    await Bun.sleep(50);
    await settle(() => {});
    // Still the list: the human's view was not carried into drafts.
    expect(document.querySelector('[role="tree"]')).toBeNull();
    await m.unmount();
  });
});
