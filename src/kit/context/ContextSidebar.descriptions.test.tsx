// Image descriptions in the sidebar (the kit-image-descriptions item): a set
// folds each image's sidecar into the image's row, with a mark, and counts it
// as part of the image; "Edit description" opens the sidecar, and an image with
// none offers "Ask the agent to describe". An orphan sidecar is a document row.
// A loose image's sidecar, listed beside it, folds the same way.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { cleanup, installDom, mount, removeDom, settle, waitFor } from "../lib/testDom.ts";
import type { ContextEntry } from "../workspace/protocol";
import { ContextSidebar, type ContextSidebarProps } from "./ContextSidebar.tsx";

beforeAll(installDom);
afterEach(cleanup);
// Awaited: the next file's installDom is a no-op while the DOM is still registered.
afterAll(async () => {
  await removeDom();
});

const set: ContextEntry = {
  id: "c-set",
  label: "world",
  root: "/w/world",
  membership: "mirrored",
  nodes: [
    { kind: "doc", rel: "story.md" },
    { kind: "image", rel: "fox.png" },
    { kind: "doc", rel: "fox.png.md", sidecar: true },
    { kind: "image", rel: "plain.png" },
    // An orphan: its image is gone.
    { kind: "doc", rel: "ghost.png.md" },
  ],
};
const loose: ContextEntry = {
  id: "c-loose",
  label: "moth.jpg",
  root: "/w/loose",
  membership: "listed",
  nodes: [{ kind: "image", rel: "moth.jpg" }],
};
const looseMd: ContextEntry = {
  id: "c-loose-md",
  label: "moth.jpg.md",
  root: "/w/loose",
  membership: "listed",
  nodes: [{ kind: "doc", rel: "moth.jpg.md", sidecar: true }],
};

function harness(over: Partial<ContextSidebarProps> = {}) {
  const opened: string[] = [];
  const asked: string[] = [];
  const props: ContextSidebarProps = {
    entries: [set, loose, looseMd],
    activeDoc: null,
    userHome: "/w",
    onOpenDoc: (entry, rel) => opened.push(`${entry.root}/${rel}`),
    onAddPath: () => {},
    onStructure: () => {},
    onRemoveEntry: () => {},
    onReveal: () => {},
    onPick: () => {},
    listDir: async () => ({ entries: [] }),
    onAskDescribe: (path) => asked.push(path),
    ...over,
  };
  return { opened, asked, props };
}

const mountSidebar = (node: ReactNode) =>
  mount(<div style={{ width: 300, height: 600, display: "flex" }}>{node}</div>);
const buttonWith = (text: string) =>
  [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(text)) ??
  null;
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
const treeRows = () =>
  [...document.querySelectorAll('[role="treeitem"]')].map((e) => e.textContent ?? "");
const treeRow = (name: string) =>
  [...document.querySelectorAll('[role="treeitem"]')].find((e) =>
    (e.textContent ?? "").startsWith(name),
  ) ?? null;

describe("a set's tree", () => {
  test("folds a sidecar into its image's row, with a mark; an orphan stays a document", async () => {
    const { props } = harness();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    // The counts: story.md and the orphan are documents; fox's description is not one.
    const counts = document.querySelector("[data-slot=set-counts]");
    expect(counts?.getAttribute("title")).toBe("2 documents, 2 images");
    await click(buttonWith("world"));
    await waitFor(() => treeRow("story.md") !== null, "the tree");
    const rows = treeRows();
    expect(rows.some((r) => r.startsWith("fox.png.md"))).toBe(false);
    expect(rows.some((r) => r.startsWith("ghost.png.md"))).toBe(true);
    expect(treeRow("fox.png")?.querySelector("[data-slot=described-mark]")).not.toBeNull();
    expect(treeRow("plain.png")?.querySelector("[data-slot=described-mark]")).toBeNull();
    await m.unmount();
  });

  test("the description open as a document marks its image's row", async () => {
    const { props } = harness();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    // Opened from elsewhere (search, the viewer's Edit): the list drills to it.
    await m.render(
      <div style={{ width: 300, height: 600, display: "flex" }}>
        <ContextSidebar {...props} activeDoc={{ entryId: "c-set", rel: "fox.png.md" }} />
      </div>,
    );
    await waitFor(() => treeRow("fox.png") !== null, "the tree, drilled to the open document");
    expect(treeRow("fox.png")?.getAttribute("data-active")).toBe("true");
    await m.unmount();
  });

  test("Edit description opens the sidecar; with none, Ask the agent to describe posts", async () => {
    const { props, opened, asked } = harness();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await click(buttonWith("world"));
    await waitFor(() => treeRow("fox.png") !== null, "the tree");
    await rightClick(treeRow("fox.png"));
    await waitFor(menuOpen, "the menu");
    expect(menuItem("Ask the agent to describe")).toBeNull();
    await click(menuItem("Edit description"));
    expect(opened).toEqual(["/w/world/fox.png.md"]);
    await waitFor(() => !menuOpen(), "the menu closed");
    await rightClick(treeRow("plain.png"));
    await waitFor(menuOpen, "the menu");
    expect(menuItem("Edit description")).toBeNull();
    await click(menuItem("Ask the agent to describe"));
    expect(asked).toEqual(["/w/world/plain.png"]);
    await m.unmount();
  });
});

describe("the list", () => {
  test("a loose image's listed sidecar folds into the image's row", async () => {
    const { props, opened } = harness();
    const m = await mountSidebar(<ContextSidebar {...props} />);
    const list = document.querySelector('[aria-label="Context"]');
    const names = [...(list?.querySelectorAll("li") ?? [])].map((li) => li.textContent ?? "");
    expect(names.some((n) => n.startsWith("moth.jpg.md"))).toBe(false);
    const row = [...(list?.querySelectorAll("li button") ?? [])].find((b) =>
      (b.textContent ?? "").startsWith("moth.jpg"),
    );
    expect(row?.querySelector("[data-slot=described-mark]")).not.toBeNull();
    await rightClick(row ?? null);
    await waitFor(menuOpen, "the menu");
    await click(menuItem("Edit description"));
    expect(opened).toEqual(["/w/loose/moth.jpg.md"]);
    await m.unmount();
  });

  test("without onAskDescribe, an image with no description offers no ask", async () => {
    const { props } = harness({ onAskDescribe: undefined });
    const m = await mountSidebar(<ContextSidebar {...props} />);
    await click(buttonWith("world"));
    await waitFor(() => treeRow("plain.png") !== null, "the tree");
    await rightClick(treeRow("plain.png"));
    await waitFor(menuOpen, "the menu");
    expect(menuItem("Ask the agent to describe")).toBeNull();
    expect(menuItem("Edit description")).toBeNull();
    await m.unmount();
  });
});
