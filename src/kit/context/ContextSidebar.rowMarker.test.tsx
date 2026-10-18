// The row-marker slot: an app's mark at the trailing edge of any tree row, open
// or not, asked by the row's own path (a bundle's folder, not its main file),
// after the row's badge. Without it, rows are what the badge slot alone makes.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { type BundleType, registerBundleType, unregisterBundleType } from "../lib/bundles.ts";
import { cleanup, installDom, mount, removeDom, settle } from "../lib/testDom.ts";
import type { ContextEntry } from "../workspace/protocol";
import { ContextSidebar, type ContextSidebarProps, withRowMarker } from "./ContextSidebar.tsx";

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

const solo: ContextEntry = {
  id: "c-solo",
  label: "memo.md",
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
    { kind: "doc", rel: "b.md" },
    { kind: "image", rel: "fox.png" },
    { kind: "group", rel: "part", children: [{ kind: "doc", rel: "part/c.md" }] },
    { kind: "bundle", rel: "well.boardbundle", type: "board", main: "board.board" },
  ],
};

function props(over: Partial<ContextSidebarProps> = {}): ContextSidebarProps {
  return {
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
    ...over,
  };
}

const mountSidebar = (node: ReactNode) =>
  mount(<div style={{ width: 300, height: 600, display: "flex" }}>{node}</div>);
const click = async (el: Element | null | undefined) => {
  if (!el) throw new Error("nothing to click");
  await settle(() => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};
const listButton = (name: string) =>
  [...document.querySelectorAll('ul[aria-label="Context"] button')].find((b) =>
    (b.textContent ?? "").includes(name),
  );
const treeRow = (name: string) =>
  [...document.querySelectorAll('[role="treeitem"]')].find((e) =>
    (e.textContent ?? "").includes(name),
  );
/** The page's markup, with React's per-mount ids made one. */
const markup = () => document.body.innerHTML.replace(/_r_[0-9a-z]+_/g, "_r_");
/** The list's and the drilled set's markup, the two views a row shows in. */
async function bothViews(p: ContextSidebarProps) {
  const m = await mountSidebar(<ContextSidebar {...p} />);
  const list = markup();
  await click(listButton("drafts"));
  const tree = markup();
  await m.unmount();
  return { list, tree };
}

const BADGE = (path: string) =>
  path === "/w/drafts/a.md" || path === "/w/notes/memo.md" ? <b data-testid="badge">B</b> : null;
const MARK = (path: string) => <i data-testid="mark" data-path={path} />;

describe("without a row marker", () => {
  test("rows are what the badge slot alone makes, as when a marker marks nothing", async () => {
    const without = await bothViews(props({ badgeFor: BADGE }));
    const nothing = await bothViews(props({ badgeFor: BADGE, rowMarker: () => null }));
    expect(nothing).toEqual(without);
    // The badge sits in the row's own trailing span, not wrapped with a mark.
    const m = await mountSidebar(<ContextSidebar {...props({ badgeFor: BADGE })} />);
    const memo = listButton("memo.md")?.querySelector('[data-testid="badge"]');
    expect(memo?.parentElement?.className).toBe("flex shrink-0 items-center");
    expect(document.querySelector('[data-testid="mark"]')).toBeNull();
    await m.unmount();
  });
});

describe("with a row marker", () => {
  test("each document, image and bundle row is asked by its own path, folders and files never", async () => {
    const asked = new Set<string>();
    const m = await mountSidebar(
      <ContextSidebar
        {...props({
          rowMarker: (path) => {
            asked.add(path);
            return MARK(path);
          },
        })}
      />,
    );
    // The list: a single document's row carries its mark; a set's row is a folder's.
    expect(listButton("memo.md")?.querySelector('[data-testid="mark"]')).not.toBeNull();
    expect(listButton("drafts")?.querySelector('[data-testid="mark"]')).toBeNull();
    await click(listButton("drafts"));
    const markOf = (name: string) =>
      treeRow(name)?.querySelector('[data-testid="mark"]')?.getAttribute("data-path") ?? null;
    expect(markOf("a.md")).toBe("/w/drafts/a.md");
    expect(markOf("fox.png")).toBe("/w/drafts/fox.png");
    // A bundle's row by its folder, not by the main file it opens.
    expect(markOf("well")).toBe("/w/drafts/well.boardbundle");
    expect(markOf("part")).toBeNull();
    expect([...asked].sort()).toEqual([
      "/w/drafts/a.md",
      "/w/drafts/b.md",
      "/w/drafts/fox.png",
      "/w/drafts/well.boardbundle",
      "/w/notes/memo.md",
    ]);
    await m.unmount();
  });

  test("the mark follows the row's badge, and stands alone where there is none", async () => {
    const m = await mountSidebar(
      <ContextSidebar {...props({ badgeFor: BADGE, rowMarker: MARK })} />,
    );
    await click(listButton("drafts"));
    const a = treeRow("a.md");
    const both = a?.querySelector('[data-testid="badge"]')?.parentElement;
    expect(both?.querySelector('[data-testid="mark"]')).not.toBeNull();
    expect([...(both?.children ?? [])].map((c) => c.getAttribute("data-testid"))).toEqual([
      "badge",
      "mark",
    ]);
    const b = treeRow("b.md");
    expect(b?.querySelector('[data-testid="badge"]')).toBeNull();
    expect(b?.querySelector('[data-testid="mark"]')?.parentElement?.className).toContain("ml-auto");
    await m.unmount();
  });
});

describe("withRowMarker", () => {
  test("a bundle's main file asks the badge by the file and the mark by the folder", () => {
    const badgeAsked: string[] = [];
    const markAsked: string[] = [];
    const f = withRowMarker(
      (p) => {
        badgeAsked.push(p);
        return null;
      },
      (p) => {
        markAsked.push(p);
        return null;
      },
    );
    expect(f("/w/drafts/well.boardbundle/board.board")).toBeNull();
    expect(f("/w/drafts/a.md")).toBeNull();
    expect(badgeAsked).toEqual(["/w/drafts/well.boardbundle/board.board", "/w/drafts/a.md"]);
    expect(markAsked).toEqual(["/w/drafts/well.boardbundle", "/w/drafts/a.md"]);
  });
});
