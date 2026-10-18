// Delete in the sidebar, from fixtures: a row's menu offers Move to Trash for a
// document or folder in a set and for a single listed document, never for a whole
// set; the dialog names what goes from the preview; only a confirm sends it; a
// refusal is shown. Without the two props, nothing is offered.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { cleanup, installDom, mount, removeDom, settle, waitFor } from "../lib/testDom.ts";
import type { ContextEntry, TrashPreview } from "../workspace/protocol";
import { ContextSidebar, type ContextSidebarProps } from "./ContextSidebar.tsx";

beforeAll(installDom);
afterEach(cleanup);
// Awaited: the next file's installDom is a no-op while the DOM is still registered.
afterAll(async () => {
  await removeDom();
});

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

const preview = (path: string, over: Partial<TrashPreview> = {}): TrashPreview => ({
  path,
  shown: path.replace("/w/", ""),
  dir: false,
  files: 1,
  folders: 0,
  docs: [],
  ...over,
});

function harness(over: Partial<ContextSidebarProps> = {}) {
  const asked: string[] = [];
  const trashed: string[] = [];
  const props: ContextSidebarProps = {
    entries: [solo, set],
    activeDoc: null,
    userHome: "/w",
    onOpenDoc: () => {},
    onAddPath: () => {},
    onStructure: () => {},
    onRemoveEntry: () => {},
    onReveal: () => {},
    onPick: () => {},
    listDir: async () => ({ entries: [] }),
    trashPreview: async (path) => {
      asked.push(path);
      return path === "/w/drafts/part"
        ? preview(path, {
            dir: true,
            files: 4,
            folders: 1,
            docs: [{ slug: "b", name: "b.md", unsaved: true, versions: 2, open: true }],
          })
        : preview(path);
    },
    onTrash: (path) => trashed.push(path),
    ...over,
  };
  return { asked, trashed, props };
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
const menuOpen = () => document.querySelector('[role^="menuitem"]') !== null;
const dialog = () => document.querySelector("[data-slot=confirm-dialog]");
const treeRow = (name: string) =>
  [...document.querySelectorAll('[role="treeitem"]')].find((e) =>
    (e.textContent ?? "").includes(name),
  ) ?? null;

async function drillIn() {
  await click(buttonWith("drafts"));
  await waitFor(() => treeRow("a.md") !== null, "the set's tree");
}

describe("Delete in the sidebar", () => {
  test("a folder in a set: the dialog counts its files and warns, and Move to Trash sends it", async () => {
    const { props, asked, trashed } = harness();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await drillIn();
    await rightClick(treeRow("part"));
    await waitFor(menuOpen, "the menu");
    await click(menuItem("Move to Trash"));
    await waitFor(() => dialog() !== null, "the dialog");
    expect(asked).toEqual(["/w/drafts/part"]);
    const text = dialog()?.textContent ?? "";
    expect(text).toContain("Move part to the Trash?");
    expect(text).toContain("It holds 4 files in 1 folder.");
    expect(text).toContain("b.md has unsaved edits");
    expect(text).toContain("b.md has 2 versions in this session");
    expect(text).toContain("b.md is open, and closes.");
    expect(trashed).toEqual([]);
    await click(buttonWith("Move to Trash", dialog() as ParentNode));
    expect(trashed).toEqual(["/w/drafts/part"]);
    await m.unmount();
  });

  test("Cancel sends nothing", async () => {
    const { props, trashed } = harness();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await drillIn();
    await rightClick(treeRow("a.md"));
    await waitFor(menuOpen, "the menu");
    await click(menuItem("Move to Trash"));
    await waitFor(() => dialog() !== null, "the dialog");
    expect(dialog()?.textContent).toContain("drafts/a.md goes to the Trash.");
    await click(buttonWith("Cancel", dialog() as ParentNode));
    await waitFor(() => dialog() === null, "the dialog closed");
    expect(trashed).toEqual([]);
    await m.unmount();
  });

  test("a single listed document offers it; a whole set does not", async () => {
    const { props } = harness();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await rightClick(buttonWith("memo.md"));
    await waitFor(menuOpen, "the menu");
    expect(menuItem("Move to Trash")).not.toBeNull();
    await settle(() => {
      document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
    });
    await rightClick(buttonWith("drafts"));
    await waitFor(() => menuItem("Open set") !== null, "the set's menu");
    expect(menuItem("Move to Trash")).toBeNull();
    await m.unmount();
  });

  test("a refusal from the preview is shown, and no dialog opens", async () => {
    const { props, trashed } = harness({
      trashPreview: async () => {
        throw new Error("the disk is read-only");
      },
    });
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await drillIn();
    await rightClick(treeRow("a.md"));
    await waitFor(menuOpen, "the menu");
    await click(menuItem("Move to Trash"));
    await waitFor(
      () => document.querySelector('[role="alert"]')?.textContent?.includes("read-only") === true,
      "the notice",
    );
    expect(dialog()).toBeNull();
    expect(trashed).toEqual([]);
    await m.unmount();
  });

  test("without the trash props, no row offers it", async () => {
    const { props } = harness({ trashPreview: undefined, onTrash: undefined });
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await drillIn();
    await rightClick(treeRow("a.md"));
    await waitFor(menuOpen, "the menu");
    expect(menuItem("Move to Trash")).toBeNull();
    await m.unmount();
  });
});
